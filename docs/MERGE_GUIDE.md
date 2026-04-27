# Merge Guide — for the dev (and AI assistant) merging this fork

This document is written for whoever is bringing the changes in this fork
back into a sibling branch / repo, including any AI assistant helping with
that merge. Read this before touching `git merge` so you understand the
shape and intent of every change.

The companion file [`../CHANGELOG.md`](../CHANGELOG.md) lists every file
touched and why; this guide is the **how to merge it safely** layer on top.

---

## TL;DR

Three pieces of work, all additive:

1. **Contact-vs-Lead differentiator** — every CRM → Marketo Person sync now
   stamps `crmEntityType` + `crmContactId` / `crmLeadId` on the Marketo
   record. Powered by a new `literal` field-mapper type. Logs filter chip +
   SyncView Type badge in the SPA.
2. **"Sync with Company" bundle button** — operator-triggered multi-row
   sequential push from CRM. Reads each selected Contact/Lead, resolves
   their associated Account, pushes Account → Person to Marketo. Preview
   modal first, then commit.
3. **Account → Company mapping expansion** — added 10 standard Marketo
   Company fields (billing address, industry, revenue, employees, website,
   main phone) to `crmToMarketo.account`. Uses Marketo's built-in Companies
   API — no ABM, no custom object.

All changes pass `npx eslint src` (clean), `npx jest tests/unit tests/integration`
(863/863), and `cd web && npm run build` (clean).

---

## File map — what's new vs what's modified

### New files (drop-in — no merge conflict possible)

| Path | Purpose |
|---|---|
| `src/engine/bundleSync.js` | Engine helper for the bundle sync flow. Exports `previewBundle`, `runBundle`, `resolveAssociatedCompany`, `REASON_CRITERION`, `VALID_ENTITIES`. |
| `tests/unit/bundleSync.test.js` | 18 unit tests for the helper. |
| `tests/unit/routes.transferWithCompany.test.js` | 10 route-level tests for the new endpoints. |
| `CHANGELOG.md` | Chronological change log. |
| `docs/MERGE_GUIDE.md` | This file. |

### Modified files (likely merge hot-spots)

Listed by likelihood of conflict in your sibling branch.

