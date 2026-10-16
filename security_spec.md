# SceneFitAI Kuala Lumpur — Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Default-Deny Safety Net**: Every path not explicitly matched in `/apparel/{apparelId}`, `/profiles/{userId}`, `/orders/{orderId}`, or `/try_on_requests/{requestId}` is strictly denied (`allow read, write: if false;`).
2. **Apparel Catalog (`/apparel/{apparelId}`)**:
   - Public `get` and `list` are permitted for `resource.data.currency == 'RM'` so clients can browse the 30-piece Kuala Lumpur apparel collection.
   - `create` and `update` require an authenticated, email-verified user (`request.auth != null && request.auth.token.email_verified == true`), a valid `apparelId` matching `^[a-zA-Z0-9_\-]+$` (`<= 64` chars), `incoming().id == apparelId`, `incoming().authorUid == request.auth.uid`, strict key allowlists (`hasAll` and `hasOnly`), bounded arrays (`sizes.size() <= 6`, `stylingPairings.size() <= 6`, `occasions.size() <= 6`), and strict server timestamps (`createdAt == request.time`, `updatedAt == request.time`).
3. **Client Measurement Profiles (`/profiles/{userId}`)**:
   - Strictly isolated per user: `userId == request.auth.uid` and `incoming().ownerId == request.auth.uid`.
   - `list` is forbidden (`allow list: if false;`) to prevent scraping user profiles.
   - `heightCm` must be between `130` and `220`; `weightKg` must be between `35` and `160`.
   - `createdAt` and `ownerId` are immutable on `update`.
4. **Client Orders (`/orders/{orderId}`)**:
   - `get` and `list` are strictly restricted to the document owner (`resource.data.ownerId == request.auth.uid`).
   - `create` requires `incoming().ownerId == request.auth.uid`, `incoming().status == 'confirmed'`, `incoming().createdAt == request.time`, and `incoming().updatedAt == request.time`.
   - Terminal State Locking: Once `existing().status == 'completed'`, no further updates are permitted.
5. **Fitting Room Try-On Requests (`/try_on_requests/{requestId}`)**:
   - `create` requires valid `requestId`, `isValidTryOnRequest(incoming())`, matching `incoming().id == requestId`, `status` in `['pending', 'preparing']`, bounded `items` array (`1..20`), and server timestamps (`createdAt == request.time`, `updatedAt == request.time`).
   - `get` and `list` allow shoppers and retail assistants to track and dispatch active try-on requests filtered by legitimate workflow states.
   - `update` allows the retail assistant to transition statuses and assign manual `fittingRoomNumber` (`incoming().diff(existing()).affectedKeys().hasOnly(['status', 'fittingRoomNumber', 'allocatedBy', 'updatedAt'])`), preserving all immutable fields (`id`, `requestNumber`, `shopperName`, `items`, `itemCount`, `createdAt`).
   - Terminal State Locking: Once `existing().status == 'completed'`, no further updates are permitted.

## 2. The "Dirty Dozen" Payloads
1. **Shadow Field Injection on Apparel**: Creating `/apparel/vera-01` with extra field `"isFeaturedHack": true` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: Creating `/apparel/vera-01` when `request.auth.token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Apparel**: Creating `/apparel/vera-01` with `authorUid: "someone-else"` -> `PERMISSION_DENIED`.
4. **Timestamp Forgery on Apparel**: Creating `/apparel/vera-01` with client-chosen `createdAt` != `request.time` -> `PERMISSION_DENIED`.
5. **Array Overflow on Apparel**: Creating `/apparel/vera-01` with `sizes` array of 20 items (`> 6`) -> `PERMISSION_DENIED`.
6. **ID Mismatch on Apparel**: Creating `/apparel/vera-01` where `data.id == "vera-99"` -> `PERMISSION_DENIED`.
7. **Cross-User Profile Read**: User A attempting `get` on `/profiles/userB` -> `PERMISSION_DENIED`.
8. **Profile Collection List Scraping**: Authenticated user attempting `list` on `/profiles` -> `PERMISSION_DENIED`.
9. **Out-of-Bounds Measurements**: Creating `/profiles/userA` with `heightCm: 999` or `weightKg: 5` -> `PERMISSION_DENIED`.
10. **Immutable Field Mutation on Profile**: Updating `/profiles/userA` with modified `createdAt` or `ownerId` -> `PERMISSION_DENIED`.
11. **Cross-User Order List Leak**: User A querying `/orders` without `ownerId == request.auth.uid` -> `PERMISSION_DENIED`.
12. **Terminal State Bypass on Try-On Request**: Updating `/try_on_requests/try-1` when `existing().status == 'completed'` -> `PERMISSION_DENIED`.
