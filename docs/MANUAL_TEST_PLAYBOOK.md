# Manual Test Playbook

How to verify the operator-visible flows by hand. Pre-reqs: backend on
`:3000`, SPA on `:5173`, `.env` filled with valid Dynamics + Marketo
credentials, `npm run verify` clean, `db/schema.sql` applied.

Automated coverage lives in `tests/integration/*Flow.test.js` and
`tests/unit/bundleSync.test.js` — and the simplest end-to-end proof
that doesn't need real systems is **`npm run smoke`**, which exercises
every flow below against URL-routed mock HTTP and prints the actual
bytes that would have hit Marketo / Dynamics.

---

## 0. The fastest possible smoke test (no real systems)

```bash
npm run smoke
```

Runs 10 scenarios end-to-end: bundle sync (full-fat / narrow schema /
Companies endpoint 404 / Lead unresolvable / preview), unsubscribe alone
(happy path / email fallback / no Contact / no identifier), and the new
combined Unsubscribe & Sync flow. Prints the actual Marketo + Dynamics
HTTP bodies. ALL ASSERTIONS PASSED at the bottom = the integration's
bytes are right end-to-end.

Use this before every demo. If smoke fails, don't bother with the
sections below — fix the regression first.

---

## A. Marketo → Dynamics global unsubscribe

### What it should do

When a Marketo Person is marked as globally unsubscribed, the Dynamics
**Contact's `donotbulkemail` field flips to `true`**. This is the only
write the integration is authorised to do against a Contact from Marketo
(spec §Operational Behaviour). Lead records are never touched by this
path. If Marketo can only resolve the Person to a Lead (no Contact),
the sync skips with reason `contact-not-resolvable` — never widens its
authority.

### How the data needs to look

The integration is webhook-driven. Your Marketo Smart Campaign needs a
trigger like *"Person is unsubscribed from marketing"* with a Webhook
flow step pointing at `https://<your-host>/webhook/marketo`. The webhook
payload must include:

```json
{
  "id":           "<marketo-lead-id>",
  "crmContactId": "<dynamics-contactid-guid>",
  "email":        "<lead-email>",
  "unsubscribed": true
}
```

`unsubscribed: true` is the trigger the authority guard keys off. Either
`crmContactId` OR `email` is required; `id` (Marketo lead id) is helpful
for the `ubt_marketoid` round-trip lookup.

### Step-by-step manual test

1. **Pick a Contact in Dynamics** that exists, with a known `contactid` GUID
   and email. Note both values.
2. **Confirm starting state**: in Dynamics, the Contact's "Bulk Email" /
   "Email" preference is **Allow** (i.e. `donotbulkemail = false`).
3. **Send the webhook**. Three options:
   - **Easiest** — use the existing **Sync View** transfer button:
     pull a Marketo lead, edit the Marketo-side payload to add
     `unsubscribed: true` + the Contact's `crmContactId`, then transfer
     `m2d`. Watch Logs for the resulting audit row.
   - **Direct curl** (HMAC-signed) — skip if you don't have `openssl`:
     ```bash
     export MKTO_SECRET=<your MARKETO_WEBHOOK_SECRET from .env>
     export BODY='{"id":"MKTO-1","crmContactId":"<DYN-CONTACTID>","email":"<EMAIL>","unsubscribed":true}'
     export SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$MKTO_SECRET" | awk '{print "sha256="$2}')
     curl -X POST http://localhost:3000/webhook/marketo \
       -H "Content-Type: application/json" \
       -H "x-marketo-signature: $SIG" \
       -d "$BODY"
     ```
   - **Production path** — fire the real Marketo Smart Campaign once,
     once the webhook is wired up.
4. **Verify the Logs tab in the SPA**: a new row appears with
   `marketo → dynamics`, status `success`, entity type `contact`. The
   target_id should be your contactid.
5. **Verify in Dynamics**: open the Contact. Bulk Email preference flips
   from **Allow** to **Do Not Allow** within seconds (`donotbulkemail = true`).

### Expected failure modes

| Scenario | Outcome |
|---|---|
| Webhook signature wrong / missing | 401, no audit row, no write |
| `unsubscribed: true` but no `crmContactId` and no `email` | Skipped — `reason_category='authority'`, `criterion='unsubscribe-without-identifier'` |
| Email matches a Lead but no Contact | Skipped — `reason='contact-not-resolvable'`. Lead is intentionally NOT touched. |
| Stale `crmContactId` (Contact deleted) | Falls through to email match. If email finds an active Contact → patches it. Else → skipped. |
| Active Contact found but PATCH fails (network/5xx) | Audit row marks the job `failed`, pg-boss retries 3× with backoff. |

---

## B. Sync with Company (CRM → Marketo)

### What it should do

When you click **Sync with Company** on a selected Contact / Lead in
SyncView, the integration:

1. Reads the full Dynamics record by id.
2. Resolves the associated Account (Contact: `parentcustomerid`, Lead:
   `companyname` → accountResolver priority).
3. If the Account is resolvable, pushes it to Marketo Companies first.
   - On a tenant where `/rest/v1/companies/sync.json` is unavailable,
     the call is soft-skipped — Lead-side merge below still puts company
     info on the Marketo Person.
4. Projects the resolved Account through the same `crmToMarketo.account`
   field map and **merges those fields onto the Person body** (company,
   billingStreet, billingCity, industry, numberOfEmployees, website,
   mainPhone, etc.).
5. Pushes the Person to Marketo with the merged body, plus
   `crmEntityType` + `crmContactId` / `crmLeadId` for downstream filtering.

### Pre-requisite: Marketo schema

The three custom fields **must exist on the Marketo Lead schema** before
they'll land on records. SyncView shows a banner if they don't —
click *"Set up Marketo fields"*. If the API user lacks the
*Read-Write Schema Custom Fields* permission, the banner pivots to show
a manual-creation panel listing the exact field names and types.

### Step-by-step manual test

1. **Pick a Contact in Dynamics** that has a parent Account populated.
   Make sure the Account itself has rich data: name, billing address,
   website, telephone, industry, employee count.
2. **Open SyncView** in the SPA → Entity = **Contact** → Direction =
   **Dynamics → Marketo (d2m)**.
3. **Pull** Dynamics records.
4. **Tick the checkbox** on the test Contact (only one to start).
5. **Click "Sync with Company"** in the centre column. The preview modal
   opens.
6. **Read the preview**:
   - Top stat row should show `1` under "With company".
   - Click the row to expand. Click **"Inspect bodies"**.
   - Account body should show: `company`, `billingCity`, `billingCountry`,
     `industry`, `numberOfEmployees`, `website`, `mainPhone`, etc.
   - Person body should show: standard Person fields PLUS the merged
     Account fields PLUS `crmEntityType: 'contact'` + `crmContactId`.
7. **Click "Push N now"**. The modal switches to a progress spinner,
   then a result modal.
