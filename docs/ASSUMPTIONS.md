# Compliance Plan — Assumptions & Decisions

Companion to [COMPLIANCE_ANALYSIS.md](COMPLIANCE_ANALYSIS.md).

The ten open questions raised during review are resolved below as best-effort decisions. Each entry lists the decision, the reasoning, and how to reverse it if a spec owner disagrees later.

All of these are implementation-level choices that can be changed without altering the plan's task structure. Where a decision introduces a feature flag, the default is the lowest-risk option (usually the pre-existing behaviour).

---

## 1. Doc 2 / Engagement ingest — **out of scope**

**Decision.** The engagement-ingest pipeline (`engagement_dedup` table, `routes/engagement.js`, Playwright simulator) is treated as out of scope for this compliance pass. Only Person and Account sync, as defined in the two source documents we have, is addressed.

**Reasoning.** Neither `Marketo-CRM Integration Behaviour & Rules Specification.md` nor `Marketo-D365-IntegrationMapping.md` mentions engagement, activity ingest, or lead activity filtering. The `engagement_dedup` schema comment refers to "Doc 2", which we do not have. Expanding scope without a spec risks misaligned compliance.

**Reversal.** When Doc 2 surfaces, file a second analysis doc mirroring this one's structure; no code from this plan needs to be undone.

---

## 2. D365 webhook PreImage/PostImage — **assume not available**

**Decision.** Task 16 (mapped-field-change gate) is implemented against a `sync_snapshots` table maintained by the worker. `_pre`/`_post` on the webhook payload is treated as an optimistic extra: if present, used directly; if absent, the last-known snapshot is loaded from the new table. First event after deploy for an unseen record processes unconditionally as a bootstrap.

**Reasoning.** The current `src/listeners/server.js` forwards the raw webhook body without any PreImage handling, which indicates the D365 plugin has not been configured for it. Assuming the plugin's behaviour will change is out of our control and blocks the delta task. The snapshot-table fallback is a self-contained solution.

**Reversal.** If the D365 plugin is later configured to send PreImage, the code path already honours it — no change needed. The snapshot table becomes redundant but harmless.

---

## 3. CRM Connection Roles — **assume role names must be pre-seeded; skip gracefully when missing**

**Status: Confirmed by stakeholder 2026-04-19.** The six-role set below is the locked-in expected roster. No logic change; `EXPECTED_ROLES` in `src/engine/relationships.js` and the seed list in `scripts/seed-connection-roles.js` both reflect this.

**Decision.** Task 17's `setRelationship` / `clearRelationship` resolves role id by name at call time. If the named role is not found in CRM, the call is a no-op that logs `skipped: connection-role-missing:<name>` with a one-line warning — it does not fail the parent write. Expected role names: `KAM`, `Technology`, `HR`, `Procurement`, `Logistics`, `Finance` (drawn from the Contact sheet's relationship columns).

Add a startup warning: at worker boot, query `connectionroles` for the expected names and log a WARN for any missing so operators can seed them without redeploying.

**Reasoning.** Relationship roles are CRM schema/configuration, not integration code. Auto-creating them from a sync worker would be overreach and could conflict with org-level admin. Silent skip + visible warning is the lowest-blast-radius choice.

**Reversal.** If stakeholders confirm a different role-name set, edit the expected-names list in the fieldmap entries; no engine changes.

---

## 4. `ubt_marketoid` backfill — **no bootstrap; email fallback covers legacy; provide an admin script**

**Decision.** Task 14 goes live without pre-populating `ubt_marketoid` on existing Contacts. The secondary resolver matcher (prefer `ubt_marketoid` if present, else fall back to email) handles missing values correctly. Ship a one-off admin script (`scripts/backfill-marketoid.js`) that can be run by an operator when convenient; do not gate the feature on it.

**Reasoning.** Marketo-sourced Contact events already identify persons by email today. `ubt_marketoid` is an optimisation (fewer round-trips, more robust to email changes) rather than a correctness requirement. Blocking Task 14 on a backfill would stall work that is independently valuable.

**Reversal.** If the email fallback proves to create duplicates under load, run the backfill script before/after the suspected window. No code change required.

---

## 5. Task 9 Marketo-source test rewrite — **accept the cost**

**Decision.** The existing Marketo-source tests in `tests/unit/worker.test.js` and `tests/unit/writers.test.js` that assert symmetric bidirectional writes are rewritten, not flag-gated. Any test that asserts a Marketo-sourced job produces an Account write or a non-consent Contact update is replaced with a test that asserts the new authority-skip outcome.

