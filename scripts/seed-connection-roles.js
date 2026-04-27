#!/usr/bin/env node
'use strict';

/**
 * Seed the six connection roles required by the Contact relationship-flag
 * fields (KAM / Technology / HR / Procurement / Logistics / Finance).
 *
 * Safe to run repeatedly: existing roles are left alone. Missing roles are
 * POSTed with `{ name, category: 1 }` (category 1 = "Business").
 *
 * Usage:
 *   node scripts/seed-connection-roles.js             # create missing roles
 *   node scripts/seed-connection-roles.js --dry-run   # list only
 *
 * Env required (either in process env or .env):
 *   DYNAMICS_TENANT_ID, DYNAMICS_CLIENT_ID, DYNAMICS_CLIENT_SECRET,
 *   DYNAMICS_RESOURCE_URL, DYNAMICS_API_VERSION (optional, default 9.2)
 */

require('dotenv').config();

const axios = require('axios');
const { getDynamicsToken } = require('../src/auth/dynamics');
const { EXPECTED_ROLES }   = require('../src/engine/relationships');

const DRY_RUN = process.argv.includes('--dry-run');

function oDataEscape(v) {
  return String(v).replace(/'/g, "''");
}

function apiBase() {
  const resourceUrl = process.env.DYNAMICS_RESOURCE_URL;
  if (!resourceUrl) {
    throw new Error('DYNAMICS_RESOURCE_URL must be set (either env or .env)');
  }
  const apiVersion = process.env.DYNAMICS_API_VERSION || '9.2';
  return `${resourceUrl}/api/data/v${apiVersion}`;
}

function headers(token) {
  return {
    Authorization:      `Bearer ${token}`,
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
    'Content-Type':     'application/json',
  };
}

async function findRole(base, token, name) {
  const { data } = await axios.get(`${base}/connectionroles`, {
    headers: headers(token),
    params:  {
      $filter: `name eq '${oDataEscape(name)}' and statecode eq 0`,
      $select: 'connectionroleid,name',
      $top:    1,
    },
  });
  return data?.value?.[0] || null;
}

async function createRole(base, token, name) {
  // category 1 = "Business" on the OOTB connectionrole.category picklist.
  const body = { name, category: 1 };
  const { data, headers: respHeaders } = await axios.post(
    `${base}/connectionroles`,
    body,
    { headers: headers(token) },
  );
  let id = data?.connectionroleid || null;
  if (!id && respHeaders) {
    const loc = respHeaders['OData-EntityId'] || respHeaders['odata-entityid'];
    const m = typeof loc === 'string' ? loc.match(/\(([^)]+)\)\s*$/) : null;
    if (m) id = m[1];
  }
  return id;
}

(async function main() {
  const base  = apiBase();
  const token = await getDynamicsToken();

  console.log(`[seed-connection-roles] base=${base} dryRun=${DRY_RUN}`);
  console.log(`[seed-connection-roles] expected roles: ${EXPECTED_ROLES.join(', ')}\n`);

  const results = [];
  for (const name of EXPECTED_ROLES) {
    const existing = await findRole(base, token, name);
    if (existing) {
      console.log(`  [exists]  ${name}  (${existing.connectionroleid})`);
      results.push({ name, action: 'exists', id: existing.connectionroleid });
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [missing] ${name}  (would create, dry-run)`);
      results.push({ name, action: 'would-create' });
      continue;
    }
    try {
      const id = await createRole(base, token, name);
      console.log(`  [created] ${name}  (${id || 'id-unknown'})`);
      results.push({ name, action: 'created', id });
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message;
      console.error(`  [error]   ${name}  (${msg})`);
      results.push({ name, action: 'error', error: msg });
    }
  }

  const errored = results.filter(r => r.action === 'error').length;
  console.log(`\n[seed-connection-roles] done — errors=${errored}`);
  process.exit(errored > 0 ? 1 : 0);
})().catch(err => {
  console.error('[seed-connection-roles] fatal:', err.message);
  process.exit(2);
});
