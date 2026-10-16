import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, type GenerateContentParameters } from '@google/genai';
import {
  CATALOG_PRODUCTS,
  DEFAULT_NEARBY_EVENTS,
  getUpcomingDefaultEvents,
  getOutfitMockupImageForEvent,
  matchPersonEditorialEnsemble,
  resolveGenderForProduct,
  PERSON_EDITORIAL_OUTFIT_ENSEMBLES,
  type NearbyEventItem,
  type ProductItem,
  type StyleProfile,
  type TailoredOutfitMockup,
} from './src/data/catalog.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Free-tier model cascade starting with gemini-3.1-flash-lite for fast, high-quota free-tier execution
const TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
] as const;

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('quota') ||
    msg.includes('rate')
  );
}

async function generateContentWithFallback(
  params: Omit<GenerateContentParameters, 'model'>
) {
  let lastError: unknown = null;
  for (const model of TEXT_MODELS) {
    try {
      return await ai.models.generateContent({
        ...params,
        model,
      });
    } catch (err) {
      lastError = err;
      if (!isQuotaOrRateLimitError(err)) {
        break;
      }
    }
  }
  throw lastError;
}

async function generateStreamWithFallback(
  params: Omit<GenerateContentParameters, 'model'>
) {
  let lastError: unknown = null;
  for (const model of TEXT_MODELS) {
    try {
      return await ai.models.generateContentStream({
        ...params,
        model,
      });
    } catch (err) {
      lastError = err;
      if (!isQuotaOrRateLimitError(err)) {
        break;
      }
    }
  }
  throw lastError;
}

// Image generation models: standard gemini-3.1-flash-lite-image and high-quality gemini-nano-banana-2.1
const IMAGE_MODELS = [
  'gemini-3.1-flash-lite-image',
  'gemini-nano-banana-2.1',
] as const;

const editorialPhotoCache = new Map<string, string>();

async function generateEditorialOutfitImage(
  mockup: TailoredOutfitMockup,
  activeCatalog: ProductItem[] = CATALOG_PRODUCTS,
  forceRefresh = false,
  currentImageUrl?: string
): Promise<{ imageUrl: string; productIds: string[] }> {
  const fullContextText = [
    mockup.contextSummary || '',
    mockup.eventTitle,
    mockup.eventCategory,
  ]
    .filter(Boolean)
    .join(' ');

  const matchedEnsemble = matchPersonEditorialEnsemble(
    mockup.gender,
    mockup.productIds,
    fullContextText
  );

  const outfitProducts = (
    mockup.productIds.length > 0 ? mockup.productIds : matchedEnsemble.productIds
  )
    .map((id) => activeCatalog.find((p) => p.id === id))
    .filter((p): p is ProductItem => Boolean(p));

  const normalizedContextKey = fullContextText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 120);

  const cacheKey = `${mockup.gender}-${mockup.heightCm}-${mockup.weightKg}-${normalizedContextKey}-${outfitProducts
    .map((p) => p.id)
    .join('_')}`;

  if (!forceRefresh && editorialPhotoCache.has(cacheKey)) {
    return {
      imageUrl: editorialPhotoCache.get(cacheKey)!,
      productIds: outfitProducts.map((p) => p.id),
    };
  }

  const parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }> = [];

  for (const prod of outfitProducts.slice(0, 4)) {
    if (prod.imageUrl && prod.imageUrl.startsWith('/src/assets/images/')) {
      const localPath = path.join(__dirname, prod.imageUrl.replace(/^\//, ''));
      try {
        if (fs.existsSync(localPath)) {
          const fileBuffer = fs.readFileSync(localPath);
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: fileBuffer.toString('base64'),
            },
          });
        }
      } catch {
        // Ignore individual file read error and continue with prompt description
      }
    }
  }

  const garmentDescriptions = outfitProducts
    .map(
      (p, idx) =>
        `${idx + 1}. ${p.name} in ${p.colorway} (${p.composition}, ${p.category})`
    )
    .join('\n');

  const modelGenderDesc =
    mockup.gender === 'Female'
      ? 'female woman (womenswear fashion model)'
      : 'male man (menswear fashion model)';
  const oppositeGenderDesc =
    mockup.gender === 'Female' ? 'male or man' : 'female or woman';

  const contextDescription =
    mockup.contextSummary && mockup.contextSummary.trim()
      ? mockup.contextSummary.trim()
      : `${mockup.eventTitle} (${mockup.eventCategory})`;

  const promptText = `Create a full-body high-fashion editorial lookbook photograph of a real ${modelGenderDesc} (${mockup.heightCm} cm tall, ${mockup.weightKg} kg build, wearing Size ${mockup.recommendedSize}) tailored specifically for the following occasion and context: "${contextDescription}".

CRITICAL CONTEXT & SETTING REQUIREMENT: The environment, lighting, atmosphere, and styling mood MUST directly reflect the provided context: "${contextDescription}" (Category: ${mockup.eventCategory}).
CRITICAL GENDER REQUIREMENT: The person in the photograph MUST be a ${modelGenderDesc} (strictly ${mockup.gender} — NEVER show a ${oppositeGenderDesc}).
CRITICAL OUTFIT REQUIREMENT: The photo MUST show this ${mockup.gender.toLowerCase()} person wearing this exact combination of recommended garments together on their body as one complete outfit (matching the attached product reference images — do NOT show flat-lay, mannequin, or separate grid images):
${garmentDescriptions}

Show the ${mockup.gender.toLowerCase()} model head-to-toe wearing the complete outfit in a setting that matches "${contextDescription}" with natural fabric drape calibrated to ${mockup.heightCm} cm / ${mockup.weightKg} kg proportions, photorealistic luxury fashion photography, 8k.`;

  parts.push({ text: promptText });

  for (const imageModel of IMAGE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model: imageModel,
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio: '3:4',
          },
        },
      });

      const candidateParts = response.candidates?.[0]?.content?.parts || [];
      for (const part of candidateParts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType || 'image/png';
          const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
          editorialPhotoCache.set(cacheKey, dataUrl);
          return {
            imageUrl: dataUrl,
            productIds: outfitProducts.map((p) => p.id),
          };
        }
      }
    } catch (err) {
      if (!isQuotaOrRateLimitError(err)) {
        break;
      }
    }
  }

  if (forceRefresh) {
    const genderEnsembles = PERSON_EDITORIAL_OUTFIT_ENSEMBLES.filter(
      (e) => e.gender === mockup.gender
    );
    const currentIdx = genderEnsembles.findIndex(
      (e) => e.imageUrl === (currentImageUrl || mockup.mockupImageUrl)
    );
    const nextEnsemble =
      genderEnsembles[(currentIdx + 1) % genderEnsembles.length] ||
      matchedEnsemble;
    return {
      imageUrl: nextEnsemble.imageUrl,
      productIds: nextEnsemble.productIds,
    };
  }

  return {
    imageUrl: matchedEnsemble.imageUrl,
    productIds: matchedEnsemble.productIds,
  };
}

