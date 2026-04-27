# Changelog

Chronological list of changes made to this fork of the Dynamics ↔ Marketo
sync POC. Newest first. Each entry lists every file touched so a reviewer
(human or AI) can audit the diff with confidence.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased] — Pre-handoff to Rohan

This branch consolidates a complete operator workflow on top of the
original POC — Contact-vs-Lead differentiation, Sync-with-Company, and
Marketo→Dynamics unsubscribe — plus an in-SPA Marketo schema bootstrapper,
a graceful-degradation auto-filter, an end-to-end smoke runner, and an
expanded Account → Company mapping. **All changes are additive or strictly
extend existing behaviour. No breaking API changes.**

### Added — Unsubscribe & Sync (Marketo → CRM combined-flow button)

Operator-triggered button in SyncView's arrow column: marks selected
Marketo Persons as `unsubscribed=true` in Marketo, then triggers the
Dynamics PATCH that flips `donotbulkemail=true` on the matching Contact.
Result modal shows step-by-step outcomes per row + a "Show JSON" toggle
exposing the full response payload — operator-friendly summary line:
*"Email = Do Not Allow on Dynamics Contact &lt;guid&gt;."*

| File | Change |
|---|---|
| `src/writers/marketo.js` | New `readMarketoLeadById` + `markMarketoLeadUnsubscribed`. The latter POSTs `/rest/v1/leads.json` with `action=updateOnly` + `unsubscribed:true`. |
| `src/engine/unsubscribeBundle.js` | **New file.** `runUnsubscribeAndSync({ sourceIds, mktToken })` — sequential per-row: read Marketo Lead → update Marketo → run synthetic processJob → compile result. Never throws. |
| `src/routes/transfer.js` | New `POST /api/transfer/unsubscribe-and-sync` endpoint, body `{ sourceIds }`, 50-row cap. |
| `web/src/lib/api.js` | New `unsubscribeAndSync({ sourceIds })` helper. |
| `web/src/tabs/SyncView.jsx` | New 4th button in the arrow column ("Unsubscribe & Sync", amber gradient), only enabled for entity=Contact + direction includes m2d + ≥1 Marketo row selected. New `UnsubscribeBundleModal` with side-by-side Marketo/Dynamics step cards + Show JSON toggle. |

### Added — In-SPA Marketo schema bootstrap

When the Marketo Lead schema is missing the three custom fields the
integration depends on (`crmEntityType`, `crmContactId`, `crmLeadId`), a
banner appears at the top of SyncView with a one-click **"Set up Marketo
fields"** button. If the API user lacks the *Read-Write Schema Custom
Fields* permission (Marketo error 603), the banner pivots to show a
manual-setup panel listing the exact field names + types and the
permission-fix hint, plus a "Try again" button.

| File | Change |
|---|---|
| `src/auth/marketoSchema.js` | **New file.** `REQUIRED_LEAD_FIELDS` constant + `fetchLeadSchemaFields` + `getSchemaStatus` + `createCustomFields`. Detects Marketo error 603 wrapped in HTTP 200, marks `accessDenied:true`, bails after the first denial (no point spamming the same denied request three times). |
| `src/routes/marketoSetup.js` | **New file.** `GET /api/marketo/schema-status` + `POST /api/marketo/setup-custom-fields`. The latter returns a structured `manualSetup` blob (steps + per-field schema + permissionFix hint) when access is denied. |
| `src/listeners/server.js` | Mount `/api/marketo`. |
| `web/src/lib/api.js` | `getMarketoSchemaStatus` + `setupMarketoCustomFields`. |
| `web/src/tabs/SyncView.jsx` | Banner with two states: "schema not yet set up" (purple, with Set Up button) and "Setup blocked — Access denied" (yellow, with inline manual-setup panel + Try Again button). |
| `scripts/marketo-create-custom-fields.js` | Refactored to use the shared helpers. CLI parity with the SPA button. |

### Added — Marketo Lead schema auto-filter (graceful degradation)

When operators haven't created the custom fields yet, Marketo would
otherwise reject the entire push with code 1006 ("Field 'X' not found").
The writer now fetches `/leads/describe.json` (cached 1h) and silently
drops unknown fields with a one-time WARN per missing field. Tenants
where this fetch fails get fail-open behaviour (payload sent unchanged).

| File | Change |
|---|---|
| `src/writers/marketo.js` | `fetchLeadSchema` (with 1h cache) + `filterUnknownLeadFields`. Applied in `writeToMarketo` before the push. Exports `_resetLeadSchemaCache` for tests. |

### Added — Companies endpoint graceful unavailability

Some Marketo tenants don't expose `/rest/v1/companies/sync.json` (paid
tier / API user permissions). Detected via HTTP 404/405 or Marketo error
610. First failure flips a process-local flag; subsequent calls return a
soft-skip immediately rather than re-hitting a 404. The Lead push still
carries `company` so Marketo dedups the Company on its side.

| File | Change |
|---|---|
| `src/writers/marketo.js` | `_companiesEndpointUnavailable` flag + `isCompaniesEndpointMissing(err)`. `writeMarketoCompany` returns `{ status:'skipped', reason:'companies-endpoint-unavailable' }` rather than throwing. |
| `src/engine/bundleSync.js` | Recognises that soft-skip status, audits the row as `skipped` with `reason_criterion='manual:sync-with-company:companies-endpoint-unavailable'`, and proceeds to push the Person normally. |

