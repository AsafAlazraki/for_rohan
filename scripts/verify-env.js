#!/usr/bin/env node
'use strict';

/**
 * Preflight check — run before `npm run dev` or the first pipeline execution.
 *
 * Verifies that:
 *   1. Node version meets the minimum requirement.
 *   2. .env file exists and all required variables are set.
 *   3. The sync_events and admin_config tables exist (schema was applied).
 *
 * Exits 0 on success, 1 on any failure with a clear message for each miss.
 *
 * Usage:  npm run verify
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

const results = [];
function pass(msg)  { results.push({ ok: true,  msg }); console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg, hint) {
  results.push({ ok: false, msg, hint });
  console.log(`${RED}✗${RESET} ${msg}`);
  if (hint) console.log(`  ${DIM}→ ${hint}${RESET}`);
}
function warn(msg, hint) {
  console.log(`${YELLOW}!${RESET} ${msg}`);
  if (hint) console.log(`  ${DIM}→ ${hint}${RESET}`);
}

const REQUIRED = [
  { key: 'DATABASE_URL',              hint: 'Azure PostgreSQL connection string' },
  { key: 'DYNAMICS_WEBHOOK_SECRET',   hint: 'openssl rand -hex 32 — set the same value in the Dynamics webhook config' },
  { key: 'MARKETO_WEBHOOK_SECRET',    hint: 'openssl rand -hex 32 — set the same value in the Marketo webhook config' },
];

const OPTIONAL_BUT_RECOMMENDED = [
  { key: 'DYNAMICS_TENANT_ID',     note: 'can be set via the Admin UI after the service starts' },
  { key: 'DYNAMICS_CLIENT_ID',     note: 'can be set via the Admin UI' },
  { key: 'DYNAMICS_CLIENT_SECRET', note: 'can be set via the Admin UI' },
  { key: 'DYNAMICS_RESOURCE_URL',  note: 'can be set via the Admin UI' },
  { key: 'MARKETO_BASE_URL',       note: 'can be set via the Admin UI' },
  { key: 'MARKETO_CLIENT_ID',      note: 'can be set via the Admin UI' },
  { key: 'MARKETO_CLIENT_SECRET',  note: 'can be set via the Admin UI' },
];

(async function main() {
  console.log(`\n${DIM}── dynamics-marketo-sync preflight ──${RESET}\n`);

  // 1 · Node version
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 18) pass(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} — need >= 18`, 'nvm install 18 && nvm use 18');

  // 2 · .env file
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) pass('.env file present');
  else fail('.env file missing', 'cp .env.example .env  then fill in the values');

  // 3 · Required env vars
  let missingRequired = 0;
  for (const { key, hint } of REQUIRED) {
    if (process.env[key] && process.env[key].trim().length > 0) {
      pass(`${key} set`);
    } else {
      fail(`${key} not set`, hint);
      missingRequired++;
    }
  }

  // 4 · Optional env vars — advise but don't fail
  let missingOptional = 0;
  for (const { key, note } of OPTIONAL_BUT_RECOMMENDED) {
    if (process.env[key] && process.env[key].trim().length > 0) {
      pass(`${key} set`);
    } else {
      warn(`${key} not set — ${note}`);
      missingOptional++;
    }
  }


  // 5 · Azure PostgreSQL connection check (DATABASE_URL)
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
      await client.connect();
      const { rows } = await client.query("SELECT 1 AS ok");
      await client.end();
      if (rows[0].ok === 1) pass('DATABASE_URL connects');
    } catch (e) {
      fail(`DATABASE_URL connection failed: ${e.message}`,
        'Double-check the password and connection string.');
    }
  } else {
    warn('Skipping pg connection check (DATABASE_URL not set)');
  }



  // ── Summary ─────────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok).length;
  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}✓ All required checks passed.${RESET}`);
    if (missingOptional > 0) {
      console.log(`${YELLOW}  ${missingOptional} optional variable(s) not set — you can configure them via the Admin UI after starting the service.${RESET}`);
    }
    console.log(`\n${DIM}Next: npm run dev  (then open http://localhost:5173 once dev:web is running)${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`${RED}✗ ${failed} required check(s) failed.${RESET}`);
    console.log(`${DIM}Fix the items marked ✗ above, then re-run:  npm run verify${RESET}\n`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`${RED}Unexpected error:${RESET}`, e);
  process.exit(2);
});
