# Changelog

Chronological list of changes made to this fork of the Dynamics ↔ Marketo
sync POC. Newest first. Each entry lists every file touched so a reviewer
(human or AI) can audit the diff with confidence.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased] — Pre-handoff to Rohan

This branch consolidates two operator-driven features plus a richer
Account → Company mapping and an AI-merge guide. All changes are additive
or strictly extend existing behaviour. No breaking API changes.

### Added — Piece 1: Contact-vs-Lead differentiator in Marketo

Every CRM → Marketo Person sync now stamps three new fields on the Marketo
record so operators can filter Contacts vs Leads cleanly in Smart Lists.

- **`literal` field-mapper type** — sixth supported entry type, symmetric
  with `text` / `boolean` / `guid` / `choice` / `lookup` / `derived`. Emits
  a fixed `entry.value` regardless of the source record. Convention:
  `source: '@literal'` (mirrors `@derived`).
- **`crmEntityType`** literal value `'contact'` or `'lead'` on every Person
  payload.
- **`crmContactId`** (Contact rows) and **`crmLeadId`** (Lead rows) — guid
  passthrough of the Dynamics primary key. Lets Marketo Smart Lists match
  on `<id> is not empty`.
- **SPA Logs tab** — new entity-type filter chip (Contact / Lead / Account /
  All Types). Backend `/api/events` route now accepts `?entityType=...`
  and the SELECT now includes `source_type` (fixes a pre-existing bug
  where the entity badge always fell back to `'contact'`).
- **SPA SyncView** — coloured Type badge on every record card
  (Contact = cyan, Lead = violet, Account = green).

Files changed:

| File | Change |
|---|---|
| `src/engine/fieldMapper.js` | Added `literal` branch in `mapToMarketo` + `mapToMarketoAsync`. Updated docstring. |
| `src/config/fieldmap.json` | Added `crmEntityType` (literal) and `crmContactId` / `crmLeadId` (guid) under `crmToMarketo.contact` and `crmToMarketo.lead`. |
| `src/routes/events.js` | Added `entityType` query param to `GET /api/events` and `source_type` to SELECT. |
| `web/src/lib/api.js` | `getEvents` forwards optional `entityType`. |
| `web/src/tabs/Logs.jsx` | Added entity-type dropdown next to status filter. SSE filter respects it. |
| `web/src/tabs/SyncView.jsx` | Added `TypeBadge` component on every record card. |
| `tests/unit/fieldMapper.scoped.test.js` | Added `literal` to allowed types, updated three `toEqual` assertions, added 4 new test cases for the new fields. |
| `tests/unit/fieldMapper.async.test.js` | Updated one `toEqual` to include `crmEntityType`. |
| `tests/unit/fieldDelta.test.js` | Updated one mock snapshot to include `contactid` (matches real-world snapshot upserts). |

### Added — Piece 2: "Sync with Company" bundle button

Operator-triggered, CRM → Marketo only, multi-row sequential push. For each
selected Contact or Lead in SyncView, the system reads the full record,
resolves its associated Account, and pushes Account first then Person.

- **`src/engine/bundleSync.js` (new)** — `previewBundle` / `runBundle` /
  `resolveAssociatedCompany` helpers. Sequential, never throws at the top
  level, collects errors per row, returns aggregate summary.
- **`POST /api/transfer/with-company/preview`** — read-only resolution +
  projection. Returns `{ summary, rows }` with the Account + Person bodies
  that would be sent. No writes.
- **`POST /api/transfer/with-company`** — live sequential push. Returns
  `{ summary, results }`. Per-row audit rows tagged
  `reason_category='manual'`, `reason_criterion='manual:sync-with-company'`.
- **`readDynamicsById` reader helper** — single-record fetch by GUID, same
  flatten/expand as the list reader, returns `null` on 404.
- **SPA Bundle Sync row** above the two SyncView tables (visible only for
  Contact/Lead in d2m mode). Click → preview modal (aggregate summary +
  collapsible per-row bodies) → confirm → progress modal (spinner with
  "Syncing N of M…") → result modal with synced / skipped / failed counts.

