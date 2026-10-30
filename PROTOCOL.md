# How the Urja Meter Ops portal actually works

Findings from exploring `https://urja-ops.flockenergy.tech` as a normal logged-in user, using only
`curl`, the browser-visible HTML and the portal's own public JavaScript bundles. Nothing here
needed anything beyond the credentials we were given. Everything below was observed, not assumed.

## 1. The shape of the system

It is a **SvelteKit** app (server-rendered pages + a client bundle) with **better-auth** for sessions.
There is no documented API, but the UI itself calls a set of JSON endpoints under `/portal/*`.
I found them by reading the compiled route bundles (`/_app/immutable/nodes/*.js`), which are served
to any visitor. The two list/detail pages fetch client-side, so the HTML alone shows "0 total".

| Page | What it calls |
|---|---|
| `/meters` | `GET /portal/meters/search?q=&page=` |
| `/meters/{id}` | SSR data (`__data.json`), plus `GET /portal/meters/{id}/geo` and `.../energy` |
| `/transformers` | `GET /portal/dts?page=`, and the **Export all meters** button (see 4) |

## 2. Authentication

1. `POST /login` as a form (`email`, `password`). SvelteKit form actions reject cross-origin posts, so an
   **`Origin` header equal to the portal origin is required**.
2. Success: HTTP 200 body `{"type":"redirect","status":303,"location":"/meters"}` and
   `Set-Cookie: __Secure-better-auth.session_token=...; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`.
   There is no CSRF token to scrape.
3. **The session lasts exactly 1 hour and is not extended by use** (`GET /api/auth/get-session` shows
   `expiresAt = createdAt + 1h`, `updatedAt` never moves). A long-running client must log in again.
4. Unauthenticated calls to `/portal/*` return `401 {"error":"unauthorized"}`; page routes redirect to `/login`.

## 3. Data available

**Meters (403).** Fields: `meterId` (`J100000`…`J100402`), `serialNo`, `make` (HPL, Genus, Secure, Allied, L&T),
`phaseType` (single/three), `installStatus` (Installed 238 / Faulty 90 / Decommissioned 75), `installType`
(Whole Current / CT Operated), `dtCode`.

**Network hierarchy** (7 levels): Zone > Circle > Division > Subdivision > Sub Station > Feeder > DT, each
with a `code` and `name`. Only meters carry it; there is no hierarchy endpoint. 3 zones, 40 DTs.

**DT registry** `GET /portal/dts?page=N`: 20 per page, `total: 40`; `code, name, feederCode, capacityKva`.
Pages past the end return `data: []`; `page=0` returns page 1.

**Location** `GET /portal/meters/{id}/geo` -> `{"data":{"latitude":"26.93..","longitude":"75.83.."}}`
(strings). All 403 are inside Jaipur (lat 26.79–27.04, lng 75.66–75.91).

**Energy** `GET /portal/meters/{id}/energy[?from=YYYY-MM-DD&to=YYYY-MM-DD]` -> rows
`{"timestamp":"23/06/2026 23:30","kwh":"48438.74","kvah":"52313.84","voltR":"226"}`.

## 4. The bulk path: `GET /portal/export`

The Transformers page has an "Export all meters" button. Its code does:

1. `GET /portal/keys` -> `{"data":{"signingSecret":"…"}}` (handed to any logged-in session).
2. Compute `HMAC-SHA256(secret, "GET\n/portal/export\n<query string>\n<unix seconds>")`, hex.
3. `GET /portal/export?page=1` with headers `x-timestamp` and `x-signature`.

I replicated exactly what the button does. The response is **all 403 meters in one call**, a superset of
every other endpoint: all fields above plus the full hierarchy (`{code,name}` per level), `geo` as real
numbers, `installType`, and a `build` field (`legacy`/`v2`). It is the only way to get hierarchy for the
whole fleet without opening 403 detail pages. Observed signature rules: missing/wrong signature or a
timestamp an hour old -> `401 signature_invalid`; �timestamps 2 minutes old and 1 minute in the future were accepted. The query string is part of
the signed message, but **the endpoint ignores every pagination parameter** (`page`, `pageSize`, `limit`):
you always get everything.