### Added — `company` field on Person mappings + bundle-sync Account-to-Person merge

Previously `crmToMarketo.contact` and `crmToMarketo.lead` had no `company`
mapping at all, so the Marketo Person record never carried a company name.
Now both have a `company` entry (Contact: derived via new
`parentAccountName`; Lead: text from `companyname`). Bundle-sync also
projects the resolved Account through `crmToMarketo.account` and **merges
the result onto the Person body** before pushing — so the Marketo Lead
record reflects company, billing address, industry, employees, website,
mainPhone even when the Companies endpoint is unavailable.

Also: an unresolvable company on a Lead no longer skips the row. It now
downgrades to `person-only` with `skipReason='unresolved-account'` and the
`company` field is forwarded so Marketo dedups on its own side.

| File | Change |
|---|---|
| `src/config/fieldmap.json` | Added `company` to `crmToMarketo.contact` (derived `parentAccountName`) and `crmToMarketo.lead` (text `companyname`). |
| `src/engine/derivedFields.js` | New `parentAccountName` derivation — fast path uses `record.company` (reader-flatten) or `record.parentcustomerid_account.name` (raw $expand); falls through to `GET /accounts({id})?$select=name`. |
| `src/engine/bundleSync.js` | New `mergeAccountFieldsOntoPerson`. Applied in both `previewBundle` and `runBundle` between `enrichDerived` and `writeToMarketo`. Person fields take precedence on conflict. |
| `src/engine/bundleSync.js` | `resolveAssociatedCompany` — unresolvable now downgrades to `person-only`, only `source-record-not-found` remains a hard skip. |
| `tests/unit/bundleSync.test.js` | Updated existing tests + 3 new tests covering the merge behaviour. |

### Added — `/api/simulate/unsubscribe` endpoint (single-record trigger)

Operator-facing simulation endpoint for when you want to trigger the
unsubscribe path without a Marketo Smart Campaign or selected Marketo
rows — useful for ad-hoc testing. Body: `{ crmContactId?, email?,
marketoId? }`. Synthesises a job and runs it through the live worker.

| File | Change |
|---|---|
| `src/routes/simulate.js` | **New file.** `POST /api/simulate/unsubscribe`. |
| `src/listeners/server.js` | Mount `/api/simulate`. |
| `web/src/lib/api.js` | `simulateUnsubscribe`. |
| `web/src/tabs/SyncView.jsx` | "Simulate Marketo unsubscribe → Dynamics" panel above the columns: email + contactid inputs + button + result display. Complementary to the bulk Unsubscribe & Sync button. |

### Added — Smoke runner (`npm run smoke`)

Self-contained verbose simulator. Runs 10 user-visible scenarios end-to-end
with REAL code (worker, fieldMapper, derivedFields, writers, schema filter,
authority router, unsubscribe handler) against URL-routed mock HTTP. Prints
the actual body that would have hit Marketo / Dynamics, asserts the values.
No external systems needed.

| File | Change |
|---|---|
| `scripts/smoke.js` | **New file.** Scenarios A-E (bundle sync) + F-I (unsubscribe alone) + J (Unsubscribe & Sync combined). |
| `package.json` | Added `npm run smoke`. |

### Added — End-to-end test coverage (23 new tests)

| File | Tests |
|---|---|
| `tests/integration/bundleSyncFlow.test.js` (new) | 6 — full HTTP → Marketo body assertions through the route handler. Covers: PREVIEW shape, LIVE happy path, Companies 404 graceful, schema filter strips, Lead w/ unresolvable company, multi-row mid-batch failure. |
| `tests/integration/marketoUnsubscribeFlow.test.js` (new earlier) | 5 — signed webhook → enqueue → worker → handler → PATCH → audit. Edge cases: stale crmContactId fallback, no Contact match → skip, unauthorized payload, invalid HMAC. |
| `tests/unit/writers.schemaFilter.test.js` (new) | 5 — drops unknown fields, keeps knowns, fail-open on schema fetch error, cache, dedupe-WARN. |
| `tests/unit/marketoSchema.test.js` (new) | 12 — REQUIRED_LEAD_FIELDS contract, schema fetch, schema status, code 603 detection + bail, code 1009 (already exists) → success, HTTP 401/403 → bail. |
| `tests/unit/bundleSync.test.js` | Updated existing + 3 new for company-merge behaviour. |

Total: **895 / 895 jest tests pass** + smoke runner all 10 scenarios pass.

### Added — Account → Company mapping expansion (originally landed earlier; included for completeness)

`crmToMarketo.account` grew from 8 to 18 entries — added `website`,
`mainPhone`, `industry` (choice), `annualRevenue`, `numberOfEmployees`,
`billingStreet/City/State/PostalCode/Country`. Uses Marketo's standard
Companies API. **No ABM, no custom object.**

### Added — Contact-vs-Lead differentiator (originally landed earlier; included for completeness)

Every CRM → Marketo Person sync stamps `crmEntityType` (literal) +
`crmContactId` / `crmLeadId` (guid). New `literal` field-mapper type
introduced. Logs tab gets an entity-type filter chip, SyncView record
cards get coloured Type badges.

### Verified

- `npx eslint src` — clean (0 errors, 0 warnings)
- `npx jest tests/unit tests/integration --forceExit` — **895/895 tests pass** across 73 suites
- `cd web && npm run build` — clean
- `npm run smoke` — all 10 scenarios pass

