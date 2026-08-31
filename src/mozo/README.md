# Mozo App Store Bridge

Bridges HexaAI to Mozo. Two directions of data flow:
- HexaAI-data-out (`/mozo/hexaai/*`, `/auth/embedded-session`) is still **single-tenant** — hardcoded to one HexaAI company via `MOZO_SINGLE_TENANT_COMPANY_ID`.
- Mozo-data-in (`/mozo/menu`, `/mozo/orders`, `/mozo/orders/:id`, `/mozo/venue`) is **multi-tenant**: every request supplies its own `venue_id` (query string) and is resolved against that Mozo venue via the direct API. `MOZO_SINGLE_TENANT_VENUE_ID` only survives as a fallback for in-process callers (the conversation-flow tools) that don't yet resolve a venue per company — see "Why single-tenant" below, which now only applies to that half.

```
Mozo iframe/widget (browser)  ──CORS──►  /mozo/hexaai/*         ──►  HexaAI's own data
Mozo bridge (server-to-server) ──secret──►  POST /auth/embedded-session ──►  a real HexaAI login session

HexaAI's own backend  ──────────────────►  /mozo/menu, /mozo/orders, /mozo/venue  ──►  Mozo's real direct venue API
                                            POST /mozo/auth/token (separate App Store OAuth exchange, see below)
```

## Two different Mozo APIs — don't conflate them

This module talks to **two unrelated Mozo products**, discovered the hard way (built against the wrong one first, then given real test credentials that revealed the actual one):

| | App Store marketplace API | Direct venue/POS API |
|---|---|---|
| Purpose | Third-party apps installed into any venue via Mozo's marketplace (widget iframe, webhooks, install review) | Mozo's own internal venue/order/POS data, for a specific known venue |
| Paths | `/v4/app-store/*` | `/v4/entity/*`, `/v4/catalog/*`, `/v4/process/*`, `/v2/process/*`, etc. — no `/app-store` segment |
| Auth | OAuth: `client_id`/`client_secret` → `POST /v4/app-store/auth/token` → bearer `app_access` token | Static `X-API-Key: <MOZO_DEVELOPER_AUTH_KEY>` header on every request (also accepts `bearerAuth` per its OpenAPI spec, but the confirmed working path is `X-API-Key`) |
| Real base URL | **Unconfirmed** — every `/v4/app-store/*` path 404s against `https://testapiv2.themozo.net`; the real host for this product is still unknown | Confirmed: `https://testapiv2.themozo.net` (test), `https://demoapiv2.themozo.net` (demo) |
| Serves in this module | `MozoTokenService`, `POST /mozo/auth/token`, `MozoPublicKeyService` + `MozoIframeSessionGuard` (iframe verification), webhook receiving | `MozoApiService` — `GET /mozo/menu`, `/mozo/orders`, `/mozo/orders/:id`, `/mozo/venue` |
| Status | Built from three docs (`app-store-quickstart.md`, `app-store-webhooks.md`, `app-store-beta-contract.md`) and proven mechanically against a mock server built from those same docs. **Never exercised against a real server** — the real host is unknown, so this remains unverified. | Confirmed live against the real test server with real credentials — see "Direct venue API" below for exactly what's been tested. |