8. **Verify the result**:
   - "Persons synced: 1", "Companies synced: 1" (or 0 if Companies
     endpoint unavailable — that's fine).
   - Click the row → "Synced (with company)".
9. **Open Marketo** → find the Person record by email or by `crmContactId`.
   Confirm:
   - `crmEntityType = "contact"` ✓
   - `crmContactId = <guid>` ✓
   - `company`, `billingCity`, `billingCountry`, etc. all populated ✓
10. (Optional) **Find the Marketo Company record** by name. Confirm the
    same enrichment landed there too — only available if the Companies
    endpoint is enabled on your tenant.

### Expected behaviours per scenario

| Selection | What you should see |
|---|---|
| Contact w/ parent Account that has full data | Person + Company synced; Marketo Person record shows full company info |
| Contact w/ no parent Account at all | Plan = "Person only"; Person synced without a Company write |
| Contact w/ broken parent FK (Account 404) | Plan = "Person only — unresolved-account"; still synced; Marketo dedups Company on the fly via `lead.company` |
| Lead w/ `companyname` that resolves to a CRM Account | Same as Contact-with-Account |
| Lead w/ `companyname` that doesn't resolve | **Now succeeds as person-only** (previously skipped). Person is pushed with the literal company name. Marketo will create/match the Company itself. |
| Lead with no company info | Plan = "Person only"; Person synced |
| Multi-row batch | Sequential push, errors don't abort. End-of-batch summary shows synced / skipped / failed per row |
| Account write fails mid-row | Person still pushed (Marketo dedups Company via `lead.company`). Audit row for the Account marks `failed`; for the Person marks `success`. |

### What to inspect after the sync

- **SPA Logs tab** — new rows for the Account write (if any) + the Person
  write. Filter `Entity Type = Contact` to narrow.
- **Audit DB**: `SELECT * FROM sync_events WHERE reason_criterion LIKE 'manual:sync-with-company%' ORDER BY created_at DESC LIMIT 20;`
- **Marketo Person record** — open it in Marketo Lead Database and
  confirm the new fields are populated.

---

## C. "Unsubscribe & Sync" combined flow (Marketo column → Dynamics)

### What it should do

When you click **Unsubscribe & Sync** on selected Marketo Person rows,
the integration:

1. Looks up each Marketo Lead by id (to capture email + crmContactId).
2. POSTs `/rest/v1/leads.json` with `action=updateOnly`, `unsubscribed=true`.
   Marketo confirms (`status: 'updated'` or `'skipped'` if already true).
3. Synthesises a Marketo-source job with `{ unsubscribed:true, email,
   crmContactId? }` and feeds it through the live worker.
4. Authority guard classifies it as `GLOBAL_UNSUBSCRIBE`.
5. `handleGlobalUnsubscribe` resolves the Person to a Dynamics Contact
   and PATCHes `/contacts({id})` with body `{donotbulkemail:true}`.
6. Returns a per-row JSON like:
   ```json
   {
     "marketoId": "12345",
     "email":     "alice@acme.com",
     "marketo":   { "ok": true, "status": "updated" },
     "dynamics":  { "ok": true, "contactId": "...", "patched": { "donotbulkemail": true } },
     "summary":   "Email = Do Not Allow on Dynamics Contact <guid>."
   }
   ```

### Pre-requisites

- The Marketo Lead must already have a `crmContactId` field populated
  (or have an email that matches a Dynamics Contact). Otherwise the
  Dynamics step skips with `contact-not-resolvable`.
- The Marketo API user needs write permission on the Lead's
  `unsubscribed` field (standard Marketo REST permission).

### Step-by-step

1. **SyncView** → Entity = **Contact** → Direction = **Marketo →
   Dynamics (m2d)** (or **Dynamics ↔ Marketo (both)**).
2. **Pull Marketo records.**
3. Tick the Marketo Person(s) you want to unsubscribe.
4. Click **Unsubscribe & Sync** (4th button in the arrow column,
   amber gradient, shows the selected count in parentheses).
5. Modal opens with a spinner and the step-by-step reference text.
   On completion the modal shows two side-by-side cards per row
   (Marketo / Dynamics) plus the "Email = Do Not Allow" summary.
6. **"Show JSON" toggle** dumps the full result for that row so you
   can copy the exact response.
7. **In Marketo**: open the Person — `unsubscribed = true`.
8. **In Dynamics**: open the Contact — Bulk Email preference flips
   from **Allow** to **Do Not Allow**.

### Expected variations

| Marketo Lead has | Result |
|---|---|
| Active Dynamics Contact match (via `crmContactId` or email) | Both Marketo + Dynamics PATCH succeed. Summary: "Email = Do Not Allow on Dynamics Contact &lt;guid&gt;." |
| Stale `crmContactId`, valid email, real Contact by email | Falls through to email tier, still succeeds. |
| Email that only matches a Dynamics Lead (no Contact) | Marketo updates ✓; Dynamics step skipped (`contact-not-resolvable`). Per spec, Marketo cannot touch Dynamics Lead consent. |
| No identifier on the Marketo row | Should never happen — the SPA filters out rows without an `id`. |
| Marketo write fails (e.g. 403, 5xx) | Row returns `marketo: { ok: false, error: ... }`, Dynamics step skipped. |

### Single-record alternative — "Simulate Unsubscribe" panel

If you don't have Marketo records pulled in SyncView and just want to
test the Dynamics-side patch: there's a panel near the top of SyncView
with **email + contactid inputs** and a "Simulate Unsubscribe" button.
This skips the Marketo PATCH (assumes Marketo already says
unsubscribed=true) and just runs the Dynamics-side handler. Useful for
quick iteration.

---

## Quick reference: failure-mode lookup table

If a sync produces something unexpected, find it here.

| Symptom | Likely cause | Fix |
|---|---|---|
| Marketo Person is missing `crmEntityType` / `crmContactId` / `crmLeadId` after sync | Custom fields not yet created in Marketo Field Management | Click "Set up Marketo fields" in the SyncView banner. If access denied (Marketo error 603), follow the inline manual-setup panel. |
| Marketo Person has no `company`, `billingCity`, etc. | (a) Custom fields exist but the source CRM Account doesn't have those values populated. (b) On a Lead, `companyname` is empty. | Check the source record. The mapper drops null/blank silently. |
| Bundle sync says "Person only — unresolved-account" | Lead's `companyname` doesn't match any CRM Account by accountid/accountnumber/name. Person still gets pushed. | If you want a CRM Account too, create it in Dynamics, then re-sync. |
| Bundle sync row "Failed — account-write-failed" | Companies endpoint either unavailable or returned 5xx | Person is still pushed. If your tenant doesn't expose the Companies endpoint, this is expected — the soft-skip already handles it. |
| Unsubscribe webhook returns 401 | HMAC mismatch (wrong secret) | Verify `MARKETO_WEBHOOK_SECRET` in `.env` matches what's set in your Marketo Smart Campaign webhook step. |
| Unsubscribe webhook 200s but Contact's `donotbulkemail` doesn't change | Authority guard skipped — most likely the Person resolves to a Lead, not a Contact. | Confirm the email/crmContactId is on a Contact in Dynamics, not just a Lead. |
| `Failed — account-write-failed: [610] Requested resource not found` | Companies endpoint not available on this Marketo tenant | Already handled gracefully — Person still pushed. The error log is informational. |