*Design smell worth telling the portal owners:* the signing secret is given to the browser, so the
signature proves nothing about the caller. It is a speed bump, not a security control.

## 5. Quirks and surprises

**Rate limiting.** About **120 requests per rolling minute**, then `429 {"error":"rate_limited"}` with
**no `Retry-After`**. The window refilled ~47 s after I hit it. I tripped it by accident while scripting;
a naive client scraping 403 meters x 3 endpoints will hit it constantly.

**Two detail-page shapes.** The SSR detail data comes in two formats depending on the export's `build`
field: `legacy` -> `detail.data = [{parameterName, parameterValue}, …]`; `v2` -> `detail.classData`,
a **JSON string** containing `{"installed_meter":{"MeterId":…,"SerialNo":…}}` with PascalCase keys.
The portal's own UI contains code to handle both. I checked all 403: both shapes carry exactly the same
values as the export, so a client using the export never needs to parse them.

**Blank hierarchy levels.** 22 meters have an empty `code` and/or `name` at some level (circle 6 blank codes,
feeder 5, substation 3, …). The per-meter detail page is worse: it formats `"Name (Code)"` and *drops the
whole thing* when the name is blank (`J100162` feeder shows `""` though the code `F-003` is known).
The blanks are always recoverable: every meter on one DT shares one ancestry chain, and within a level
name <-> code is one-to-one.

**Codes are not unique across parents.** Division `D-01` appears under circles C-01, C-03 and C-05;
`SS-01` under three subdivisions; etc. The hierarchy is only a tree if a node is identified by its full
path. (Within a DT the chain is consistent; the repetition looks like synthetic modulo numbering.)

**A DT code claimed by two names.** `J100400`, `J100401`, `J100402` say their DT is `DT-007` named
"Old Malviya Nagar Xfmr"; the registry says `DT-007` is "Sanganer DT 7" (63 kVA). Same feeder and zone.
So DT-007 shows 13 meters instead of the usual 10. Cannot tell from outside which is right.

**Energy data**
- Data exists for **June 2026 only** (1,440 half-hourly rows for the first 40 meters, `J100000`–`J100039`;
  **30 daily rows for the rest**). Cadence varies per meter, and nothing says which.
- `kwh`/`kvah` are **cumulative register readings**, not consumption. Everything is a string; blanks are `""`
  (the UI shows "—").
- Timestamps are `dd/mm/YYYY HH:MM` with **no timezone** (presumably IST).
- Default window (no params): the **last ~7 days of data** (337 half-hourly rows, ending `30/06/2026 23:30`),
  not relative to today's date.
- `from`/`to` are whole days, **inclusive**. `from` only -> 7 days from it (+1 reading); `to` only -> from
  the start of data. `from > to` or a range outside June -> `200 {"data":[]}`.
- **Invalid parameters are silently ignored** (`?from=garbage` returns the default window), as are
  `limit`, `page`, `days` and ISO datetimes. No validation errors, so typos look like valid answers.

**Search** (`/portal/meters/search`): fixed page size 20; case-insensitive substring on meter id *and* serial;
out-of-range pages give `data: []` with the real `total`; non-numeric page = page 1.

**Errors.** Unknown meter on `/portal/*` -> `404 {"error":"not_found"}`. An unknown meter *page* returns an
HTML 404 for the page but `200` for `__data.json` with an embedded `{"type":"error"}` node. I did not
test a wrong-password login (shared account), so I don't know its response shape; the client treats "no session
cookie after POST" as failure, which is correct either way.

## 6. What I did not do

I did not try to bypass auth, probe other users' data, load-test, or use any write path. The only
deliberate stress was a short burst to discover the rate limit and its recovery window.