Skip semantics:

| Condition | Outcome |
|---|---|
| Contact w/ no parent Account FK | `person-only` (graceful) |
| Contact w/ broken parent FK | `skip` (`no-resolvable-account`) |
| Lead w/ no `companyname` / `accountnumber` | `person-only` |
| Lead w/ company info that doesn't resolve | `skip` |
| Account write fails mid-row | Person write still attempted; Marketo dedups Company on the fly via `lead.company` |

Files changed:

| File | Change |
|---|---|
| `src/readers/dynamics.js` | Added `readDynamicsById({ entity, id })` export. Extended `account` SELECT_FIELDS with `accountnumber`, `address1_line1`, and the six `ubt_*` custom fields. |
| `src/engine/bundleSync.js` | **New file.** Bundle-sync engine helper. |
| `src/routes/transfer.js` | Added `POST /with-company/preview` and `POST /with-company` endpoints. Body validator + 50-row cap. |
| `web/src/lib/api.js` | Added `previewBundleSync` + `runBundleSync` client methods. |
| `web/src/tabs/SyncView.jsx` | Added Bundle Sync row + `BundleSyncModal` (preview / progress / result render modes). |
| `tests/unit/bundleSync.test.js` | **New file.** 18 unit tests covering `resolveAssociatedCompany`, `previewBundle`, `runBundle`, exports. |
| `tests/unit/routes.transferWithCompany.test.js` | **New file.** 10 route-level tests covering body validation + happy paths + error paths. |

### Added — Account → Company mapping expansion

Marketo's standard Companies entity (no ABM required) accepts more enrichment
fields than we were sending. Mapping now covers billing address, industry,
revenue, employees, website, and main phone — read straight from the
Dynamics Account on bundle sync.

| Marketo field added | Source (Dynamics) | Type |
|---|---|---|
| `website` | `websiteurl` | text |
| `mainPhone` | `telephone1` | text |
| `industry` | `industrycode` | choice (`industrycode` optionSet) |
| `annualRevenue` | `revenue` | text |
| `numberOfEmployees` | `numberofemployees` | text |
| `billingStreet` | `address1_line1` | text |
| `billingCity` | `address1_city` | text |
| `billingState` | `address1_stateorprovince` | text |
| `billingPostalCode` | `address1_postalcode` | text |
| `billingCountry` | `address1_country` | text |

Files changed:

| File | Change |
|---|---|
| `src/config/fieldmap.json` | Added 10 entries under `crmToMarketo.account`. |
| `src/readers/dynamics.js` | Added `address1_line1` + `accountnumber` to `SELECT_FIELDS.account`. **Note**: tenant-custom `ubt_*` fields are deliberately NOT in the `$select` — including a column that doesn't exist in a given Dynamics tenant fails the whole read with OData 400. The fieldmap still references them; if the source webhook PostImage includes them, the mapper picks them up; if not, they're silently dropped. |

### Documentation

| File | Change |
|---|---|
| `docs/ARCHITECTURE.md` | New sections: Field mapper types, Entity-type signal, Manual bundle sync. ToC updated. |
| `docs/PRODUCT_OVERVIEW.md` | Updated "At a glance", field mapping example, new "Manual Sync with Company bundle" section, Contact-vs-Lead differentiation explainer. |
| `CHANGELOG.md` | **New file** (this one). |
| `docs/MERGE_GUIDE.md` | **New file.** Step-by-step instructions for an AI assistant merging this fork into another branch — file-by-file change list, conflict hot-spots, decision log, verification checklist. |
| `README.md` | Added "What's new in this fork" callout. |

### Verified

- `npx eslint src` — clean (0 errors, 0 warnings).
- `npx jest tests/unit tests/integration --forceExit` — **863 / 863 tests pass** across 69 suites (28 new tests added).
- `cd web && npm run build` — builds clean (`✓ built in 16.58s`); pre-existing bundle-size warning unchanged.
