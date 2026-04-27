# Merge Guide — for the dev (and AI assistant) merging this fork

This document is written for whoever is bringing the changes in this fork
back into a sibling branch / repo, including any AI assistant helping with
that merge. Read this before touching `git merge` so you understand the
shape and intent of every change.

The companion file [`../CHANGELOG.md`](../CHANGELOG.md) lists every file
touched and why; this guide is the **how to merge it safely** layer on top.

---

## TL;DR

Six pieces of work, all additive — no breaking API or schema changes.

1. **Contact-vs-Lead differentiator** — every CRM → Marketo Person sync stamps `crmEntityType` + `crmContactId` / `crmLeadId` on the Marketo record. Powered by a new `literal` field-mapper type. Logs filter chip + SyncView Type badge in the SPA.
2. **"Sync with Company" bundle button** — operator-triggered multi-row sequential push from CRM. Reads each selected Contact/Lead, resolves their Account, **merges Account fields onto the Person body** (so the Marketo Person record carries company / billingCity / industry / etc. even when the standalone Companies endpoint isn't called).
3. **"Unsubscribe & Sync" bundle button** — operator-triggered, Marketo-side: PATCHes selected Marketo Persons to `unsubscribed=true`, then runs the same path a webhook would, ending with `donotbulkemail=true` on the matching Dynamics Contact. Result modal shows step-by-step Marketo / Dynamics outcomes + a "Show JSON" toggle.
4. **In-SPA Marketo schema bootstrap** — banner on SyncView when the three custom fields aren't yet defined in Marketo, with a one-click "Set up Marketo fields" button. Falls back gracefully to a manual-setup panel when Marketo returns access-denied (error 603).
5. **Lead-schema auto-filter** — writer fetches `/leads/describe.json` once per hour, drops payload keys not in the schema with a one-time WARN. So a fresh tenant where the operator hasn't created `crmEntityType` yet still gets a successful Lead push (those fields are silently stripped).
6. **Account → Company mapping expansion** — 10 standard Marketo Company fields added (billing address, industry, revenue, employees, website, mainPhone). Uses Marketo's built-in Companies API — no ABM, no custom object.

Plus a graceful-unavailability handler for tenants without the Marketo Companies endpoint, an `/api/simulate/unsubscribe` endpoint for ad-hoc testing, and a smoke runner that proves every flow without external systems.

All changes pass `npx eslint src` (clean), `npx jest tests/unit tests/integration`
(**895/895**), `cd web && npm run build` (clean), and `npm run smoke` (10/10 scenarios).

---

## File map — what's new vs what's modified

### New files (drop-in — no merge conflict possible)

| Path | Purpose |
|---|---|
| `src/engine/bundleSync.js` | Engine helper for the **Sync with Company** bundle flow. Exports `previewBundle`, `runBundle`, `resolveAssociatedCompany`, `mergeAccountFieldsOntoPerson`, `REASON_CRITERION`, `VALID_ENTITIES`. |
| `src/engine/unsubscribeBundle.js` | Engine helper for the **Unsubscribe & Sync** combined flow. Exports `runUnsubscribeAndSync({ sourceIds, mktToken })`. |
| `src/auth/marketoSchema.js` | Single source of truth for the Marketo Lead schema bootstrap helpers — `REQUIRED_LEAD_FIELDS`, `fetchLeadSchemaFields`, `getSchemaStatus`, `createCustomFields`. Used by writers/marketo.js, routes/marketoSetup.js and the CLI script. |
| `src/routes/marketoSetup.js` | `GET /api/marketo/schema-status` + `POST /api/marketo/setup-custom-fields`. The latter detects Marketo error 603 and returns a structured `manualSetup` payload. |
| `src/routes/simulate.js` | `POST /api/simulate/unsubscribe` — single-record trigger for testing the unsubscribe path without a Marketo Smart Campaign. |
| `scripts/marketo-create-custom-fields.js` | CLI parity with the SPA "Set up Marketo fields" button. Refactored to delegate to the shared helper. |
| `scripts/smoke.js` | Self-contained verbose simulator. `npm run smoke` runs 10 scenarios end-to-end with URL-routed mock HTTP, prints the actual bytes sent to Marketo / Dynamics, asserts the values. **Single best place to demonstrate the integration works.** |
| `tests/unit/bundleSync.test.js` | 22 unit tests for the bundle helper (incl. company-merge proof). |
| `tests/unit/routes.transferWithCompany.test.js` | 10 route-level tests for `/api/transfer/with-company`. |
| `tests/unit/marketoSchema.test.js` | 12 unit tests covering schema fetch + access-denied detection (Marketo error 603). |
| `tests/unit/writers.schemaFilter.test.js` | 5 unit tests proving the auto-filter drops unknown fields, keeps knowns, fail-opens on schema fetch errors, caches, and dedups WARNs. |
| `tests/integration/bundleSyncFlow.test.js` | 6 end-to-end HTTP→Marketo body tests through the route handler. |
| `tests/integration/marketoUnsubscribeFlow.test.js` | 5 webhook-to-PATCH integration tests. |
| `CHANGELOG.md` | Chronological change log. |
| `docs/MERGE_GUIDE.md` | This file. |
| `docs/MANUAL_TEST_PLAYBOOK.md` | Copy-pasteable manual-test recipes for both flows. |

### Modified files (likely merge hot-spots)

Listed by likelihood of conflict in your sibling branch.

| Path | Change | Conflict likelihood | Notes |
|---|---|---|---|
| `src/config/fieldmap.json` | Added: 4 entity-type signal entries (`crmEntityType`/`crmContactId`/`crmLeadId` on contact + lead) + 10 Account-expansion entries on account + `company` field on contact (derived) AND lead (text). | **High** | Pure JSON additions inside existing entity blocks. If your branch also touched these blocks, expect line-level conflicts. Schema is forwards-compatible — keep both sides' new entries. |
| `src/engine/fieldMapper.js` | Added a `literal` branch in `mapToMarketo` + `mapToMarketoAsync`. Updated docstring to list 7 types. | **Medium** | Both edits are inside existing `for ... of Object.entries(mapping)` loops, immediately after the `derived` skip. Safe alongside other branch additions. |
| `src/engine/derivedFields.js` | New `parentAccountName` derivation registered in `RESOLVERS`. | **Low** | Pure addition next to the existing `parentAccountType` / `primaryContactFlag`. |
| `src/engine/bundleSync.js` | (a) `mergeAccountFieldsOntoPerson` helper. (b) Live & preview paths now project the resolved Account through the account mapping and merge fields onto the Person body before push. (c) `resolveAssociatedCompany` downgrades unresolvable companies to `person-only` (only `source-record-not-found` remains a hard skip). | **Medium** | If your branch added other plan kinds, audit the skip vs person-only logic. |
| `src/readers/dynamics.js` | (a) Added `readDynamicsById` export. (b) Extended `SELECT_FIELDS.account` with `accountnumber` + `address1_line1`. | **Medium** | The new function appends before `module.exports`. **Note**: tenant-custom `ubt_*` fields are deliberately NOT in the `$select` — they crash the OData read with 400 in tenants without those columns. |
| `src/writers/marketo.js` | (a) Lead-schema fetcher with 1h cache + auto-filter. (b) Companies-endpoint-unavailable detection (404/405/610) → soft skip. (c) `readMarketoLeadById` + `markMarketoLeadUnsubscribed`. (d) Test seam exports `_resetLeadSchemaCache` + `_resetCompaniesEndpointFlag`. | **Medium** | Single largest writer change. Each block is self-contained and additive. |
| `src/routes/transfer.js` | Added bundle-sync routes (`/with-company`, `/with-company/preview`) AND the unsubscribe-and-sync route (`/unsubscribe-and-sync`). | **Medium** | Existing `POST /` route untouched. New routes appended before `module.exports`. |
| `src/routes/events.js` | Added `entityType` query param + `source_type` to SELECT in `GET /api/events`. | **Low** | Pure parameter + clause additions in one route. |
| `src/listeners/server.js` | Added router mounts for `/api/marketo`, `/api/simulate`, plus the existing `/api/transfer` (extended). | **Low** | Pure router-mount additions next to the existing block. |
| `web/src/lib/api.js` | Added `entityType` to `getEvents`; new exports: `previewBundleSync`, `runBundleSync`, `getMarketoSchemaStatus`, `setupMarketoCustomFields`, `simulateUnsubscribe`, `unsubscribeAndSync`. | **Low** | Pure additions. |
| `web/src/tabs/Logs.jsx` | Added `entityFilter` state + filter dropdown in the toolbar. SSE filter respects it. | **Medium** | Touches imports, state hooks, useEffect deps array, JSX toolbar. Watch `filtersRef.current` shape if your branch added other filters. |
| `web/src/tabs/SyncView.jsx` | Largest single file diff. Adds: `TypeBadge` per RecordCard; Marketo schema banner + setup state; simulate-unsubscribe panel; bundle-sync state + handlers; **3 new buttons in the arrow column** (Sync with Company, Unsubscribe & Sync, plus uniform sizing for the existing two); `BundleSyncModal` + `UnsubscribeBundleModal` + 6 sub-components after the main component. | **High** | Best merged hunk-by-hunk: imports → state hooks → buttons in the arrow column → top-of-page banners → modals at end. Each chunk is independent. |
| `web/src/styles.css` | Arrow column widened to 240px, gap 24px (so the 4 uniform buttons don't touch the side columns). | **Low** | Single rule update. |
| `tests/unit/fieldMapper.scoped.test.js` | Added `literal` to allowed types, updated 3 `toEqual` assertions, added 4 new `it(...)` blocks. | **Low** | Pure additions / assertion updates. |
| `tests/unit/fieldMapper.async.test.js` | One `toEqual` updated to include `crmEntityType: 'contact'`. | **Low** | One-line change. |
| `tests/unit/fieldDelta.test.js` | One mock snapshot updated to include `contactid` (real-world parity). | **Low** | One-line change. |
| `tests/unit/bundleSync.test.js` | Existing tests updated to reflect skip→person-only downgrade; 3 new tests covering the company-merge behaviour. | **Low** | Test-only change. |
| `docs/ARCHITECTURE.md` | New sections under existing ToC (Field mapper types, Entity-type signal, Manual bundle sync). Module map auto-block unchanged. | **Low** | Additions to the doc body. |
| `docs/PRODUCT_OVERVIEW.md` | Updated "At a glance" table, field mapping example, new "Manual Sync with Company bundle" section, Contact-vs-Lead explainer. | **Low** | Additions. |
| `package.json` | Added `npm run smoke` script. | **Low** | Single-line addition to `"scripts"`. |
| `README.md` | New "What's new in this fork" callout + "Quick start (no Docker, no Dapr)" section + Marketo setup notes. | **Low** | Sectional additions. |

### Files NOT touched

The following load-bearing files were intentionally left alone, so any
behavioural changes in them on the sibling branch do not need to be
reconciled with this work:

- `src/queue/worker.js`, `src/queue/queue.js`, `src/queue/dlq.js` — the
  queue + processJob pipeline is unchanged.
- `src/engine/loopGuard.js`, `src/engine/syncDirection.js`,
  `src/engine/dedup.js`, `src/engine/marketoAuthority.js`,
  `src/engine/leadEligibility.js`, `src/engine/personResolver.js`,
  `src/engine/personClassifier.js`, `src/engine/derivedFields.js`,
  `src/engine/optionSetResolver.js`, `src/engine/lookupResolver.js`,
  `src/engine/relationships.js`, `src/engine/handlers/*` — engine
  semantics are unchanged.
- `src/auth/*`, `src/listeners/*`, `src/audit/*`, `src/monitor/*`,
  `src/events/bus.js`, `src/webhooks/*`, `src/engagement/*`,
  `src/writers/*` — all unchanged.
- `db/schema.sql` and `db/migrations/*` — no DB schema changes.
  `reason_category` / `reason_criterion` columns already existed; this
  fork just writes new values into them (`'manual'` and
  `'manual:sync-with-company'`).

---

## Decision log (the why behind each change)

These match the popup-driven decisions made during planning. Useful when
the sibling branch's AI is reasoning about whether a given approach is
intentional.

### Piece 1 — Contact-vs-Lead differentiation

| Decision | Why |
|---|---|
| Send three fields (`crmEntityType` literal + `crmContactId`/`crmLeadId` IDs), not just one | Belt-and-braces — operators get a human-readable Smart List filter (`crmEntityType is "contact"`) AND programmatic ID-presence filters. |
| Field name `crmEntityType` | Matches the worker's internal `entityType` terminology. Values: `'contact'` \| `'lead'`. |
| Last sync wins on role transitions | Mirrors the rest of the system's authority model. No bookkeeping table needed. |
| Implement as a `literal` field-mapper type, not a stamp in the worker | Keeps the fieldmap as the single source of truth for what we send to Marketo. Adds a 6th allowed type symmetric with the existing five. |
| Backfill of existing Marketo Persons | **Skipped.** Existing Persons stay untagged until their next natural sync. No migration script. |

### Piece 2 — Bundle sync

| Decision | Why |
|---|---|
| Direction: D→M only | Per spec authority model, Marketo cannot create or update Accounts. Bundle sync is for pushing CRM data to Marketo, not the reverse. |
| Multi-row sequential | Avoids hitting Marketo's 100-req/20s rate bucket on large selections; keeps per-row error reporting clear. |
| Unresolvable company → **person-only** with `company` carried (NOT skip) | Earlier version skipped the row entirely; operator feedback made it clear that's the wrong default. The Person now syncs with the literal company name and Marketo dedups Company on its side. |
| `Person-only` when no company info exists at all | Graceful — legitimate case for a Lead without a known company. |
| **Merge resolved Account fields onto Person body before push** | Marketo's Lead schema accepts `company`, `industry`, `billing*`, etc. as Lead-level fields. Even when the standalone Companies endpoint isn't available, the Marketo Person record still reflects full company info. Person fields take precedence on conflict. |
| Confirmation: preview modal first, then commit | Operators see exactly what would be sent before any writes happen. |
| Account write failure does NOT abort the row's Person write | Marketo auto-creates the Company on the fly via `lead.company` dedup. Preserves the operator's intent in degraded conditions. |
| Continue on per-row failures, summarise at end | Consistent with the existing transfer button's behaviour. |
| Audit each leg with `reason_category='manual'`, `reason_criterion='manual:sync-with-company'` | Keeps manual syncs filterable and replayable. Reuses existing schema columns — no DB migration. |
| Two dedicated endpoints (`/preview` + live) | Clean separation, easy to test, easy to extend. |
| Preview is a UX path, not a server-enforced gate | The live endpoint accepts direct calls (Postman, future CLI) without a preview-token round-trip. |

### Piece 3 — Account mapping expansion

| Decision | Why |
|---|---|
| Use the standard Marketo Companies API (`/rest/v1/companies/sync.json`) | Available on most Marketo tenants. No ABM, no custom object. |
| Dedup by name (`dedupeBy: 'dedupeFields'`) | Marketo's default dedup key on the Companies entity. Matches what `lead.company` resolves against. |
| Add 10 standard Company fields beyond the existing 8 | Richer Company records in Marketo for segmentation. Source fields are read directly from Dynamics — empty / null sources are silently dropped by the mapper. |
| `industry` mapped as `choice` (optionSet `industrycode`) | Dynamics' `industrycode` is a Picklist; option-set resolver translates int → label at sync time. |
| Tenants without the Companies endpoint → soft-skip, not error | Some tenants don't expose `/rest/v1/companies/sync.json`. Detected via 404/405/610; flips a process-local flag; subsequent calls return `{ status:'skipped', reason:'companies-endpoint-unavailable' }`. Lead push still works. |

### Piece 4 — In-SPA Marketo schema bootstrap + auto-filter

| Decision | Why |
|---|---|
| Auto-fetch Marketo Lead schema, drop unknown payload fields | Without this, a fresh tenant where `crmEntityType` etc. don't exist yet would have every Lead push fail with code 1006. Now the integration "just works" the first time even before setup. |
| Cache schema for 1 hour | Same as the option-set resolver. New fields appear in the next sync after the cache TTL. |
| One-time WARN per missing field, not per push | Avoids log spam. Operator sees the gap once and is told how to fix it. |
| `accessDenied` detection on Marketo error 603 | Marketo returns `success:false` inside HTTP 200 for permission failures — without explicit detection the route would just relay the cryptic three-line error. The detection lets the SPA pivot to a manual-setup panel with the exact field definitions. |
| Bail after the first denied field | No point firing the same denied request three times. |
| Single source of truth in `src/auth/marketoSchema.js` | Used by writers/marketo.js (auto-filter), routes/marketoSetup.js (Setup button), and the CLI script — all delegate to the same helpers. |

### Piece 5 — Unsubscribe & Sync combined-flow button

| Decision | Why |
|---|---|
| One-click combined flow (Marketo PATCH then Dynamics PATCH) | Operator wants to test the full unsubscribe path without setting up a Marketo Smart Campaign first. The button does exactly what a real campaign webhook would. |
| Read Marketo Lead by id first | Captures the email + custom fields (crmContactId) the unsubscribe handler needs, in case the operator's selection only has the Marketo id. |
| Use `action=updateOnly` for the Marketo PATCH | Idempotent — Marketo returns `status:'updated'` even when the field was already true. Re-running is safe. |
| Trigger via synthetic `processJob` rather than a new code path | Forces the same authority guard, the same handler, the same audit row. If the webhook-driven path works, this works. |
| Operator-friendly summary line | "Email = Do Not Allow on Dynamics Contact &lt;guid&gt;." — answers the user's actual question directly, not "syncs returned status:200". |

---

## How to verify the merge

Run these in order. If any step fails, the merge has gone wrong.

```bash
# 1. Backend syntax + lint — must be CLEAN (no errors, no warnings)
npx eslint src

# 2. Unit + integration tests — must be 895 / 895, ~7 seconds
npx jest tests/unit tests/integration --forceExit

# 3. Web build — must succeed in ~20 seconds
cd web && npm run build && cd ..

# 4. Smoke runner — verbose end-to-end proof, ALL 10 scenarios pass
npm run smoke
```

`npm run smoke` is the most operator-readable signal — it prints the
actual Marketo / Dynamics POST and PATCH bodies and asserts on the
exact bytes. If the merge changes any user-visible behaviour, the smoke
runner fails loudly.

A passing precommit gate (`npm run precommit`) covers the lint + tests + build trio.

---

## Common merge-conflict resolutions

If you hit a conflict, the rule of thumb is **prefer additive — keep both
sides' new entries unless they're literally the same field name**.

### `src/config/fieldmap.json`

If both branches added entries to e.g. `crmToMarketo.contact`, just keep
all entries from both sides. The mapper iterates over keys; duplicates
would be a logical bug but JSON itself is fine.

If both branches added the SAME key with different definitions, that's a
real conflict — pick the one that's tied to richer downstream behaviour.

### `src/engine/fieldMapper.js`

If both branches added new branches (e.g. yours added `array` and ours
added `literal`), keep both branches in the order: skip-derived → other
branches → literal-or-default fallthrough. The order doesn't actually
matter for these unrelated types since they're predicate-gated, but
keeping the simplest first is idiomatic.

### `web/src/tabs/SyncView.jsx`

The largest file. If conflicts pile up:

1. Resolve the imports section first (bundle-sync icons + API methods).
2. Resolve the state hooks block (everything between the existing
   `transferring` state and the existing `runSync` function).
3. Resolve the JSX in this order: `<TypeBadge>` inside `RecordCard` →
   the `<div className="sv-bundle-row">` row → the `<BundleSyncModal>`
   block at the end.
4. Append `BundleSyncModal` and its sub-components after the existing
   `EventsDrawer` / `Modal` definitions.

Each of those four chunks is independent; if a hunk is truly tangled,
take ours wholesale and re-add the sibling branch's intent on top.

### `tests/unit/fieldMapper.scoped.test.js`

If both branches updated the `allowedTypes` set in the schema-invariant
test, **union** them. Don't choose one side's set.

If both branches added new `it(...)` blocks, keep both — Jest doesn't
care about test order.

---

## Dependencies

No new packages added. All existing `package.json` dependencies are
unchanged. `npm install` after merging should be a no-op for new
dependencies (still pulls existing pinned versions, naturally).

Frontend (`web/package.json`) also unchanged — the new icons used in
SyncView (`Building2`, `ChevronDown`, `ChevronRight`, `CheckCircle2`,
`AlertCircle`) all already exist in the installed `lucide-react`.

---

## Database

No schema changes. The new manual-sync audit rows reuse existing columns
on `sync_events`:

```sql
reason_category  = 'manual'
reason_criterion = 'manual:sync-with-company'
```

No migration files in `db/migrations/` were added.

---

## Operational notes for the merger

- **Existing Marketo Persons are not backfilled.** They will get
  `crmEntityType` only when their next CRM webhook fires. If the
  business needs immediate Marketo-side filtering, plan a one-off
  backfill script (not in this fork).
- **The new `industry` mapping uses Dynamics' `industrycode` Picklist.**
  Tenants without that picklist defined or with custom values in it will
  see `industry` come through as the raw int (the resolver has a label
  fallback). Run a sample sync and confirm before going live.
- **Account write failures still let the Person sync.** This is by
  design — Marketo will auto-create the Company on the fly. If the
  business wants strict atomicity, change the `try/catch` in
  `runBundle` to set `result.error` AND `continue` instead of falling
  through to the Person write.
- **Bundle preview is read-only but does call the live Dynamics API.**
  Multiple preview clicks will all hit Dynamics. The 50-row cap is in
  place to keep this bounded; raise it carefully.

---

## When in doubt

The popup-driven planning approach used to scope these features is
captured in conversation logs (not in this repo). If a decision in this
guide doesn't make sense, the safest bet is to **preserve current
behaviour** — every choice here is documented so it can be reversed by
flipping one config or one branch in the code. None of these changes are
load-bearing for any other consumer.
