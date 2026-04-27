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
 * Reads MARKETO_BASE_URL / MARKETO_CLIENT_ID / MARKETO_CLIENT_SECRET from
 * environment OR admin_config (whichever resolves first via the standard
 * config loader). Idempotent — re-running is a no-op if the fields already
 * exist (Marketo returns `status: "skipped"` with code 1009 = "Field already
 * exists" which we treat as success).
 *
 * Requires: the Marketo API user must have the
 * "Read-Write Schema Custom Fields" role permission. If the API user is
 * read-only on schema, this script fails — ask your Marketo admin to either
 * (a) grant that permission temporarily or (b) create the three fields by
 * hand in Admin → Field Management.
 */

require('dotenv').config();
const axios = require('axios');
const { getConfig } = require('../src/config/loader');
const { getMarketoToken } = require('../src/auth/marketo');

const FIELDS = [
  {
    name:        'crmEntityType',
    displayName: 'CRM Entity Type',
    dataType:    'string',
    description: 'Source CRM entity classification — "contact" or "lead".',
  },
  {
    name:        'crmContactId',
    displayName: 'CRM Contact ID',
    dataType:    'string',
    description: 'Dynamics CRM contactid GUID (set when source entity is a Contact).',
  },
  {
    name:        'crmLeadId',
    displayName: 'CRM Lead ID',
    dataType:    'string',
    description: 'Dynamics CRM leadid GUID (set when source entity is a Lead).',
  },
];

async function main() {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) {
    console.error('FATAL: MARKETO_BASE_URL is not set (env or admin_config).');
    process.exit(1);
  }

  let token;
  try {
    token = await getMarketoToken();
  } catch (err) {
    console.error('FATAL: could not obtain Marketo token —', err.message);
    process.exit(1);
  }

  console.log(`[setup] Creating ${FIELDS.length} custom Lead field(s) on ${baseUrl}…`);

  let created = 0;
  let alreadyExisted = 0;
  let failed = 0;

  for (const field of FIELDS) {
    try {
      const { data } = await axios.post(
        `${baseUrl}/rest/v1/leads/schema/fields.json`,
        { input: [field] },
        {
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!data.success) {
        failed += 1;
        console.error(`  ✗ ${field.name}: ${JSON.stringify(data.errors)}`);
        continue;
      }

      const hit = data.result?.[0];
      if (!hit) {
        failed += 1;
        console.error(`  ✗ ${field.name}: empty result`);
        continue;
      }

      // Marketo's per-record skip with code 1009 ("Field already exists") is
      // exactly the success-on-re-run case for an idempotent setup.
      const reasons = Array.isArray(hit.reasons) ? hit.reasons : [];
      const alreadyExists = reasons.some(r => String(r.code) === '1009' || /already exists/i.test(r.message || ''));

      if (hit.status === 'created') {
        created += 1;
        console.log(`  ✓ ${field.name} created (${field.dataType})`);
      } else if (alreadyExists || hit.status === 'skipped') {
        alreadyExisted += 1;
        console.log(`  · ${field.name} already exists — no change`);
      } else {
        failed += 1;
        const msg = reasons.map(r => `${r.code}:${r.message}`).join('; ') || hit.status;
        console.error(`  ✗ ${field.name}: ${msg}`);
      }
    } catch (err) {
      failed += 1;
      const detail = err.response?.data?.errors
        ? JSON.stringify(err.response.data.errors)
        : err.message;
      console.error(`  ✗ ${field.name}: ${detail}`);
      // 401/403 commonly means the API user lacks the schema-write permission.
      if (err.response?.status === 401 || err.response?.status === 403) {
        console.error(
          `\nHint: HTTP ${err.response.status} usually means the API user does not have the\n` +
            `"Read-Write Schema Custom Fields" role permission. Either grant it temporarily\n` +
            `or ask your Marketo admin to create the fields manually in Admin → Field Management.`,
        );
        break;
      }
    }
  }

  console.log(
    `\n[setup] done — ${created} created, ${alreadyExisted} already existed, ${failed} failed.`,
  );

  if (failed > 0) process.exit(2);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