function computeRecommendedSize(
  gender: 'Female' | 'Male',
  heightCm: number,
  weightKg: number
): 'XS' | 'S' | 'M' | 'L' | 'XL' {
  if (gender === 'Male') {
    if (weightKg < 64 && heightCm < 172) return 'XS';
    if (weightKg <= 72 && heightCm <= 177) return 'S';
    if (weightKg <= 82 && heightCm <= 183) return 'M';
    if (weightKg <= 94 && heightCm <= 190) return 'L';
    return 'XL';
  }
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  if (weightKg < 52 || (heightCm < 162 && bmi < 20.5)) return 'XS';
  if (weightKg <= 63 && heightCm <= 173) return 'S';
  if (weightKg <= 76 && heightCm <= 182) return 'M';
  if (weightKg <= 88) return 'L';
  return 'XL';
}

function isEventInPast(
  title: string,
  dateStr: string,
  now = new Date()
): boolean {
  const combined = `${title} ${dateStr}`.toLowerCase();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed (0 = Jan, 7 = Aug, 9 = Oct)
  const currentDay = now.getDate();

  // Reject any event explicitly referencing a past year (e.g., 2023, 2024, 2025)
  const yearMatches = [...combined.matchAll(/\b(20\d{2})\b/g)].map((m) =>
    Number(m[1])
  );
  if (yearMatches.length > 0 && yearMatches.every((y) => y < currentYear)) {
    return true;
  }

  // If current month is after August (month > 7), August 31 / Merdeka / National Day of this year is in the past
  if (
    currentMonth > 7 &&
    (combined.includes('31 aug') ||
      combined.includes('august 31') ||
      combined.includes('merdeka') ||
      combined.includes('national day') ||
      combined.includes('hari kebangsaan') ||
      combined.includes('malaysia day') ||
      combined.includes('16 sep')) &&
    !combined.includes(String(currentYear + 1))
  ) {
    return true;
  }

  // Check explicit month names without next year's number
  const monthNames = [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ];

  const mentionsNextYear = combined.includes(String(currentYear + 1));
  if (!mentionsNextYear) {
    for (let m = 0; m < currentMonth; m++) {
      for (const token of monthNames[m]) {
        const regex = new RegExp(`\\b${token}\\b`, 'i');
        if (regex.test(dateStr)) {
          return true;
        }
      }
    }

    // Check if the event is in the current month but on a day that has already passed
    for (const token of monthNames[currentMonth]) {
      const dayBeforeMonth = new RegExp(`\\b(\\d{1,2})\\s+${token}\\b`, 'i');
      const monthBeforeDay = new RegExp(`\\b${token}\\s+(\\d{1,2})\\b`, 'i');
      const m1 = dateStr.match(dayBeforeMonth);
      const m2 = dateStr.match(monthBeforeDay);
      const dayNum = m1 ? Number(m1[1]) : m2 ? Number(m2[1]) : null;
      // Only mark as past if there is no later end-date range in the string
      if (dayNum !== null && dayNum < currentDay && !dateStr.includes('–') && !dateStr.includes('-')) {
        return true;
      }
    }
  }

  return false;
}

function inferEventLabel(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes('f1') ||
    lower.includes('formula') ||
    lower.includes('motogp') ||
    lower.includes('grand prix') ||
    lower.includes('sepang') ||
    lower.includes('motorsport') ||
    lower.includes('trackside') ||
    lower.includes('sport')
  ) {
    return 'Sports & Motorsport';
  }
  if (
    lower.includes('concert') ||
    lower.includes('music') ||
    lower.includes('live') ||
    lower.includes('tour') ||
    lower.includes('arena') ||
    lower.includes('zepp') ||
    lower.includes('festival') ||
    lower.includes('dj') ||
    lower.includes('nightlife')
  ) {
    return 'Live Music & Concert';
  }
  if (
    lower.includes('raya') ||
    lower.includes('open house') ||
    lower.includes('kebaya') ||
    lower.includes('cekak musang') ||
    lower.includes('baju melayu') ||
    lower.includes('festive') ||
    lower.includes('nikah') ||
    lower.includes('kenduri')
  ) {
    return 'Festive & Cultural Celebration';
  }
  if (
    lower.includes('batik') ||
    lower.includes('heritage') ||
    lower.includes('cultural') ||
    lower.includes('diplomatic')
  ) {
    return 'Heritage & Cultural Reception';
  }
  if (
    lower.includes('business') ||
    lower.includes('boardroom') ||
    lower.includes('office') ||
    lower.includes('corporate') ||
    lower.includes('executive') ||
    lower.includes('meeting') ||
    lower.includes('client') ||
    lower.includes('pitch') ||
    lower.includes('trx') ||
    lower.includes('conference')
  ) {
    return 'Executive & Business';
  }
  if (
    lower.includes('exhibition') ||
    lower.includes('art') ||
    lower.includes('gallery') ||
    lower.includes('museum') ||
    lower.includes('design') ||
    lower.includes('fashion')
  ) {
    return 'Arts & Exhibition';
  }
  if (
    lower.includes('gala') ||
    lower.includes('symphony') ||
    lower.includes('orchestra') ||
    lower.includes('dinner') ||
    lower.includes('rooftop') ||
    lower.includes('cocktail') ||
    lower.includes('fine dining') ||
    lower.includes('date night')
  ) {
    return 'Evening Reception & Gala';
  }
  return 'Lifestyle & Smart Casual';
}

