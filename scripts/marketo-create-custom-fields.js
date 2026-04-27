'use strict';

/**
 * One-shot setup script: creates the three Marketo custom Lead fields the
 * sync needs to push the Contact-vs-Lead differentiator.
 *
 *   crmEntityType   string   "contact" | "lead"
 *   crmContactId    string   Dynamics contactid GUID
 *   crmLeadId       string   Dynamics leadid GUID
 *
 * Usage (from repo root):
 *
 *   node scripts/marketo-create-custom-fields.js
 *
 * Idempotent — re-running is a no-op for fields that already exist.
 *
 * Operators using the SPA can do the same thing by clicking
 * "Set up Marketo fields" in the SyncView banner — both paths share the
 * same helper at src/auth/marketoSchema.js.
 */

require('dotenv').config();
const { createCustomFields } = require('../src/auth/marketoSchema');

async function main() {
  console.log('[setup] Creating custom Lead fields in Marketo…');
  const result = await createCustomFields();
  for (const r of result.results) {
    if (r.status === 'created')         console.log(`  ✓ ${r.name} created`);
    else if (r.status === 'already-exists') console.log(`  · ${r.name} already exists — no change`);
    else                                console.error(`  ✗ ${r.name}: ${r.error}`);
  }
  console.log(
    `\n[setup] done — ${result.created} created, ` +
    `${result.alreadyExisted} already existed, ${result.failed} failed.`,
  );
  if (result.failed > 0) {
    const permErr = result.results.find(r => r.httpStatus === 401 || r.httpStatus === 403);
    if (permErr) {
      console.error(
        '\nHint: HTTP 401/403 from Marketo usually means the API user lacks the\n' +
          '"Read-Write Schema Custom Fields" role permission. Either grant it\n' +
          'temporarily, or ask your Marketo admin to create the fields manually\n' +
          'in Admin → Field Management.',
      );
    }
    process.exit(2);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