| Path | Change | Conflict likelihood | Notes |
|---|---|---|---|
| `src/config/fieldmap.json` | Added 12 entries: 4 under `crmToMarketo.contact`/`lead` (the entity-type signals) + 10 under `crmToMarketo.account` (Company expansion). | **High** | Pure JSON additions inside existing entity blocks. If your branch also touched these blocks, expect line-level conflicts. The schema is forwards-compatible — keep both sides' new entries. |
| `src/engine/fieldMapper.js` | Added a `literal` branch in two functions (`mapToMarketo`, `mapToMarketoAsync`). Updated docstring to list 7 types. | **Medium** | Both edits are inside existing `for ... of Object.entries(mapping)` loops, immediately after the `derived` skip. Safe to apply alongside other branch additions. |
| `src/readers/dynamics.js` | (a) Added `readDynamicsById` export. (b) Extended `SELECT_FIELDS.account` with `accountnumber`, `address1_line1`, and 6 `ubt_*` fields. | **Medium** | The new function appends at the end before `module.exports`. The SELECT_FIELDS edit is inside the existing array literal. |
| `src/routes/transfer.js` | Added imports for `bundleSync` + `getDynamicsToken` + `getMarketoToken`. Added `MAX_BUNDLE_ROWS` constant + `validateBundleBody` helper. Added two new routes: `POST /with-company/preview` and `POST /with-company`. | **Medium** | Existing `POST /` route untouched. New routes appended before `module.exports`. |
| `src/routes/events.js` | Added `entityType` query param + `source_type` to SELECT in `GET /api/events`. | **Low** | Pure parameter + clause additions in one route. |
| `web/src/lib/api.js` | Added `entityType` to `getEvents` params. Added `previewBundleSync` + `runBundleSync` exports. | **Low** | Pure additions. |
| `web/src/tabs/Logs.jsx` | Added `entityFilter` state + filter dropdown in the toolbar. SSE filter respects it. | **Medium** | Touches imports, state hooks, useEffect deps array, JSX toolbar. Watch `filtersRef.current` shape if your branch added other filters. |
| `web/src/tabs/SyncView.jsx` | (a) `TypeBadge` in `RecordCard`. (b) Bundle state + handlers near the top of the component. (c) Bundle Sync row above `<div className="sv-stage">`. (d) `BundleSyncModal` + 5 sub-components after the main component's closing `}`. | **High** | Largest single file diff. Best merged hunk-by-hunk: badge → state hooks → row → modal. Each chunk is independent. |
| `tests/unit/fieldMapper.scoped.test.js` | Added `literal` to allowed types, updated 3 `toEqual` assertions, added 4 new `it(...)` blocks. | **Low** | Pure additions / assertion updates. |
| `tests/unit/fieldMapper.async.test.js` | One `toEqual` updated to include `crmEntityType: 'contact'`. | **Low** | One-line change. |
| `tests/unit/fieldDelta.test.js` | One mock snapshot updated to include `contactid` (real-world parity). | **Low** | One-line change. |
| `docs/ARCHITECTURE.md` | New sections under existing ToC (Field mapper types, Entity-type signal, Manual bundle sync). Module map auto-block unchanged. | **Low** | Additions to the doc body. |
| `docs/PRODUCT_OVERVIEW.md` | Updated "At a glance" table, field mapping example, new "Manual Sync with Company bundle" section, Contact-vs-Lead explainer. | **Low** | Additions. |
| `README.md` | New "What's new in this fork" callout. | **Low** | Single-section addition. |

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
| `Skip` when company info exists but doesn't resolve | Data-quality enforcement — operator should fix the broken FK before retrying. |
| `Person-only` when no company info exists at all | Graceful — legitimate case for a Lead without a known company. |
| Confirmation: preview modal first, then commit | Operators see exactly what would be sent before any writes happen. |
| Account write failure does NOT abort the row's Person write | Marketo auto-creates the Company on the fly via `lead.company` dedup. Preserves the operator's intent in degraded conditions. |
| Continue on per-row failures, summarise at end | Consistent with the existing transfer button's behaviour. |
| Audit each leg with `reason_category='manual'`, `reason_criterion='manual:sync-with-company'` | Keeps manual syncs filterable and replayable. Reuses existing schema columns — no DB migration. |
| Two dedicated endpoints (`/preview` + live) | Clean separation, easy to test, easy to extend. |
| Preview is a UX path, not a server-enforced gate | The live endpoint accepts direct calls (Postman, future CLI) without a preview-token round-trip. |

### Piece 3 — Account mapping expansion

| Decision | Why |
|---|---|
| Use the standard Marketo Companies API (`/rest/v1/companies/sync.json`) | Available on every Marketo tenant. No ABM, no custom object. |
| Dedup by name (`dedupeBy: 'dedupeFields'`) | Marketo's default dedup key on the Companies entity. Matches what `lead.company` resolves against. |
| Add 10 standard Company fields beyond the existing 8 | Richer Company records in Marketo for segmentation. Source fields are read directly from Dynamics — empty / null sources are silently dropped by the mapper. |
| `industry` mapped as `choice` (optionSet `industrycode`) | Dynamics' `industrycode` is a Picklist; option-set resolver translates int → label at sync time. |

---

## How to verify the merge

Run these in order. If any step fails, the merge has gone wrong.

```bash
# 1. Backend syntax + lint
npx eslint src

# 2. Unit + integration tests (should be 863 / 863, ~7 seconds)
npx jest tests/unit tests/integration --forceExit

# 3. Web build (should succeed in ~20 seconds)
cd web && npm run build && cd ..

# 4. Smoke-test the projection
node -e "
const { mapToMarketo } = require('./src/engine/fieldMapper');
const c = mapToMarketo({ contactid: 'c1', emailaddress1: 'x@y.com', firstname: 'A' }, 'contact');
console.assert(c.crmEntityType === 'contact', 'contact stamp missing');
console.assert(c.crmContactId === 'c1', 'crmContactId missing');
const l = mapToMarketo({ leadid: 'l1', emailaddress1: 'x@y.com' }, 'lead');
console.assert(l.crmEntityType === 'lead', 'lead stamp missing');
console.assert(l.crmLeadId === 'l1', 'crmLeadId missing');
console.log('OK');
"
```

A passing precommit gate (`npm run precommit`) covers the same ground end-to-end.

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