Practical implication: the `/mozo/hexaai/*` widget-facing routes (activity feed, embed-session, `MozoIframeSessionGuard`'s RS256 verification) and the webhook receiver are **still the App Store marketplace flow** and remain unverified against a real server — nothing about the direct-API discovery changes or fixes those. Only `MozoApiService` (menu/orders/venue) was reworked.

## Why single-tenant (HexaAI-data-out direction only)

This started as a general per-venue API-key-linking system (`MozoVenueLinkService`, the `mozo_venue_links` table, `POST /mozo/hexaai/connect`) — a Mozo venue would `connect` a HexaAI API key, and every read resolved the key for that venue. That trust model was walked back for the HexaAI-data-out direction (`/mozo/hexaai/*`, `/auth/embedded-session`): a general-purpose HexaAI API key shouldn't be able to log someone in. That half still resolves to a hardcoded single company ID instead of a per-request lookup.

The Mozo-data-in direction (`MozoApiService` — menu/orders/venue) does **not** have this problem — reading a venue's own menu/orders isn't a login/trust decision — so it takes `venue_id` per request instead of a fixed env value. See "Endpoints" below.

**`MozoVenueLinkService` / `mozo_venue_links` / `POST /mozo/hexaai/connect` are dead code** — nothing reads that table anymore. Left in place rather than removed; confirm before deleting if you're cleaning this up.

## Environment variables

| Var | Used by | Notes |
|---|---|---|
| `MOZO_CLIENT_ID` / `MOZO_CLIENT_SECRET` | `MozoTokenService` | **App Store marketplace OAuth** credentials — separate product, real host unconfirmed. Rotate via `POST /v4/app-store/app/:app_id/credential/rotate`, once a real host is known. |
| `MOZO_API_URL` | `MozoTokenService` | App Store marketplace API base URL — unconfirmed, see "Two different Mozo APIs" above. |
| `MOZO_DIRECT_API_URL` | `MozoApiService` | **Confirmed working** base URL for Mozo's real direct venue API. `https://testapiv2.themozo.net` (test) / `https://demoapiv2.themozo.net` (demo). |
| `MOZO_DEVELOPER_AUTH_KEY` | `MozoApiService` | **Confirmed working** static API key, sent as `X-API-Key` on every direct-API request. Issued directly by Mozo per environment (not self-generated via app registration — unlike the App Store's client id/secret). |
| `MOZO_WEBHOOK_SECRET` | `POST /mozo/webhooks/mozo` | HMAC secret for verifying Mozo webhook deliveries. Part of the App Store marketplace flow — register via `PUT /v4/app-store/app/:app_id/webhook`, once a real host is known. |
| `MOZO_ALLOWED_ORIGINS` | `main.ts` CORS delegate | Comma-separated browser origins allowed to call `/mozo/*` (the widget running inside Mozo's iframe). Scoped to `/mozo/*` only — the global `enableCors()` delegate keeps this separate from the rest of the app's CORS policy. |
| `MOZO_BRIDGE_SHARED_SECRET` | `MozoBridgeSecretGuard` | Plain infra secret — **not** an API key, not part of the `ApiKeyPermissions` system. Gates `POST /auth/embedded-session`. Generate with `openssl rand -hex 32`; set identically on both sides. Never exposed in any UI, never rotatable by end users. |
| `MOZO_SINGLE_TENANT_COMPANY_ID` | `AuthService.embeddedSession`, `MozoController.hexaaiActivity` | The one HexaAI company every embedded session / activity read resolves to. |
| `MOZO_SINGLE_TENANT_VENUE_ID` | `MozoApiService` (fallback only) | No longer used by the HTTP endpoints — `GET /mozo/menu`/`/orders`/`/venue` require `venue_id` on every request. Only used as a fallback by in-process callers that don't pass a venue_id, i.e. the conversation-flow tools (`flow-tools/mozo-order.tool.ts`). Currently `28` ("MRWINSTON") — the first real test venue found with an actual configured catalog item; venue `13` ("BORK") also exists and is reachable but has an empty catalog, so it's not useful for exercising menu logic. |

Run migration `app/src/migrations/create-mozo-venue-links-table.sql` (dev with `DB_SYNC=true` creates it automatically from the entity — needed for now even though it's unused, see above).

## Getting real credentials

### Direct API (`MOZO_DEVELOPER_AUTH_KEY`) — already obtained, in use

Unlike the App Store flow below, this key isn't self-generated — Mozo hands it out directly per environment. Test-environment key + base URL are already set in `.env`:

```
MOZO_DIRECT_API_URL=https://testapiv2.themozo.net
MOZO_DEVELOPER_AUTH_KEY=f8b8f7d1-4f7c-45bc-b0d9-77a573f4f080
```

Their published test/demo environments (admin panel `https://testadmin.themozo.net` / `https://demoadmin.themozo.net`, login `development@themozo.online`) also give a `bearerAuth` JWT option per their OpenAPI spec, but `X-API-Key` is what's confirmed working here — no need to touch the bearer path.

### App Store marketplace OAuth (`MOZO_CLIENT_ID`/`SECRET`) — separate flow, real host still unconfirmed

None of `MOZO_CLIENT_ID`, `MOZO_CLIENT_SECRET`, or `MOZO_WEBHOOK_SECRET` are handed out by Mozo — they're self-service, generated by registering an app in the Mozo App Store (`app-store-quickstart.md` Steps 1–7). Requires a Mozo staff/developer JWT (`STAFF_JWT`, Auth0-issued) and a venue to install into — only whoever has that login can run this, not something obtainable from these docs alone.

### `scripts/mozo-onboarding.js` — runs the whole sequence for you

```bash
API_BASE_URL="https://<mozo-environment>" STAFF_JWT="<your-mozo-developer-jwt>" VENUE_ID="<venue-id>" \
DEVELOPER_EMAIL="you@example.com" DEVELOPER_NAME="Your Name" \
npm run mozo:onboard
```

Runs developer profile → app creation → scope config → **credential rotation** (the step that actually mints `MOZO_CLIENT_ID`/`MOZO_CLIENT_SECRET`) → venue install → submit for review, and prints a ready-to-paste `.env` block at the end. `APP_ID=<id>` resumes from scope config if you already have an app; `SKIP_REVIEW=1` stops before submitting.

Its request/response handling was run end-to-end against the mock server (see below) to catch bugs in the script itself — sequencing, error handling, field extraction — before it ever touches real Mozo. That does **not** prove the exact field names it expects (`app_id`, `client_id`, `client_secret`, ...) match Mozo's real responses, since the quickstart never shows literal JSON for these endpoints — only "save the returned app_id" / "save client_id, client_secret". If a field turns out to have a different name in Mozo's real response, the script will fail loudly (`Could not find client_id/client_secret in the response: <the actual JSON>`) rather than silently proceeding with `undefined` — so a wrong guess here is a quick one-line fix, not a hidden bug.

If you'd rather not paste `STAFF_JWT` into this chat, run it yourself locally and share just the printed output — the credentials it produces, not the login that produced them.

### Manual equivalent, if you want to see each step

```bash
export API_BASE_URL="https://<mozo-environment>"   # this value becomes MOZO_API_URL
export STAFF_JWT="<your-mozo-developer-jwt>"
export VENUE_ID="<venue-id>"

# 1. Developer profile (once per Mozo account)
curl -X POST "$API_BASE_URL/v4/app-store/developer" -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" -d '{"email":"you@example.com","name":"Your Name"}'

# 2. Create the app — save the returned app_id
curl -X POST "$API_BASE_URL/v4/app-store/app" -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" -d '{"slug":"hexaai","name":"HexaAI","category":"operations"}'
export APP_ID="<app_id from the response>"

# 3. Configure scopes — this module needs at least orders:read, orders:write, menu:read
curl -X PUT "$API_BASE_URL/v4/app-store/app/$APP_ID/scope" -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" \
  -d '{"scopes":[{"scope":"orders:read","reason":"read venue orders"},{"scope":"orders:write","reason":"create/update orders from a phone booking"},{"scope":"menu:read","reason":"answer menu questions on a call"}]}'

# 4. Rotate credentials — THIS is the step that mints MOZO_CLIENT_ID / MOZO_CLIENT_SECRET.
# client_secret is shown once, in this response only — never returned again after this.
curl -X POST "$API_BASE_URL/v4/app-store/app/$APP_ID/credential/rotate" -H "Authorization: Bearer $STAFF_JWT"

# 5. Install into the venue
curl -X POST "$API_BASE_URL/v4/app-store/venue/$VENUE_ID/install" -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" -d "{\"app_id\":\"$APP_ID\"}"

# 6. Submit for review — POST /v4/app-store/auth/token rejects draft/submitted/in_review apps,
# so nothing in MozoTokenService works until a Mozo reviewer approves this.
curl -X POST "$API_BASE_URL/v4/app-store/app/$APP_ID/review" -H "Authorization: Bearer $STAFF_JWT" \
  -H "Content-Type: application/json" -d '{"submission_snapshot":{}}'
```

`MOZO_WEBHOOK_SECRET` isn't issued either — pick any random string 16+ characters (`openssl rand -hex 16`) and register it via `PUT /v4/app-store/app/:app_id/webhook`; the same value has to be set on both sides. `MOZO_API_URL` is just `$API_BASE_URL` above — whichever Mozo environment (staging/production) you targeted.

Either way, I can't run this myself — every step needs `STAFF_JWT`, a real login only a Mozo developer account holder has.

## Endpoints

### `POST /auth/embedded-session` — lives in the `auth` module, not here

Mints a real, short-lived HexaAI login session (same response shape as `/auth/login`, minus `refreshToken`; 20-minute expiry, `role: member`, `companyRole: embedded`) for the single configured company. Gated by the `X-Mozo-Bridge-Secret` header (`MozoBridgeSecretGuard`) plus an IP rate limit (`EmbeddedSessionRateLimitGuard`). **Server-to-server only** — the secret must never reach a browser, so never call this from client code.

### `/mozo/hexaai/*` — HexaAI data, read by the Mozo widget's browser JS

| Route | Auth | Purpose |
|---|---|---|
| `GET /mozo/hexaai/activity?limit=` | CORS + `MozoIframeSessionGuard` | Recent call activity for the single company — calls `DashboardService.getRecentActivity` directly, no HTTP hop to `/dashboard-stats/*`. |
| `GET /mozo/hexaai/embed-session?redirect=/dashboard\|/calls` | CORS + `MozoIframeSessionGuard` | Calls `AuthService.embeddedSession()` directly, returns `{embedUrl}` pointing at `{FRONTEND_BASE_URL}/mozo-embed?token=...&redirect=...`. HexaAI-FE's `/mozo-embed` route lands that token as a cookie and redirects into the real app — no custom-built page. |

Neither route requires `X-Mozo-Bridge-Secret` — they're called directly by the widget's browser JS (that's what `MOZO_ALLOWED_ORIGINS` CORS is for), and the secret must never reach a browser. Instead, both require `Authorization: Bearer <iframe_session_token>`, verified by `MozoIframeSessionGuard` against Mozo's published public key (RS256 signature only — see "Known gaps" for exactly what's still unchecked).

### `/mozo/*` — Mozo's own data, read/written by HexaAI's backend

`MozoApiService` (menu/orders/venue) now talks to the **direct venue API**, not the App Store marketplace. `POST /mozo/auth/token` and webhooks are still the marketplace flow — see "Two different Mozo APIs" above.

| Route | Purpose | Status against the real server |
|---|---|---|
| `POST /mozo/auth/token` | Exchanges `MOZO_CLIENT_ID`/`SECRET` for an App Store `app_access` token. Body/query: `venue_id`. | **Unconfirmed** — App Store marketplace's real host is unknown; never exercised against a real server. |
| `GET /mozo/menu?venue_id=` | `GET /v4/catalog/article/all/{venue_id}` on the direct API — a thin passthrough, kept simple/raw for API parity. `venue_id` is required (400 if missing). | **Confirmed live with real data** against venue 28 — see "Catalog/menu data model" below. The flow-tool layer (`mozo_get_menu`/`mozo_append_order_item`) uses a richer merge of this endpoint plus `getActiveMenu()`, not this raw passthrough directly. |
| `GET /mozo/orders?venue_id=` | `POST /v2/process/order/entity/all/simple/{venue_id}` on the direct API (note: POST, not GET, despite the method on our own route). `venue_id` is required (400 if missing). | **Confirmed** — `200`, real (empty) array. |
| `GET /mozo/orders/:orderSessionId` | Best-guess `GET /v2/process/order/{id}` on the direct API — no `venue_id` needed, Mozo's own endpoint is keyed by order session id alone. | **Unconfirmed** — test venue has zero orders, so there's nothing real to fetch by id yet. |
| `POST /mozo/orders` | Create an order. | **Not implemented.** `MozoApiService.createOrder()` throws immediately with a message pointing here — see "Order creation" below for why. |
| `PUT /mozo/orders/status` | Update an order's status. | **Not implemented**, same reason — depends on the same unresolved flow as order creation. |
| `GET /mozo/venue?venue_id=` | `GET /v4/entity/venue/{venue_id}` on the direct API. `venue_id` is required (400 if missing). | **Confirmed** — real data returned for venue 28 (`"MRWINSTON"`) and venue 13 (`"BORK"`), both Mozo test venues. |
| `POST /mozo/webhooks/mozo` | Receives Mozo webhook deliveries; verifies HMAC-SHA256 signature against the raw body. | **Unconfirmed** — part of the App Store marketplace flow, same status as `POST /mozo/auth/token`. |
| `GET /mozo/healthz` | Liveness probe. | — |

None of these require auth today. They're meant for HexaAI's own backend code (eventually the voice-call/conversation-flow system) to call, not the public internet.

`venue_id` is Mozo's own venue `entity_id` (e.g. `13`, `28`) — not a HexaAI id, and not a URL/hostname. There's one shared Mozo API host per environment (`MOZO_DIRECT_API_URL`, e.g. `https://testapiv2.themozo.net`); venues are selected by id on that same host, not by a per-venue URL.

### Catalog/menu data model — confirmed live against a real populated venue

Venue 13 ("BORK") has an empty catalog, which is why earlier work never actually saw real menu data. Venue 28 ("MRWINSTON") does — one item ("koffie"/"Coffee") with two modifier options ("Met slagroom"/"Zonder slagroom" — with/without whipped cream) — and reading it live revealed the real shape is nested and split across two endpoints, not the flat single-endpoint shape originally guessed:

- **`GET /v4/catalog/article/active/{venue_id}`** (`MozoApiService.getActiveMenu()`) — only orderable (`status:1`) items. Each entry: `{ article: { id, name, description, price, vat: {id, name, percentage}, options: [{id, article_option_article_id, name, price}] } }`. Names/descriptions are in the venue's own language only (Dutch, for this test venue) — no translations here.
- **`GET /v4/catalog/article/all/{venue_id}`** (`MozoApiService.getMenu()`) — every article, including each option as its own top-level entry (so options 36/37 appear here as standalone "articles" too, alongside item 35). Each entry: `{ article: {...}, translations: { name: {en: "Coffee"}, description: {en: "latte"} }, category, vat: {id}, currency: {id}, deposit: {id}, pos: {id}, option_groups: [{id}] }`. Has translations, but only bare option-group **ids**, not option details/prices.

Neither call alone is enough — `flow-tools/mozo-order.tool.ts`'s `extractMozoMenuItems(activeMenu, allMenu, language)` merges both: takes price/VAT/options from `active`, and overlays a translated name/description (looked up by article id from `all`) when one exists for the requested language, falling back to the native name otherwise. Also keeps the native name (`MozoMenuItem.nativeName`) as a match fallback, since a guest might name an item in the venue's own language mid-call. This merge is exercised by both `mozo_get_menu` (Q&A) and `mozo_append_order_item` (order-line resolution) — see their docblocks.

Not yet confirmed: `currency.id` (`47` for this venue) has no dedicated lookup endpoint found in the spec (a direct `GET /v4/entity/currency/47` guess 404'd) — there's no live-confirmed way to turn it into a real currency code/symbol. `order_total_suffix` (in `mozo_append_order_item`'s output) currently hardcodes a `$` sign, which is likely wrong for this Dutch (€) test venue — cosmetic, but worth fixing once a real currency-resolution path is found, or by making the symbol a per-venue config value on HexaAI's side instead of relying on Mozo's API for it.

Categories (`GET /v4/catalog/category/dinemenu/{dinemenu_id}`) and dine menus (`GET /v4/catalog/dinemenu/active/{venue_id}`) exist as concepts (this venue has one dine menu, "Starter", with no sub-categories) but aren't used by the merge above — for a venue with many items, grouping by dine menu/category before presenting them in a call would likely be worth adding once there's a venue with enough items to make flat presentation unwieldy.

### Order creation — chain mapped and mostly confirmed live; blocked only on test data

Creating an order on the real direct API is a multi-step checkout flow. All of the following was confirmed by live trial-and-error against `https://testapiv2.themozo.net` (venue 13), not guessed from docs — **the OpenAPI spec (`mock-servers/mozo-openapi-spec.reference.json`) turned out to be wrong/stale for one of these endpoints (step 2), so treat it as a starting hint, not ground truth; the real server's validation error messages are what actually resolved each step.**

1. **`GET /v4/entity/dineset/all/{venue_id}`** — confirmed. Returns the venue's dinesets and their parts. For venue 13: one dineset (`id:3`, entity_id 15), one part `dineset_parts[0] = {id:3, entity_id:16, url:"c91a21870982", ...}`.
2. **`POST /v4/process/guest-session/create`** — confirmed. Body: `{venue:{entity_id:"13"}, dineset_part:{origin_id:"3"}, sentry_id:"<any string, e.g. a uuid>"}`. Note `origin_id` is the dineset_part's internal `id` (`3`), **not** its `entity_id` (`16`) — confirmed by trial (both `16` and the `url` value failed with "Dine set part not found ... for id: X" until `3` was tried). Response: `{"guest_session":{"id":"3"},"guest_record":{"id":"1"}}` — this single call produces **both** the guest_session and guest_record ids; the separately-documented `POST /v4/process/guest-record/start` was never needed.
3. **`POST /v4/process/checkout-session/start`** — confirmed, but **the OpenAPI spec's documented body for this endpoint is wrong**. The real required body (found via the server's own validation errors) is `{guest_session:{id}, guest_record:{id}, venue:{entity_id}, status:"CREATED", sentry_id}` — a status-action-machine envelope (`status` has ~30 other enum values for later actions like `ADD_TO_BASKET`, `ADD_TIP`, etc., not just `"CREATED"`), not the flatter `{guest_record, type, articles, amount}` shape the spec describes. Response: `{"checkout_record_id":"1","checkout_session_id":"1"}`.
4. **`POST /v4/process/checkout-session/add-article`** — schema confirmed correct as documented (`{checkout_session_id, article:{id, quantity, price?, note?, option_ids?}}`) — tested with a fake article id and got back a clean `"article not found: 999999"`, i.e. the request shape itself was accepted. **Not fully exercisable**: venue 13 has zero catalog articles configured (`GET /mozo/menu` → `[]`), so there is no real `article.id` to add yet. This is a test-data gap, not a knowledge gap — populate a menu item for this venue in Mozo's admin panel (`https://testadmin.themozo.net`) to unblock.
5. **`POST /v4/process/checkout-session/complete`** and **`POST /v4/process/checkout-session/start-order-session`** (or equivalently `POST /v4/process/order/create-for-checkout`) — not yet exercised live, blocked by step 4. Expected to need `checkout_session_id`/`checkout_session:{id}` plus whatever `total_order_value`/`amount` the basket adds up to, per the spec, but given step 3's spec-vs-reality mismatch, **treat this as unconfirmed until tested**, not assumed correct.

`MozoApiService.createOrder()`/`updateOrderStatus()` still throw rather than implement this — steps 1–3 are confirmed and safe to wire up, but stopping the flow there would create real, orphaned guest-sessions/checkout-sessions on Mozo's side on every attempt without ever completing an order, which isn't worth doing until step 4 can be tested against a real catalog item. The flow tool `flows/flow-tools/mozo-order.tool.ts` (`mozo_create_order`) calls `createOrder()` and already handles a thrown error by returning `{ok:false, error, message}` into the conversation flow, so this fails gracefully rather than crashing a live call.

**Next step to fully unblock this**: get at least one catalog article configured for venue 13 (via Mozo's test admin panel), then live-test steps 4–5 the same way steps 1–3 were resolved — send a minimal/best-guess body and let the server's own validation errors correct it.

## Known gaps

**Direct API (`MozoApiService` — menu/orders/venue): confirmed live**, not just mechanically mocked. `getVenue()`, `getMenu()`, and `getOrders()` were called end-to-end (standalone NestJS app context, real DI-wired `MozoApiService`, real `.env` config, and again through the actual `/mozo/*` HTTP routes) against `https://testapiv2.themozo.net` and returned real HTTP 200 responses. `createOrder()`/`updateOrderStatus()` are honestly not implemented — the prerequisite chain (guest-session → checkout-session start) is now confirmed live, but the final add-article/complete/start-order-session steps can't be exercised until venue 13 has at least one real catalog article — see "Order creation" above for the full, code-free trail.

Everything below is about the **App Store marketplace** flow (iframe verification, webhooks, `POST /mozo/auth/token`), which is a separate, still-unconfirmed product — see "Two different Mozo APIs" at the top. It was proven mechanically against `mock-servers/mozo-mock-server.js`, built strictly from three docs (`app-store-quickstart.md`, `app-store-webhooks.md`, `app-store-beta-contract.md`), but **never against a real server** — the real host for this product is unknown (every `/v4/app-store/*` path 404s on the direct API's test host):

- **Mozo iframe session verification is signature-only, not claim-checked.** `MozoIframeSessionGuard` verifies `/mozo/hexaai/activity` and `/mozo/hexaai/embed-session` callers present a genuine, unexpired, RS256-signed JWT from Mozo's published key (`GET /v4/app-store/auth/public-key`, fetched/cached by `MozoPublicKeyService`) — confirmed working against the mock's own signed tokens only. It does **not** check any claims beyond the signature — e.g. that the token's venue matches `MOZO_SINGLE_TENANT_VENUE_ID`, or that a host-origin claim matches the calling origin — because `app-store-iframe-sessions.md` (the doc with the exact claim shape) isn't available yet. Also unconfirmed: whether this flow is even how the real Mozo iframe embed actually authenticates, given the App Store marketplace product's real behavior is otherwise unverified.
- **`GET /v4/app-store/auth/public-key`'s response shape is unconfirmed against a real server** — `MozoPublicKeyService` defensively accepts either a JSON field (`public_key`/`publicKey`/`key`) or a raw PEM text body; the mock returns the JSON-field form, which is why that path is the one actually exercised so far.
- **`MozoVenueLinkService` / `mozo_venue_links` / `POST /mozo/hexaai/connect` are dead code** — see "Why single-tenant" above. Candidate for removal.
- **`MozoTokenService`'s token-exchange parsing was fixed once already** (originally read the response as nested under `.data`; the real shape per `app-store-quickstart.md` is flat) but this is only confirmed against the mock, built from the same doc that caused the original bug — not proof a real App Store server matches. `MOZO_CLIENT_ID`/`SECRET` are still blank in `.env`; nobody has run the "Getting real credentials" steps for this product.
- **`scripts/mozo-onboarding.js`'s field extraction is guessed for the same reason**, and additionally now targets a product whose real base URL is unknown — treat this script as unvalidated until that's resolved.

## Local testing

### Direct API (menu/orders/venue) — against the real test server

`.env` already has real test credentials (`MOZO_DIRECT_API_URL`, `MOZO_DEVELOPER_AUTH_KEY`) — no mock needed for this part, and using the mock would defeat the purpose (the whole reason this got reworked is that the old mock encoded the wrong API's shape). Restart the backend after `.env` changes, then pass whichever venue you want to read via `venue_id`:

```bash
curl "http://localhost:8085/mozo/venue?venue_id=13"    # → real venue 13 ("BORK") data
curl "http://localhost:8085/mozo/menu?venue_id=13"     # → [] — real endpoint, test venue has no catalog configured
curl "http://localhost:8085/mozo/orders?venue_id=13"   # → [] — real endpoint, test venue has no orders yet
curl "http://localhost:8085/mozo/venue?venue_id=28"    # → real venue 28 ("MRWINSTON") data — different venue, same call shape
curl -X POST http://localhost:8085/mozo/orders -H "Content-Type: application/json" -d '{}'
# → 502, message starts with "Mozo order creation requires a multi-step checkout-session +
#   dineset_part + guest_record flow that is not yet wired up" — expected, see "Order creation" above

curl http://localhost:8085/mozo/menu    # → 400 {"error":"venue_id is required"} — venue_id is mandatory now
```

To poke at the direct API directly (bypassing our backend), same key works against any documented path:

```bash
curl -s "https://testapiv2.themozo.net/v4/entity/venue/13" -H "X-API-Key: $MOZO_DEVELOPER_AUTH_KEY"
curl -s "https://testapiv2.themozo.net/v4/entity/dineset/all/13" -H "X-API-Key: $MOZO_DEVELOPER_AUTH_KEY"
```

The full 722-endpoint OpenAPI spec (extracted from the test server's own `/api-docs/swagger-ui-init.js`) is saved at `mock-servers/mozo-openapi-spec.reference.json` — check it before guessing any new endpoint's request/response shape.

### Against the mock Mozo server — App Store marketplace flow only (no real credentials needed)

The mock now only represents the **App Store marketplace** product (iframe auth, webhooks, `POST /mozo/auth/token`) — it does not simulate the direct API above, since real credentials for that exist and should be used instead.

`mock-servers/mozo-mock-server.js` is a local stand-in for Mozo's API, built strictly from the three docs we have (`app-store-quickstart.md`, `app-store-webhooks.md`, `app-store-beta-contract.md`) — token exchange, menu, orders (read/create/status), venue, and the public-key endpoint used by `MozoIframeSessionGuard`. It's how this module's whole pipeline was actually proven to work end-to-end before any real Mozo credentials existed. It is **not** a substitute for testing against real Mozo — it validates our code's handling of the documented shapes, not what Mozo's server does differently from its own docs.

```bash
npm run mozo:mock   # → http://localhost:4000, logs MOZO_CLIENT_ID/SECRET it expects

# .env: MOZO_API_URL=http://localhost:4000, MOZO_CLIENT_ID=mock_client_id,
# MOZO_CLIENT_SECRET=mock_client_secret
# (restart the backend after setting these — ConfigModule reads env vars once at boot)
# Note: MOZO_DIRECT_API_URL/MOZO_DEVELOPER_AUTH_KEY are separate and unaffected by this —
# /mozo/menu, /mozo/orders, /mozo/venue always go to the real direct API regardless, per
# "Direct API" above, not to this mock.

curl -X POST http://localhost:8085/mozo/auth/token -d '{"venue_id":"mock-venue"}' \
  -H "Content-Type: application/json"    # real round-trip through the mock's App Store OAuth

# MozoIframeSessionGuard needs a real signed token — the mock has a test-only helper for that:
TOKEN=$(curl -s "http://localhost:4000/_mock/iframe-session-token?venue_id=mock-venue" | jq -r .token)
curl "http://localhost:8085/mozo/hexaai/activity?limit=5" -H "Authorization: Bearer $TOKEN"

# Round-trip a real signed webhook delivery into our receiver:
curl -X POST http://localhost:4000/_mock/send-webhook -H "Content-Type: application/json" -d \
  "{\"receiver_url\":\"http://localhost:8085/mozo/webhooks/mozo\",\"event_type\":\"order.created\",\"signing_secret\":\"$MOZO_WEBHOOK_SECRET\"}"
```

### Everything else

```bash
curl http://localhost:8085/mozo/healthz

# Mint an embedded session (needs MOZO_BRIDGE_SHARED_SECRET + MOZO_SINGLE_TENANT_COMPANY_ID)
curl -X POST http://localhost:8085/auth/embedded-session \
  -H "X-Mozo-Bridge-Secret: $MOZO_BRIDGE_SHARED_SECRET"
```

## Related files

- `app/src/auth/auth.controller.ts`, `auth.service.ts` — `POST /auth/embedded-session`, `embeddedSession()`, the synthetic `embedded-session+<companyId>@...` user
- `app/src/auth/guards/embedded-session-rate-limit.guard.ts` — per-IP rate limit on `/auth/embedded-session`
- `app/src/mozo/guards/mozo-bridge-secret.guard.ts` — the `X-Mozo-Bridge-Secret` check
- `app/src/mozo/guards/mozo-iframe-session.guard.ts`, `app/src/mozo/services/mozo-public-key.service.ts` — Mozo iframe session token verification (signature-only, see Known gaps)
- `app/src/main.ts` — path-aware CORS delegate (`/mozo/*` gets `MOZO_ALLOWED_ORIGINS`, everything else keeps the existing frontend origin list)
- `app/src/models/mozo/mozo-venue-link.entity.ts`, `app/src/migrations/create-mozo-venue-links-table.sql` — dead code, see "Why single-tenant"
- `app/mock-servers/mozo-mock-server.js` (`npm run mozo:mock`) — local stand-in for the **App Store marketplace** flow only (token exchange, iframe public key, webhooks); does not simulate the direct venue API
- `app/mock-servers/mozo-openapi-spec.reference.json` — the real direct API's full OpenAPI spec (722 paths), extracted from `https://testapiv2.themozo.net/api-docs/swagger-ui-init.js`. The source of truth for any endpoint's real request/response shape — check here before guessing.
- `app/scripts/mozo-onboarding.js` (`npm run mozo:onboard`) — runs the App Store developer onboarding sequence (developer profile → app → scopes → credential rotation → install → review); targets a product whose real base URL is still unknown, so treat as unvalidated
- HexaAI-FE `src/app/mozo-embed/route.ts` — receives the `embedUrl` token, sets the session cookie, redirects into the real app
- HexaAI-FE `mozo-widget/` — the original standalone widget/backend reference this module superseded; still useful as the widget frontend reference, but its own `backend/` is no longer what's deployed