**Reasoning.** The old assertions encode behaviour that is explicitly non-compliant per spec §Operational Behaviour ("Marketo does not create/update Accounts"). Keeping them behind a flag preserves dead code and invites regression.

**Reversal.** None needed — the spec's authority model is settled; there is no scenario in which the old tests should pass again.

---

## 6. "Create Contact Records… only indirectly where a lead cannot find a contact to match" — **Marketo→CRM never creates Contacts; Lead creation is skipped when the Person already resolves to a Contact**

**Decision.** In Task 8, before building the Lead body:
1. If `resolvePerson(...)` returns `entity === 'contact'` with a non-null `targetId`, return `{ status: 'skipped', reason: 'person-resolves-to-existing-contact' }`. No Lead is created, no Contact is touched.
2. Otherwise proceed with the eligibility check and Lead creation as currently specified.

The "indirect" Contact creation described in the spec is interpreted as Sales-driven Lead→Contact conversion inside CRM, which is a CRM-internal workflow outside this integration. Our integration never calls `POST /contacts` from a Marketo-sourced path.

**Reasoning.** The spec sentence is grammatically ambiguous but the surrounding context ("Marketo does not create CRM Accounts", "Update CRM Leads for consent") is clearly enumerating things Marketo is *not* allowed to do. The parenthetical "only indirectly where a lead cannot find a contact to match" is a carve-out describing an edge case — not a direct instruction. Reading it as "the integration may create Contacts when it can't match one" would contradict the authority model.

**Reversal.** If the spec owner confirms the alternative reading (integration *should* create Contacts when lead→contact match fails), this is a single-branch change in Task 8 — add a fall-through to a `POST /contacts` with the same body schema.

---

## 7. Lead Qualification / Disqualification (CRM → Marketo) — **map `statuscode`/`statecode` to a synthetic Marketo field**

**Decision.** Extend `crmToMarketo.lead` with two field entries:

```json
"statuscode":  { "source": "statuscode",  "type": "choice",  "target": "crmLeadStatus" },
"statecode":   { "source": "statecode",   "type": "choice",  "target": "crmLeadState"  }
```

Task 12's option-set resolver handles the choice → label translation. The Marketo side consumes `crmLeadStatus` and `crmLeadState` as custom string fields on the Person.

**Reasoning.** The spec lists "Qualification / Disqualification" as a CRM → Marketo direction but the spreadsheet doesn't map any lifecycle field. `statuscode` is the D365 OOTB field that encodes Qualified / Disqualified / New. Surfacing raw state to Marketo (rather than inventing a rule engine) lets downstream Marketo segmentation own the interpretation — smaller blast radius for integration code.

**Reversal.** If stakeholders want a richer rule (e.g. "only sync when statuscode flips to Qualified"), replace with a dedicated gate in Task 16's delta engine. The field mappings remain useful either way.

---

## 8. "Sync to Marketo" opt-in flag — **implement behind a default-off admin flag**

**Status: Confirmed by stakeholder 2026-04-19 — default `false` is locked in, and the gate is now wired.** When `SYNC_TO_MARKETO_REQUIRED` is set to a truthy admin_config value (`true` / `1` / `yes` / `on`), `hasMappedChange` in [`src/engine/fieldDelta.js`](../src/engine/fieldDelta.js) short-circuits with `{ changed: false, reason: 'sync-to-marketo-opt-in-required', baseline: 'opt-in-gate' }` unless the payload carries `ubt_synctomarketo === true`. When the flag is unset or falsy, behaviour is unchanged.

**Decision.** Add admin config `SYNC_TO_MARKETO_REQUIRED` (default `false`). When `false`, every mapped-field change flows CRM → Marketo (current behaviour after Task 16). When `true`, a CRM record only syncs if `payload.ubt_synctomarketo === true`.

No code path depends on the flag being on; default-off preserves observed behaviour.

**Reasoning.** The spec marks this as an explicit "Decision required" TBD. Implementing the mechanism now (rather than retrofitting later) means stakeholders can flip it without a deploy. Defaulting off avoids accidentally withholding sync data the business is already relying on.

**Reversal.** Flip the flag in admin UI. If `ubt_synctomarketo` is the wrong field name, change the key referenced in `fieldDelta` — single constant.

---

## 9. `accountnumber` === "Company Number" — **treated as the same field**

**Decision.** Task 4's fallback order: `accountid` → `accountnumber` → NetSuite ID (configurable via `ACCOUNT_NETSUITE_FIELD`) → `name`. No separate "company number" field.