function getDefaultProductsForGenderAndEvent(
  gender: 'Female' | 'Male',
  eventText: string,
  seedProductIds: string[] = []
): string[] {
  const lower = eventText.toLowerCase();
  if (
    seedProductIds.length === 0 &&
    (lower.includes('batik') || lower.includes('heritage')) &&
    gender === 'Male'
  ) {
    return ['vera-27', 'vera-18', 'vera-13'];
  }
  if (
    seedProductIds.length === 0 &&
    (lower.includes('boardroom') || lower.includes('executive')) &&
    gender === 'Male'
  ) {
    return ['vera-01', 'vera-07', 'vera-04'];
  }
  if (
    seedProductIds.length === 0 &&
    (lower.includes('boardroom') || lower.includes('executive')) &&
    gender === 'Female'
  ) {
    return ['vera-01', 'vera-02', 'vera-05'];
  }
  return matchPersonEditorialEnsemble(gender, seedProductIds, eventText)
    .productIds;
}

function buildTailoredMockup(
  eventTitle: string,
  eventCategory: string,
  gender: 'Female' | 'Male',
  heightCm: number,
  weightKg: number,
  productIds: string[],
  activeCatalog: ProductItem[] = CATALOG_PRODUCTS,
  contextSummary = ''
): TailoredOutfitMockup {
  const leadProduct = productIds[0]
    ? activeCatalog.find((p) => p.id === productIds[0])
    : undefined;
  const resolvedGender = resolveGenderForProduct(leadProduct, gender);

  const recommendedSize = computeRecommendedSize(
    resolvedGender,
    heightCm,
    weightKg
  );
  const heightM = heightCm / 100;
  const bmi = (weightKg / (heightM * heightM)).toFixed(1);
  const inseamCm = Math.round(heightCm * 0.45);
  const coatLengthCm = Math.round(
    heightCm * (resolvedGender === 'Male' ? 0.58 : 0.65)
  );

  const genderFilteredIds = productIds.filter((id) => {
    const prod = activeCatalog.find((p) => p.id === id);
    if (!prod) return false;
    if (resolvedGender === 'Male' && prod.genderLine === 'Womenswear')
      return false;
    if (resolvedGender === 'Female' && prod.genderLine === 'Menswear')
      return false;
    return true;
  });

  const combinedEventText = [contextSummary, eventTitle, eventCategory]
    .filter(Boolean)
    .join(' ');
  const matchedEnsemble = matchPersonEditorialEnsemble(
    resolvedGender,
    genderFilteredIds,
    combinedEventText
  );
  // Align productIds with the context-matched person editorial ensemble so the editorial photo
  // shows a person of the proper gender wearing that exact combination of recommended items
  const validIds = matchedEnsemble.productIds;

  return {
    id: `mockup-${Date.now()}`,
    eventTitle,
    eventCategory,
    gender: resolvedGender,
    heightCm,
    weightKg,
    recommendedSize,
    bodyFrameSummary: `${resolvedGender} · ${heightCm} cm · ${weightKg} kg (BMI ${bmi}) — Calibrated for Size ${recommendedSize}`,
    coatHemNote:
      resolvedGender === 'Male'
        ? `Tailored jacket/overcoat length falls at ${coatLengthCm} cm from shoulder, balancing a ${heightCm} cm menswear frame.`
        : `Outer layer hem falls at ${coatLengthCm} cm from shoulder, hitting mid-calf to elongate a ${heightCm} cm vertical line.`,
    trouserInseamNote: `Tailored pleated waist with ${inseamCm} cm inseam break calibrated for a ${weightKg} kg build.`,
    shoulderFitNote: `Structured Size ${recommendedSize} shoulder seam with natural movement`,
    stylistVerdict: `Tailored specifically for ${eventTitle} (${resolvedGender}, ${heightCm} cm, ${weightKg} kg). Size ${recommendedSize} delivers clean shoulder structure and balanced proportions.`,
    mockupImageUrl: matchedEnsemble.imageUrl,
    productIds: validIds,
    contextSummary: contextSummary || eventTitle,
  };
}

// Local deterministic styling generator used when free-tier API quota is temporarily exhausted
function buildDeterministicStylistResponse(
  gender: 'Female' | 'Male',
  heightCm: number | null,
  weightKg: number | null,
  selectedEvent?: NearbyEventItem | null,
  customContext?: string,
  focusedProduct?: ProductItem,
  activeCatalog: ProductItem[] = CATALOG_PRODUCTS,
  userMessage = ''
): string {
  const effectiveHeight = heightCm || (gender === 'Male' ? 178 : 166);
  const effectiveWeight = weightKg || (gender === 'Male' ? 72 : 56);
  const size = computeRecommendedSize(gender, effectiveHeight, effectiveWeight);
  const inseamCm = Math.round(effectiveHeight * 0.45);
  const coatLengthCm = Math.round(
    effectiveHeight * (gender === 'Male' ? 0.58 : 0.65)
  );

  const cleanedUserContext = userMessage
    .replace(
      /^I am (?:male|female), my height is \d+ cm and my weight is \d+ kg\. Recommend an outfit for /i,
      ''
    )
    .replace(/ and generate my tailored outfit mockup\.$/i, '')
    .trim();

  const targetTitle = focusedProduct
    ? `Styling Edit featuring ${focusedProduct.name}`
    : customContext && customContext.trim()
    ? selectedEvent
      ? `${selectedEvent.title} (${customContext.trim()})`
      : customContext.trim()
    : selectedEvent
    ? selectedEvent.title
    : cleanedUserContext || 'your styling context';

  const fullContextText = [
    selectedEvent?.title || '',
    selectedEvent?.category || '',
    selectedEvent?.venue || '',
    selectedEvent?.dressCode || '',
    customContext || '',
    userMessage || '',
  ]
    .filter(Boolean)
    .join(' ');

  const eventCat = selectedEvent
    ? selectedEvent.category
    : inferEventLabel(fullContextText);

  const matchedEnsemble = matchPersonEditorialEnsemble(
    gender,
    focusedProduct ? [focusedProduct.id] : [],
    fullContextText
  );
  const productIds = matchedEnsemble.productIds;

  const products = productIds
    .map((id) => activeCatalog.find((p) => p.id === id))
    .filter((p): p is ProductItem => Boolean(p));

  const bullets = products
    .map(
      (p) =>
        `- **${p.name}** [${p.sku}] (RM ${p.price.toLocaleString('en-MY')}): ${p.colorway} (${p.composition}). ${p.fitNotes}`
    )
    .join('\n');

  if (focusedProduct) {
    return `Here is a complete **${gender}** (${
      gender === 'Female' ? 'Womenswear' : 'Menswear'
    }) **SceneFitAI** styling recommendation built around the **${focusedProduct.name}** [${focusedProduct.sku}] for **${
      customContext?.trim() || selectedEvent?.title || 'Kuala Lumpur'
    }**:\n\n${bullets}\n\nThis **${gender}** combination pairs **${focusedProduct.name}** (${focusedProduct.colorway}) with complementary textures and proportions suited for Kuala Lumpur's warm outdoor climate and air-conditioned indoor venues. View the **Tailored Outfit Mockup** and recommended pieces below.`;
  }

  return `For **${targetTitle}** (${eventCat}), I have calibrated a **${gender}** silhouette tailored to a **${effectiveHeight} cm** height and **${effectiveWeight} kg** frame in **Size ${size}**:\n\n${bullets}\n\nAt **${effectiveHeight} cm**, an outer drape of **${coatLengthCm} cm** paired with a **${inseamCm} cm** trouser inseam elongates your vertical line while **Size ${size}** provides breathable shoulder balance for **${effectiveWeight} kg** across Kuala Lumpur's warm outdoor humidity and air-conditioned indoor venues. Inspect your **Tailored Outfit Mockup** and proportional fit blueprint below.`;
}

