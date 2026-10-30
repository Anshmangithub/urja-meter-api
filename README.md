# Urja Meter API

A clean, read-only REST API in front of the legacy **Urja Meter Ops** portal, plus a small map UI.
Node.js 20+ · TypeScript · Express · axios · zod.

| Where | What |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | How the portal works under the hood: auth, hidden endpoints, signed bulk export, quirks. **Start here to understand the portal.** |
| [openapi.json](openapi.json) | OpenAPI 3.1 description of *this* API. Generated from the code (see below); a test fails if it goes stale. |
| `/docs` | Interactive Swagger UI, served by the running service. |
| `/ui/` | The optional web client: map of all meters, status filter, consumption chart. |

## What it does

The portal has no API, but its web UI calls hidden JSON endpoints, including a **signed bulk export** that returns the
entire fleet (meters + hierarchy + coordinates) in one request. The service:

* logs in as a normal user and keeps the 1-hour session alive (re-login on expiry);
* builds an in-memory **snapshot** of the fleet from the bulk export + DT registry (5 portal requests), refreshed in the background;
* serves meters, filtering, "what's near here?", the network hierarchy as a tree, transformers and a data-quality report from that snapshot, so these cost the portal nothing;
* fetches **consumption** live per meter (no bulk path exists for it), parses it into proper types and derives per-interval kWh;
* stays under the portal's rate limit, retries transient failures, and keeps serving the last good data if the portal goes down.

```
client ─► Express (app.ts) ─► routes.ts ─► Gateway ─► Snapshot cache (SWR) ─► buildSnapshot()  ◄─ export + dts
                                                  └─► Energy cache (TTL)   ─► buildConsumption() ◄─ energy
                                                          both via ► PortalClient (axios · login · HMAC signing · rate limiter · retries)
```

| File | Responsibility |
|---|---|
| `src/portal.ts` | Everything about *how the portal works*: login, cookie, signing, pacing, retries. The only file that imports axios. |
| `src/ratelimit.ts`, `src/cache.ts` | Sliding-window limiter; async cache with single-flight, stale-while-revalidate, stale-if-error. |
| `src/snapshot.ts` | Raw export → clean models; hierarchy repair; tree; search; nearby. |
| `src/energy.ts` | Readings: strings → numbers, timestamps with offset, deltas, cadence, gaps, resets. |
| `src/models.ts` | **zod schemas**: the response contract. They give the TypeScript types *and* the OpenAPI schemas. |
| `src/routes.ts`, `src/openapi.ts`, `src/app.ts` | Route table (query + response schemas + handler), OpenAPI generator, Express wiring and error mapping. |

Each route is declared once in `routes.ts`. Express mounts it, validates its query with the same zod schema, and `openapi.ts`
documents it from that same definition, so **docs, validation and types cannot drift apart**.

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env        # credentials are pre-filled with the ones from the brief
npm start                   # http://127.0.0.1:8000   (npm run dev = auto-reload)
```

Production-style: `npm run build && npm run serve`.
Open <http://127.0.0.1:8000/docs> (API) or <http://127.0.0.1:8000/ui/> (map). The first request may wait a second or two
while the snapshot loads.

Settings are `URJA_*` environment variables or `.env`: `PORTAL_EMAIL`/`PORTAL_PASSWORD` (required), `PORTAL_BASE_URL`,
`PORT` (8000), `SNAPSHOT_TTL_S` (900), `ENERGY_TTL_S` (600), `RATE_LIMIT_PER_MIN` (100); the rest are in `src/config.ts`.
Invalid configuration fails at startup with a readable message.

```bash
npm test                    # 48 tests, no network (the portal is faked)
npm run typecheck
npm run openapi             # regenerate openapi.json after changing the API
```

### Sample requests

```bash
# Faulty L&T meters on one transformer
curl 'localhost:8000/meters?status=faulty&make=l%26t&dt=DT-011'

# Meters within 1 km of a point, nearest first
curl 'localhost:8000/meters/nearby?lat=26.91&lng=75.79&radius_km=1'