**Reasoning.** D365 OOTB has one numeric identifier column on `account`: `accountnumber` (display name "Account Number"). The spec's "Company Number" matches this pattern. The XLSX Company sheet maps "Account Number" to `accountnumber`. The probability this refers to a different custom column is low.

**Reversal.** If a distinct custom column exists, insert it as an additional fallback — Task 4's contract already accepts arbitrary fields.

---

## 10. Spreadsheet anomalies — **best-effort corrections applied silently in code**

**Status: Confirmed by stakeholder 2026-04-19.** The three code-visible corrections — `ubt_marketoid` on Lead, `unsubscribed` as the Marketo source for `donotbulkemail`, and `accountnumber` for "Company Number" — are all confirmed and remain in place (verified in `src/config/fieldmap.json` and `src/engine/accountResolver.js`).

Three rows in `Marketo-D365-IntegrationMapping.md` contain data-entry issues. Applied interpretations:

| Row | Likely correction | Rationale |
|-----|-------------------|-----------|
| Leads sheet: `lead.accountid` annotated *"Marketo Primary key (Blank in Goldvision)"* | Treated as `ubt_marketoid` on Lead. Fieldmap `crmToMarketo.lead` gets a `ubt_marketoid` entry; no mapping for `lead.accountid` → Marketo. | Identical annotation on the Contact sheet's `ubt_marketoid` row. The Lead row is almost certainly a copy-paste with the wrong logical name. |
| Contact sheet: Marketo field literally `????????????????` mapping to `donotbulkemail` | Marketo source field assumed to be `unsubscribed` (standard Marketo REST API lead attribute). Authority guard (Task 6) and unsubscribe handler (Task 7) both key off `payload.unsubscribed === true`. | `unsubscribed` is the canonical Marketo field for global unsubscribe state. `globallyUnsubscribed` (used in earlier drafts) is not a standard Marketo attribute; `unsubscribed` is. |
| Contact sheet: `lead.contactid` listed under "Lead table" with label "CRM Primary Key" | Ignored as a data-entry error. `contactid` lives on Contact; Lead has `leadid`. | The Leads sheet already has a `leadid` implied by context. |
| Company sheet: `ubt_tradingmodel` options appear duplicated from `ubt_markettype` | No action. Task 12 pulls live option-set metadata from Dataverse at runtime, so the spreadsheet options are advisory only. | Sidesteps the question of which list is correct. |

**Reversal.** Each of the three code-visible corrections (`ubt_marketoid` Lead mapping, `unsubscribed` source field, `accountnumber` matching) is one fieldmap entry. Flagging them out is a five-line change.

---

## Decisions summary (one-liners)

| # | Area | Decision |
|---|------|----------|
| 1 | Engagement ingest | Out of scope for this pass |
| 2 | D365 PreImage | Assume unavailable; snapshot table is authoritative |
| 3 | Connection roles | Skip gracefully + warn on boot; do not auto-create |
| 4 | `ubt_marketoid` backfill | Ship admin script; email fallback covers legacy |
| 5 | Task 9 test rewrite | Accept the cost; no flag |
| 6 | "Indirect Contact creation" | Skip Lead creation when Person resolves to existing Contact; never `POST /contacts` |
| 7 | Lead qualification sync | Map `statuscode`/`statecode` as choice fields to Marketo |
| 8 | "Sync to Marketo" flag | Implemented, default off |
| 9 | Company Number | Treat as `accountnumber` |
| 10 | Spreadsheet typos | Read `unsubscribed` for anonymised field; `ubt_marketoid` for mislabelled Lead row |

---

## Items to surface to spec owners (non-blocking)

These decisions should be reviewed when a stakeholder becomes available. None block implementation:

- Interpretation of "Create Contact Records… only indirectly where a lead cannot find a contact to match" (decision 6).
- Inferred choice of `statuscode`/`statecode` for Lead qualification sync (decision 7).
- ~~Spreadsheet corrections (decision 10) — confirm or correct.~~ Confirmed 2026-04-19.
- ~~Default state of `SYNC_TO_MARKETO_REQUIRED` (decision 8).~~ Confirmed default `false` 2026-04-19. (Gate still needs wiring into `fieldDelta`/worker before it can be toggled to `true`.)
- ~~Final set of connection role names (decision 3).~~ Confirmed six-role set (`KAM`, `Technology`, `HR`, `Procurement`, `Logistics`, `Finance`) 2026-04-19.
- Engagement-ingest compliance scope (decision 1) — confirm no separate spec exists.