function buildStylistSystemInstruction(
  gender: 'Female' | 'Male',
  heightCm: number | null,
  weightKg: number | null,
  locationCity: string,
  focusedProduct?: ProductItem,
  selectedEvent?: NearbyEventItem | null,
  customContext?: string,
  activeCatalog: ProductItem[] = CATALOG_PRODUCTS,
  userMessage = ''
): string {
  const effectiveHeight = heightCm || (gender === 'Male' ? 178 : 166);
  const effectiveWeight = weightKg || (gender === 'Male' ? 72 : 56);
  const recommendedSize = computeRecommendedSize(
    gender,
    effectiveHeight,
    effectiveWeight
  );

  const catalogFormatted = activeCatalog
    .filter((p) =>
      gender === 'Male'
        ? p.genderLine !== 'Womenswear'
        : p.genderLine !== 'Menswear'
    )
    .map(
      (p) =>
        `- SKUTag: [${p.sku}] | ID: ${p.id} | Line: ${p.genderLine} | Name: "${p.name}" | Category: ${p.category} | Price: RM ${p.price.toLocaleString('en-MY')} | Colorway: ${p.colorway} | Composition: ${p.composition} | Fit: ${p.fitNotes}`
    )
    .join('\n');

  const profileContext = `Client Measurements & Profile:
- Gender / Line: ${gender}
- Height: ${effectiveHeight} cm | Weight: ${effectiveWeight} kg | Calculated Size: ${recommendedSize}
- Location / City: ${locationCity}`;

  const eventParts: string[] = [];
  if (selectedEvent) {
    eventParts.push(
      `Selected Nearby Event: "${selectedEvent.title}" (${selectedEvent.category}) at ${selectedEvent.venue}, ${selectedEvent.city} (${selectedEvent.date}). Weather/Setting: ${selectedEvent.weatherNote}. Dress Code: ${selectedEvent.dressCode}.`
    );
  }
  if (customContext && customContext.trim()) {
    eventParts.push(`Client Custom Context / Occasion: "${customContext.trim()}"`);
  }
  if (userMessage && userMessage.trim()) {
    eventParts.push(`Client Styling Request / Message: "${userMessage.trim()}"`);
  }
  const eventContext =
    eventParts.length > 0
      ? `\nTARGET EVENT / OCCASION CONTEXT:\n${eventParts.join('\n')}`
      : '\nTARGET EVENT / OCCASION CONTEXT: General styling edit.';

  const focusContext = focusedProduct
    ? `\nFOCUSED PIECE SELECTED BY CLIENT ("Style Piece"): "${focusedProduct.name}" ([${focusedProduct.sku}], RM ${focusedProduct.price.toLocaleString('en-MY')}, ${focusedProduct.colorway}, ${focusedProduct.composition}).`
    : '';

  const fullContextString = [
    selectedEvent?.title || '',
    selectedEvent?.category || '',
    selectedEvent?.venue || '',
    selectedEvent?.dressCode || '',
    customContext || '',
    userMessage || '',
  ]
    .filter(Boolean)
    .join(' ');

  const targetEnsemble = matchPersonEditorialEnsemble(
    gender,
    focusedProduct ? [focusedProduct.id] : [],
    fullContextString
  );
  const ensembleItemsFormatted = targetEnsemble.productIds
    .map((id) => activeCatalog.find((p) => p.id === id))
    .filter((p): p is ProductItem => Boolean(p))
    .map((p) => `**${p.name}** [${p.sku}] (RM ${p.price.toLocaleString('en-MY')})`)
    .join(', ');

  return `You are the Senior Personal Stylist at SceneFitAI Kuala Lumpur, an intelligent Malaysian fashion retail styling concierge located in Kuala Lumpur, Malaysia, serving both Male (Menswear) and Female (Womenswear) clients. All prices are in Malaysian Ringgit (RM). Keep in mind Malaysia's tropical warmth (27°C–32°C outdoors) paired with strongly air-conditioned indoor venues (such as KLCC, Pavilion KL, The Exchange TRX, Zepp KL, Axiata Arena, and Sepang VIP hospitality suites).

AVAILABLE COLLECTION FOR THIS CLIENT (${gender.toUpperCase()}):
${catalogFormatted}

${profileContext}${eventContext}${focusContext}

PRIMARY CURATED ENSEMBLE WORN ON MODEL FOR THIS CONTEXT:
${ensembleItemsFormatted}

CRITICAL STYLING & MOCKUP RULES:
1. ALWAYS generate a complete styling recommendation based on the TARGET EVENT / OCCASION CONTEXT (and/or FOCUSED PIECE) provided above, regardless of whether height or weight were explicitly typed by the client. NEVER refuse to recommend an outfit or ask for height/weight before recommending items.
2. Recommend the cohesive pieces from the PRIMARY CURATED ENSEMBLE WORN ON MODEL FOR THIS CONTEXT above (${ensembleItemsFormatted}) so that the client's **Editorial Photo** displays a real ${gender.toLowerCase()} model wearing that exact combination of recommended items for their context.
3. Always include each recommended piece's SKU tag in brackets right after the name (e.g. [VERA-01]).
4. Explain how the fabrics, colors, and Size ${recommendedSize} proportions suit the client's context and venue, and note that their **Tailored Outfit Mockup** and **Editorial Photo** are displayed below.
5. Keep responses concise, natural for both reading and voice readout, and around 90–150 words.`;
}