# One day of readings with derived per-interval consumption
curl 'localhost:8000/meters/J100000/consumption?from=2026-06-10&to=2026-06-10'

# Hierarchy two levels deep; then every meter under one node
curl 'localhost:8000/hierarchy?max_depth=2'
curl 'localhost:8000/meters?path=Z-01/C-01/D-07'

curl localhost:8000/data-quality     # what's wrong in the portal's data and what we did about it
```

```jsonc
// GET /meters/J100004
{ "id": "J100004", "serial_no": "SE65293", "make": "Genus", "phase_type": "single",
  "install_status": "faulty", "install_type": "ct_operated", "dt_code": "DT-005",
  "hierarchy": { "zone": {"code":"Z-02","name":"Jaipur Zone 2"}, /* … */ "dt": {"code":"DT-005","name":"Bani Park DT 5"},
                 "path": "Z-02/C-05/D-05/SD-05/SS-05/F-005/DT-005" },
  "location": { "lat": 26.9074, "lng": 75.7250 }, "quality_flags": [] }
```

## Endpoints

`GET /meters` (search, filters, pagination) · `/meters/nearby` · `/meters/{id}` · `/meters/{id}/consumption` ·
`/hierarchy` · `/transformers` · `/transformers/{code}` · `/data-quality` · `/health` · `POST /admin/refresh`.
Errors are always `{"error": "...", "message": "..."}`. Portal outages are `503` + `Retry-After`; unexpected portal
behaviour or a rejected login is `502`.

## Assumptions

1. **The bulk export is the source of truth for the fleet.** I compared it with the search endpoint, all 403 per-meter detail pages and the DT registry: identical values, and the export has strictly more.
2. **Portal timestamps are IST (+05:30).** They carry no timezone; the utility is in Jaipur. Configurable (`URJA_PORTAL_UTC_OFFSET_MINUTES`).
3. **`kwh`/`kvah` are cumulative registers**, since they only ever increase in small steps. I expose the raw register and a derived `kwh_delta`.
4. **The DT registry is authoritative for DT names** (this decides the `DT-007` conflict).
5. A blank hierarchy value means *missing*, not "intentionally absent at this level".
6. One service account is enough; as far as I can see every portal user gets the same data.

## Design decisions and trade-offs

* **Bulk export over scraping.** One signed request instead of ~1,200 (403 meters × detail+geo+search); it also sidesteps the rate limit and the two detail-page formats. Trade-off: it depends on an undocumented signing scheme. If that changes, the client raises a clear `502`, and PROTOCOL.md describes the fallback.
* **In-memory snapshot, not a database.** 403 meters is ~200 KB. Queries are a linear scan and "nearby" is haversine over all rows: no infrastructure, exact answers. See *scale* below.
* **Freshness.** Fleet data: TTL 15 min with **stale-while-revalidate** (users never wait on a refresh) and **stale-if-error** (a portal outage doesn't become ours). Every response carries `X-Snapshot-Age`, and `/health` reports the last refresh error. Readings: 10 min TTL per `(meter, from, to)`, **single-flight** so a burst of identical requests costs one portal call, LRU-bounded at 256 entries. `POST /admin/refresh` forces a reload.
* **Repair, but never silently.** Blank hierarchy levels are filled from other meters on the same DT (safe because every DT has one ancestry chain and name↔code is 1:1). Every repaired or conflicting meter gets a `quality_flags` entry and a line in `/data-quality`. Unresolvable blanks stay `null` rather than guessed. A record that fails validation is skipped and reported, never fatal.
* **Hierarchy nodes are identified by path, not code**, because codes repeat under different parents. Hence `path` and `GET /meters?path=`. The per-level code filters remain and return the union across parents.
* **Stricter than the portal.** The portal silently ignores bad query parameters. This API returns `422` for a bad or impossible date, or `from > to`, because quietly answering a different question is the worst failure for a data consumer.
* **Rate limiting is proactive.** A sliding window at 100/min (portal: ~120) queues calls up to 20 s, then answers `503` + `Retry-After` instead of hanging. If a 429 happens anyway, the client backs off for seconds (the portal sends no `Retry-After`).
* **Normalised contract.** snake_case, lower-case enum slugs, ISO timestamps with offset, numbers as numbers.
* **No cookie-jar library.** The portal uses exactly one cookie, so `portal.ts` handles it directly (about ten lines) rather than adding a dependency.
* **Unknown meter ids are rejected from the snapshot** with no portal call.

### Where the approach starts to struggle
The linear scan and in-memory snapshot are fine to roughly **10⁵ meters** (tens of MB, millisecond scans). Beyond that I'd move to SQLite/Postgres (+PostGIS or an R-tree for `nearby`) with indexed filters. The first real limit is earlier though: the **export is all-or-nothing** (it ignores pagination), so at ~10⁵ meters every refresh is a multi-MB download; I'd lengthen the TTL or ask for an incremental feed. Readings scale worse: per-meter live calls on a 120/min budget is at most ~7,000 meters/hour, so fleet-wide analytics need a persisted readings store filled by a background crawler.

## What I intentionally skipped

* **Persistence / a database**, and **fleet-wide readings analytics**. Not needed for the requested API; see above.
* **Authentication on this API.** It is a local service in front of a read-only portal; I'd put it behind the company gateway rather than reinvent auth. Don't expose it to the internet as-is.
* **Scraping the per-meter detail pages** (SSR `__data.json`, two formats). Fully covered by the export; documented in PROTOCOL.md.
* **A daily/hourly aggregation endpoint** (the UI rolls half-hourly data up client-side) and **anomaly detection** beyond gaps, resets and missing values.
* **A live-portal contract test in CI.** Tests run against a fake that mirrors the observed rules.
* UI polish; it is one static file with no build step.

## What I'd do with more time

1. A background job that persists readings (SQLite) so history, daily aggregates and fleet analytics don't spend the portal's rate budget.
2. A scheduled **contract check** against the live portal (catches signing/shape changes before users do) and metrics for portal latency, 429s and cache hit rate.
3. Raise the `DT-007` conflict and the blank hierarchy levels with the portal owners; fixing them at the source beats repairing them here.
4. Anomaly views (voltage excursions, flat registers on "Installed" meters, "Decommissioned" meters that still report); the data hints at all three.
5. Cursor pagination and ETag / `If-None-Match`.

## Reflection

**Assumptions.** Listed above. The riskiest are the IST timezone and trusting the DT registry over the meter-side name; both are surfaced in the API rather than buried.

**Hardest part.** Finding the export. Nothing links to it from the list pages; the clue was the "Export all meters" button's compiled code, which fetches a secret and HMAC-signs a request. Reading the route bundles (they're public) was the unlock, and I replicated that flow exactly instead of guessing. The second hardest was deciding which inconsistencies were genuine data problems (blank levels, the `DT-007` clash) and which were my misunderstanding (codes repeating across parents is how the data is built, not corruption).

**With another day.** The persisted readings store and anomaly views above, plus a live contract test.

**A mistake I made.** While mapping the energy endpoint I fired a few hundred requests in a tight loop and hit the portal's rate limit. At first I read the failures as bugs in my own script (it crashed on a missing `data` key, and even the session-cookie call failed). That cost time, but it became a finding (limit and recovery window) that shaped the client. Separately, I once tried to stop my dev server with a blanket "kill every Python process", which was far too broad and was blocked; I then stopped only the process listening on my port. And I had written in PROTOCOL.md how the portal answers a *wrong password* before ever testing it; I caught that in review and replaced it with what I actually know.

**What I'd criticise in this submission.** Consumption is the weakest part: it is live, per-meter and bounded by a 120/min budget, so it can't answer fleet-level questions. The test fake is modelled on my own observations, so if I misread a rule, the code and tests are wrong together; only a live contract test would catch that. The web UI was verified by exercising the API it calls, not by driving a browser, so its rendering is unverified. And hierarchy repair, though conservative, is still an inference about data the owners should fix, which is why every record it touches is flagged.
