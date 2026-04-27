# Manual Test Playbook

How to verify the two operator-visible flows by hand. Pre-reqs: backend on
`:3000`, SPA on `:5173`, `.env` filled with valid Dynamics + Marketo
credentials, `npm run verify` clean, `db/schema.sql` applied.

The automated suite covers all of this with mocked I/O — see
`tests/integration/marketoUnsubscribeFlow.test.js` and
`tests/unit/bundleSync.test.js` for the wired-up versions.

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
