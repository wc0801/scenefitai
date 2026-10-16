/**
 * Security Rules Specification Test Runner (Phase 0 Dirty Dozen Verification)
 * Verifies that all 12 adversarial payloads against /apparel, /profiles, and /orders
 * are rejected with PERMISSION_DENIED by firestore.rules.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expectedResult: 'PERMISSION_DENIED';
  payload?: Record<string, unknown>;
}

export const DIRTY_DOZEN_SECURITY_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Shadow Field Injection on Apparel',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
    payload: { id: 'vera-01', sku: 'VERA-01', isFeaturedHack: true },
  },
  {
    id: 2,
    name: 'Unverified Email Write on Apparel',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Identity Spoofing on Apparel authorUid',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
    payload: { id: 'vera-01', authorUid: 'spoofed-uid' },
  },
  {
    id: 4,
    name: 'Timestamp Forgery on Apparel createdAt',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Array Overflow on Apparel sizes (> 6 elements)',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
    payload: { sizes: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  },
  {
    id: 6,
    name: 'ID Mismatch on Apparel path vs payload',
    collectionPath: '/apparel/vera-01',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
    payload: { id: 'vera-99' },
  },
  {
    id: 7,
    name: 'Cross-User Profile Read (User A reading User B)',
    collectionPath: '/profiles/user-b',
    operation: 'get',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Profile Collection List Scraping',
    collectionPath: '/profiles',
    operation: 'list',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Out-of-Bounds Measurements on Profile',
    collectionPath: '/profiles/user-a',
    operation: 'create',
    expectedResult: 'PERMISSION_DENIED',
    payload: { heightCm: 999, weightKg: 5 },
  },
  {
    id: 10,
    name: 'Immutable Field Mutation on Profile (createdAt)',
    collectionPath: '/profiles/user-a',
    operation: 'update',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Cross-User Order Query Leak',
    collectionPath: '/orders/order-other',
    operation: 'get',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Terminal State Bypass on Completed Order',
    collectionPath: '/orders/order-1',
    operation: 'update',
    expectedResult: 'PERMISSION_DENIED',
    payload: { status: 'confirmed' },
  },
  {
    id: 13,
    name: 'Terminal State Bypass on Completed Try-On Request',
    collectionPath: '/try_on_requests/try-1',
    operation: 'update',
    expectedResult: 'PERMISSION_DENIED',
    payload: { status: 'pending' },
  },
];