function extractRecommendedProductIds(
  text: string,
  activeCatalog: ProductItem[] = CATALOG_PRODUCTS
): string[] {
  const found = new Set<string>();
  const upper = text.toUpperCase();
  for (const product of activeCatalog) {
    if (
      upper.includes(product.sku.toUpperCase()) ||
      text.toLowerCase().includes(product.name.toLowerCase())
    ) {
      found.add(product.id);
    }
  }
  return Array.from(found);
}

function parseAttributesFromMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  fallbackGender: 'Female' | 'Male',
  fallbackHeight: number | null,
  fallbackWeight: number | null
): {
  gender: 'Female' | 'Male';
  heightCm: number | null;
  weightKg: number | null;
} {
  let gender = fallbackGender;
  let heightCm = fallbackHeight;
  let weightKg = fallbackWeight;

  const userTexts = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join(' ');

  const lower = userTexts.toLowerCase();
  if (
    /\b(male|man|men|menswear|guy|gentleman)\b/i.test(lower) &&
    !/\b(female|woman|women|womenswear)\b/i.test(lower)
  ) {
    gender = 'Male';
  } else if (/\b(female|woman|women|womenswear|lady)\b/i.test(lower)) {
    gender = 'Female';
  }

  const cmMatches = [...userTexts.matchAll(/(\d{3})\s*(?:cm|centimeters?)/gi)];
  if (cmMatches.length > 0) {
    const val = Number(cmMatches[cmMatches.length - 1][1]);
    if (val >= 140 && val <= 215) heightCm = val;
  }

  const kgMatches = [
    ...userTexts.matchAll(/(\d{2,3})\s*(?:kg|kilograms?|kilos?)/gi),
  ];
  if (kgMatches.length > 0) {
    const val = Number(kgMatches[kgMatches.length - 1][1]);
    if (val >= 38 && val <= 150) weightKg = val;
  }

  return { gender, heightCm, weightKg };
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/catalog', (_req, res) => {
    res.json({ products: CATALOG_PRODUCTS, defaultEvents: DEFAULT_NEARBY_EVENTS });
  });

  // In-memory cache of Google Search grounded events by city to avoid redundant API calls
  const groundedEventsCache = new Map<
    string,
    {
      events: NearbyEventItem[];
      sources: Array<{ title: string; uri: string }>;
      timestamp: number;
    }
  >();

  // Search Nearby Events using Google Search Grounding (tools: [{ googleSearch: {} }])
  app.post('/api/events/nearby', async (req, res) => {
    const city = (req.body?.city || 'Kuala Lumpur, Malaysia').trim();
    const gender: 'Female' | 'Male' = req.body?.gender || 'Male';
    const cacheKey = city.toLowerCase();

    const cached = groundedEventsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 1000 * 60 * 30) {
      const genderAdjusted = cached.events.map((evt) => {
        const eventDesc = `${evt.title} ${evt.category} ${evt.dressCode}`;
        return {
          ...evt,
          recommendedProductIds: getDefaultProductsForGenderAndEvent(
            gender,
            eventDesc
          ),
          mockupImageUrl: getOutfitMockupImageForEvent(gender, eventDesc),
        };
      });
      res.json({
        city,
        events: genderAdjusted,
        sources: cached.sources,
      });
      return;
    }

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const upcomingFallbacks = getUpcomingDefaultEvents(city);

    try {
      const searchResp = await generateContentWithFallback({
        contents: `Today's date is ${todayStr}. Use Google Search to find 4 UPCOMING real events in or near ${city} scheduled ON OR AFTER ${todayStr} (strictly future events; exclude any past events).

CRITICAL: Keep all event info SHORT AND SIMPLE:
- "title": string (short event name, 3–5 words max, e.g. "Coldplay Concert" or "PETRONAS Grand Prix")
- "category": string (1–2 words max, e.g. "Motorsport", "Concert", "Gala", "Exhibition")
- "date": string (short date, e.g. "Nov 14–16" or "Oct 25")
- "venue": string (short venue name, 2–3 words max, e.g. "Sepang Circuit" or "Axiata Arena")
- "city": string
- "weatherNote": string (short note, e.g. "30°C · Trackside" or "27°C · Indoor")
- "dressCode": string (short attire, 2–3 words max, e.g. "Smart Trackside" or "Formal Silk")

Return ONLY a valid JSON array of 4 objects (no markdown outside the array).`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const groundingChunks =
        searchResp.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const extractedSources: Array<{ title: string; uri: string }> = [];
      for (const chunk of groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          if (!extractedSources.some((s) => s.uri === chunk.web!.uri)) {
            extractedSources.push({
              title: chunk.web.title,
              uri: chunk.web.uri,
            });
          }
        }
      }

      const rawText = searchResp.text?.trim() || '[]';
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      const parsedEvents = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');

      const rawList = Array.isArray(parsedEvents) ? parsedEvents : [];
      const validFutureRaw = rawList.filter(
        (evt: Record<string, string>) =>
          evt &&
          evt.title &&
          !isEventInPast(evt.title || '', evt.date || '', now)
      );

      const shorten = (str: string, maxWords: number): string => {
        if (!str) return '';
        const words = str.trim().split(/\s+/);
        return words.length <= maxWords ? str.trim() : words.slice(0, maxWords).join(' ');
      };

      const normalizedEvents: NearbyEventItem[] = validFutureRaw
        .slice(0, 4)
        .map((evt: Record<string, string>, idx: number) => {
          const fallbackEvt = upcomingFallbacks[idx % upcomingFallbacks.length];
          const rawTitle = evt.title || fallbackEvt.title;
          const title = shorten(rawTitle, 6);
          const cat = shorten(
            (evt.category && evt.category.trim()) || inferEventLabel(title),
            3
          );
          const dressCode = shorten(evt.dressCode || fallbackEvt.dressCode, 4);
          const combinedDesc = `${title} ${cat} ${dressCode}`;

          return {
            id: `live-evt-${Date.now()}-${idx}`,
            title,
            category: cat,
            date: shorten(evt.date || fallbackEvt.date, 5),
            venue: shorten(evt.venue || fallbackEvt.venue, 5),
            city: evt.city || city,
            weatherNote: shorten(evt.weatherNote || fallbackEvt.weatherNote, 5),
            dressCode,
            recommendedProductIds: getDefaultProductsForGenderAndEvent(
              gender,
              combinedDesc
            ),
            mockupImageUrl: getOutfitMockupImageForEvent(gender, combinedDesc),
          };
        });

      // Top up with strictly upcoming future events if fewer than 4 remained after filtering out any past events
      while (normalizedEvents.length < 4) {
        const fb = upcomingFallbacks[normalizedEvents.length % upcomingFallbacks.length];
        const combinedDesc = `${fb.title} ${fb.category} ${fb.dressCode}`;
        normalizedEvents.push({
          ...fb,
          id: `upcoming-evt-${Date.now()}-${normalizedEvents.length}`,
          city,
          recommendedProductIds: getDefaultProductsForGenderAndEvent(
            gender,
            combinedDesc
          ),
          mockupImageUrl: getOutfitMockupImageForEvent(gender, combinedDesc),
        });
      }

      const finalEvents = normalizedEvents;
      const finalSources = extractedSources.slice(0, 5);

      groundedEventsCache.set(cacheKey, {
        events: finalEvents,
        sources: finalSources,
        timestamp: Date.now(),
      });

      res.json({
        city,
        events: finalEvents,
        sources: finalSources,
      });
    } catch {
      // Deterministic city-adapted fallback using strictly upcoming future dates
      const fallbackCityEvents: NearbyEventItem[] = upcomingFallbacks.map(
        (evt, idx) => {
          const combinedDesc = `${evt.title} ${evt.category} ${evt.dressCode}`;
          return {
            ...evt,
            id: `city-evt-${Date.now()}-${idx}`,
            title: city.toLowerCase().includes('kuala lumpur')
              ? evt.title
              : `${city} · ${evt.title}`,
            city,
            recommendedProductIds: getDefaultProductsForGenderAndEvent(
              gender,
              combinedDesc
            ),
            mockupImageUrl: getOutfitMockupImageForEvent(gender, combinedDesc),
          };
        }
      );
      res.json({
        city,
        events: fallbackCityEvents,
        sources: [],
      });
    }
  });

  // Dedicated endpoint to generate or regenerate the combined editorial outfit photo from the recommended items
  app.post('/api/mockup/generate-photo', async (req, res) => {
    try {
      const {
        mockup,
        availableCatalog,
        forceRefresh = false,
        currentImageUrl,
      }: {
        mockup: TailoredOutfitMockup;
        availableCatalog?: ProductItem[];
        forceRefresh?: boolean;
        currentImageUrl?: string;
      } = req.body;

      if (!mockup || !Array.isArray(mockup.productIds)) {
        res.status(400).json({ error: 'Valid mockup with productIds is required.' });
        return;
      }

      const activeCatalog =
        Array.isArray(availableCatalog) && availableCatalog.length > 0
          ? availableCatalog
          : CATALOG_PRODUCTS;

      const generated = await generateEditorialOutfitImage(
        mockup,
        activeCatalog,
        Boolean(forceRefresh),
        currentImageUrl
      );

      res.json({
        mockupImageUrl: generated.imageUrl,
        productIds: generated.productIds,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to generate combined editorial outfit photo.',
      });
    }
  });

  function generateDeterministicAISummary(data: any) {
    const topItem = data.topTrendingItem;
    const leadCategory = data.categoryBreakdown?.[0]?.name || 'Outerwear';
    const leadCatPercent = data.categoryBreakdown?.[0]?.percent || 38;
    const topSizeObj = (data.sizeDistribution || []).reduce(
      (prev: any, cur: any) => (cur.count > (prev?.count || 0) ? cur : prev),
      { size: 'M', count: 0, percent: 42 }
    );
    const busiestRack = data.rackTraffic?.[0]?.zone || 'Rack A-01';

    const headline = topItem
      ? `Surging ${leadCategory} Demand Led by ${topItem.name} — Prioritize Size ${topSizeObj.size}`
      : `Boutique Fitting Demand Centered on ${leadCategory} & Tailored Separates`;

    const executiveSummary = `Fitting room traffic indicates elevated demand in ${leadCategory} (${leadCatPercent}% of pulls), with shoppers heavily requesting size ${topSizeObj.size} (${topSizeObj.percent}% of total garments). Floor staff should ensure primary walkway racks are replenished promptly to avoid trial delays.`;

    const actions = [
      {
        category: 'Floor Restock & Steaming',
        icon: 'package',
        title: `Buffer Stock on ${topItem ? topItem.rackNumber.split('(')[0].trim() : busiestRack}`,
        action: topItem
          ? `Ensure at least 2 backup pieces of ${topItem.name} in sizes ${topSizeObj.size} and S are steamed and ready on the secondary rolling rail.`
          : `Replenish top-moving items in ${busiestRack} with sizes S and M from the backroom reserve.`,
      },
      {
        category: 'Visual Merchandising & Floor Flow',
        icon: 'layout',
        title: `Highlight ${leadCategory} on Entrance Showcase`,
        action: `Front-face key ${leadCategory.toLowerCase()} pieces on ${busiestRack}. Shoppers are gravitating toward versatile layered silhouettes suitable for air-conditioned venues.`,
      },
      {
        category: 'Fitting Room Staging',
        icon: 'door',
        title: 'Pre-Stage Matching Trousers & Slip Silhouettes',
        action: `When shoppers request outerwear or blazers, retail assistants should proactively have complementary wide-leg trousers (Rack B-02) or silk slip dresses (Rack B-01) ready outside the fitting suite.`,
      },
      {
        category: 'Merchandising & Reorder Advisory',
        icon: 'trending',
        title: `Monitor Size ${topSizeObj.size} Sell-Through`,
        action: `Size ${topSizeObj.size} represents ${topSizeObj.percent}% of all try-on allocations. Flag to regional inventory management if warehouse backup drops below 3 units per SKU.`,
      },
    ];

    return {
      headline,
      executiveSummary,
      priorityLevel: topSizeObj.percent > 40 ? 'High Action' : 'Optimized',
      actions,
      generatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
  }

  // Endpoint to generate an AI summary of recommended actions for boutique retail staff
  app.post('/api/analytics/ai-summary', async (req, res) => {
    try {
      const {
        totalSessions = 0,
        totalGarmentsRequested = 0,
        topTrendingItem,
        categoryBreakdown = [],
        sizeDistribution = [],
        rackTraffic = [],
        liveRequestsCount = 0,
        includeBaseline = true,
      } = req.body || {};

      const prompt = `You are the Senior Retail Director & Merchandising Intelligence Specialist for SceneFitAI at the flagship Pavilion Damansara Heights luxury boutique in Kuala Lumpur.
Analyze the following fitting room customer demand data and generate an actionable AI summary of recommended actions for boutique managers, retail assistants, and visual merchandisers.

Fitting Room Demand Data:
- Total Customer Try-On Sessions: ${totalSessions} (${liveRequestsCount} live today, baseline included: ${includeBaseline})
- Total Garments Pulled for Fittings: ${totalGarmentsRequested} (Average: ${(totalGarmentsRequested / (totalSessions || 1)).toFixed(1)} garments/shopper)
- #1 Trending Garment: ${topTrendingItem ? `${topTrendingItem.name} (${topTrendingItem.sku}) in ${topTrendingItem.category} - ${topTrendingItem.totalRequests} pulls (${topTrendingItem.requestSharePercent}% share) located at ${topTrendingItem.rackNumber}` : 'N/A'}
- Apparel Category Breakdown: ${categoryBreakdown.map((c: any) => `${c.name}: ${c.count} pulls (${c.percent}%)`).join(', ')}
- Size Run Demand Distribution: ${sizeDistribution.map((s: any) => `Size ${s.size}: ${s.count} pulls (${s.percent}%)`).join(', ')}
- Physical Rack Pull Velocity: ${rackTraffic.slice(0, 4).map((r: any) => `${r.zone}: ${r.count} pulls (${r.percent}%)`).join(', ')}

Return a JSON object conforming strictly to this format (no markdown code blocks, just raw JSON):
{
  "headline": "Punchy 6-12 word data-driven executive takeaway for retail operations",
  "executiveSummary": "2-3 concise sentences summarizing demand velocity, key customer silhouettes, and floor traffic.",
  "priorityLevel": "Urgent Restock" or "High Action" or "Optimized",
  "actions": [
    {
      "category": "Floor Restock & Steaming",
      "icon": "package",
      "title": "Short title",
      "action": "Clear, specific operational instruction detailing rack numbers and size runs to pull/steam from backroom."
    },
    {
      "category": "Visual Merchandising",
      "icon": "layout",
      "title": "Short title",
      "action": "Floor presentation or mannequin styling advice based on top category velocity."
    },
    {
      "category": "Fitting Room Staging",
      "icon": "door",
      "title": "Short title",
      "action": "Practical advice for retail assistants pulling garments for shoppers."
    },
    {
      "category": "Inventory Reorder Advisory",
      "icon": "trending",
      "title": "Short title",
      "action": "Stock depth or size replenishment signal for store merchandisers."
    }
  ]
}`;

      const aiResponse = await generateContentWithFallback({
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.3,
        },
      });

      const responseText = aiResponse.text?.trim() || '';
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        parsed.generatedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        res.json({ success: true, summary: parsed });
        return;
      }

      res.json({
        success: true,
        summary: generateDeterministicAISummary(req.body || {}),
      });
    } catch (err) {
      console.warn('AI summary generation fallback:', err);
      res.json({
        success: true,
        summary: generateDeterministicAISummary(req.body || {}),
        isFallback: true,
      });
    }
  });

  // Real-time SSE streaming endpoint for the SceneFitAI Stylist Agent
  app.post('/api/stylist/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const {
      messages = [],
      styleProfile,
      focusedProductId,
      selectedEvent,
      customContext,
      imageAttachment,
      availableCatalog,
    }: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      styleProfile?: StyleProfile;
      focusedProductId?: string;
      selectedEvent?: NearbyEventItem | null;
      customContext?: string;
      imageAttachment?: { mimeType: string; data: string };
      availableCatalog?: ProductItem[];
    } = req.body;

    const activeCatalog =
      Array.isArray(availableCatalog) && availableCatalog.length > 0
        ? availableCatalog
        : CATALOG_PRODUCTS;

    const lastUserMessage =
      messages.filter((m) => m.role === 'user').pop()?.content || '';

    const { gender, heightCm, weightKg } = parseAttributesFromMessages(
      messages,
      styleProfile?.gender || 'Male',
      styleProfile?.heightCm ?? null,
      styleProfile?.weightKg ?? null
    );

    const hasValidMeasurements =
      typeof heightCm === 'number' &&
      heightCm >= 130 &&
      typeof weightKg === 'number' &&
      weightKg >= 35;

    const focusedProduct = focusedProductId
      ? activeCatalog.find((p) => p.id === focusedProductId)
      : undefined;

    const effectiveGender: 'Female' | 'Male' = resolveGenderForProduct(
      focusedProduct,
      gender
    );

    // Always generate the tailored outfit mockup and editorial photo based on the context provided
    const shouldGenerateOutfit = true;

    let accumulatedText = '';

    try {
      const systemInstruction = buildStylistSystemInstruction(
        effectiveGender,
        heightCm,
        weightKg,
        styleProfile?.locationCity || 'Kuala Lumpur, Malaysia',
        focusedProduct,
        selectedEvent,
        customContext,
        activeCatalog,
        lastUserMessage
      );

      const formattedContents = messages.map((msg, idx) => {
        const isLastUserMsg = idx === messages.length - 1 && msg.role === 'user';
        const parts: Array<{
          text?: string;
          inlineData?: { mimeType: string; data: string };
        }> = [];

        if (isLastUserMsg && imageAttachment?.data && imageAttachment?.mimeType) {
          parts.push({
            inlineData: {
              mimeType: imageAttachment.mimeType,
              data: imageAttachment.data,
            },
          });
        }
        parts.push({ text: msg.content });

        return {
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts,
        };
      });

      const responseStream = await generateStreamWithFallback({
        contents: formattedContents,
        config: {
          systemInstruction,
          temperature: 0.7,
        },
      });

      let lastSentIds: string[] = [];

      for await (const chunk of responseStream) {
        const chunkText = chunk.text;
        if (chunkText) {
          accumulatedText += chunkText;
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunkText })}\n\n`);

          if (shouldGenerateOutfit) {
            const extractedIds = extractRecommendedProductIds(
              accumulatedText,
              activeCatalog
            ).filter((id) => {
              const p = activeCatalog.find((item) => item.id === id);
              if (!p) return false;
              if (effectiveGender === 'Male' && p.genderLine === 'Womenswear')
                return false;
              if (effectiveGender === 'Female' && p.genderLine === 'Menswear')
                return false;
              return true;
            });
            const currentIds = focusedProduct
              ? [
                  focusedProduct.id,
                  ...extractedIds.filter((id) => id !== focusedProduct.id),
                ]
              : extractedIds;
            if (currentIds.length > lastSentIds.length) {
              lastSentIds = currentIds;
              res.write(
                `data: ${JSON.stringify({
                  type: 'recommendations',
                  productIds: currentIds,
                })}\n\n`
              );
            }
          }
        }
      }
    } catch (error: unknown) {
      // If all free-tier model buckets are exhausted (429 RESOURCE_EXHAUSTED) or transiently unavailable,
      // seamlessly stream from the deterministic SceneFitAI Tailoring Engine so the user never sees an error.
      if (!accumulatedText) {
        const fallbackResponse = buildDeterministicStylistResponse(
          effectiveGender,
          heightCm,
          weightKg,
          selectedEvent,
          customContext,
          focusedProduct,
          activeCatalog,
          lastUserMessage
        );
        accumulatedText = fallbackResponse;
        res.write(
          `data: ${JSON.stringify({ type: 'chunk', text: fallbackResponse })}\n\n`
        );
      }
    }

    if (shouldGenerateOutfit) {
      const effectiveHeight = heightCm ?? (effectiveGender === 'Male' ? 178 : 166);
      const effectiveWeight = weightKg ?? (effectiveGender === 'Male' ? 72 : 56);
      const extractedIds = extractRecommendedProductIds(
        accumulatedText,
        activeCatalog
      );
      const finalIds = focusedProduct
        ? [
            focusedProduct.id,
            ...extractedIds.filter((id) => id !== focusedProduct.id),
          ]
        : extractedIds;

      const cleanedUserPrompt = lastUserMessage
        .replace(
          /^I am (?:male|female), my height is \d+ cm and my weight is \d+ kg\. Recommend an outfit for /i,
          ''
        )
        .replace(/ and generate my tailored outfit mockup\.$/i, '')
        .trim();

      const fullContextSummary = [
        selectedEvent
          ? `${selectedEvent.title} (${selectedEvent.category}, ${selectedEvent.venue}, ${selectedEvent.weatherNote}, Dress Code: ${selectedEvent.dressCode})`
          : '',
        customContext?.trim() || '',
        focusedProduct ? `Featuring ${focusedProduct.name} [${focusedProduct.sku}]` : '',
        !selectedEvent && !customContext?.trim() && !focusedProduct
          ? cleanedUserPrompt
          : '',
      ]
        .filter(Boolean)
        .join(' · ');

      const combinedContextText = `${fullContextSummary} ${lastUserMessage} ${accumulatedText}`;
      const eventCat = selectedEvent
        ? selectedEvent.category
        : inferEventLabel(combinedContextText);
      const eventTitle = focusedProduct
        ? customContext?.trim()
          ? `Styling Edit · ${focusedProduct.name} (${customContext.trim()})`
          : selectedEvent
          ? `${selectedEvent.title} · ${focusedProduct.name}`
          : `Styling Edit · ${focusedProduct.name}`
        : customContext && customContext.trim()
        ? selectedEvent
          ? `${selectedEvent.title} · ${customContext.trim()}`
          : customContext.trim()
        : selectedEvent
        ? selectedEvent.title
        : cleanedUserPrompt
        ? cleanedUserPrompt.length > 64
          ? `${cleanedUserPrompt.slice(0, 61)}...`
          : cleanedUserPrompt
        : `${eventCat} Styling Edit`;

      const tailoredMockup = buildTailoredMockup(
        eventTitle,
        eventCat,
        effectiveGender,
        effectiveHeight,
        effectiveWeight,
        finalIds,
        activeCatalog,
        fullContextSummary || eventTitle
      );

      // Always generate or resolve the editorial photo based on the context provided and recommended items
      const generatedEditorial = await generateEditorialOutfitImage(
        tailoredMockup,
        activeCatalog
      );
      if (generatedEditorial.imageUrl) {
        tailoredMockup.mockupImageUrl = generatedEditorial.imageUrl;
        tailoredMockup.productIds = generatedEditorial.productIds;
      }

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          productIds: tailoredMockup.productIds,
          updatedGender: tailoredMockup.gender,
          updatedMeasurement: hasValidMeasurements
            ? {
                gender: tailoredMockup.gender,
                heightCm: effectiveHeight,
                weightKg: effectiveWeight,
                recommendedSize: tailoredMockup.recommendedSize,
              }
            : undefined,
          tailoredMockup,
        })}\n\n`
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          productIds: [],
        })}\n\n`
      );
    }
    res.end();
  });

  // Explicit route for all product and editorial images to guarantee direct delivery across all path variations
  app.get(
    ['/src/assets/images/:filename', '/assets/images/:filename', '/images/:filename'],
    (req, res, next) => {
      const filename = path.basename(req.params.filename);
      const possiblePaths = [
        path.join(__dirname, 'src/assets/images', filename),
        path.join(__dirname, 'public/assets/images', filename),
        path.join(__dirname, 'public/images', filename),
        path.join(__dirname, 'public/src/assets/images', filename),
        path.join(__dirname, 'dist/assets/images', filename),
        path.join(__dirname, 'dist/src/assets/images', filename),
        path.join(__dirname, 'dist/images', filename),
      ];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.setHeader('Content-Type', 'image/jpeg');
          return res.sendFile(p);
        }
      }
      next();
    }
  );

  // Static asset serving: ensure /src/assets and /assets are served directly in all environments
  const srcAssetsDir = path.resolve(__dirname, 'src/assets');
  if (fs.existsSync(srcAssetsDir)) {
    app.use('/src/assets', express.static(srcAssetsDir, { maxAge: '1d' }));
    app.use('/assets', express.static(srcAssetsDir, { maxAge: '1d' }));
  }

  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { maxAge: '1d' }));
  }

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SceneFitAI server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
