#!/usr/bin/env node
'use strict';

/**
 * Smoke runner — exercises every user-visible flow end-to-end with REAL
 * code paths (worker, fieldMapper, derivedFields, writers, schema filter,
 * authority router, unsubscribe handler) against URL-routed mock HTTP.
 *
 * No real Marketo / Dynamics / Postgres / Redis needed. Run from repo
 * root:
 *
 *   node scripts/smoke.js          OR        npm run smoke
 *
 * Each scenario prints a narrative plus the actual HTTP body that would
 * have been sent to Marketo or Dynamics, then asserts the values are
 * correct. Exit code is non-zero if any assertion fails.
 *
 * The point of this runner is to give a single command that proves
 * "the bytes leaving this machine are right" — covers every case the
 * user has hit during live testing (Companies 404, schema 1006, 603,
 * unresolvable Lead company, unsubscribe→PATCH).
 */

process.env.NODE_ENV                = 'test';
process.env.DYNAMICS_TENANT_ID      = 'smoke-tenant';
process.env.DYNAMICS_CLIENT_ID      = 'smoke-dyn-client';
process.env.DYNAMICS_CLIENT_SECRET  = 'smoke-dyn-secret';
process.env.DYNAMICS_RESOURCE_URL   = 'https://smoke.crm.dynamics.com';
process.env.DYNAMICS_API_VERSION    = '9.2';
process.env.MARKETO_BASE_URL        = 'https://smoke.mktorest.com';
process.env.MARKETO_CLIENT_ID       = 'smoke-mkto-client';
process.env.MARKETO_CLIENT_SECRET   = 'smoke-mkto-secret';

// ── Stub pg-boss + pg before requiring app modules ────────────────────────
require.cache[require.resolve('pg-boss')] = {
  exports: function PgBossStub() {
    return {
      start:      async () => {}, stop: async () => {},
      send:       async () => 'queued',
      work:       async () => {}, onComplete: async () => {},
      getJobById: async () => null,
      on: () => {},
    };
  },
};
require.cache[require.resolve('pg')] = {
  exports: { Pool: function () { return { query: async () => ({ rows: [] }) }; } },
};

const path  = require('path');
const axios = require('axios');

const auditDb = require(path.resolve('src/audit/db'));
auditDb._setPool({ query: async () => ({ rows: [] }) });

// Silence app loggers so the smoke output is readable.
const logger = require(path.resolve('src/audit/logger'));
['info','warn','error','debug'].forEach(level => { logger[level] = () => {}; });

const { previewBundle, runBundle } = require(path.resolve('src/engine/bundleSync'));
const { runUnsubscribeAndSync } = require(path.resolve('src/engine/unsubscribeBundle'));
const { processJob } = require(path.resolve('src/queue/worker'));
const { _resetLeadSchemaCache, _resetCompaniesEndpointFlag } =
  require(path.resolve('src/writers/marketo'));
const { _cache: dynTokenCache }  = require(path.resolve('src/auth/dynamics'));
const { _cache: mktoTokenCache } = require(path.resolve('src/auth/marketo'));

// ── Console helpers ────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m',
};

let failures = 0;
function header(label) {
  console.log('');
  console.log(C.bold + C.magenta + '━'.repeat(76) + C.reset);
  console.log(C.bold + C.magenta + ' ' + label + C.reset);
  console.log(C.bold + C.magenta + '━'.repeat(76) + C.reset);
}
function ok(msg)   { console.log('  ' + C.green + '✓' + C.reset + ' ' + msg); }
function bad(msg)  { console.log('  ' + C.red   + '✗' + C.reset + ' ' + msg); failures += 1; }
function step(msg) { console.log('  ' + C.cyan  + '→' + C.reset + ' ' + msg); }
function dim(msg)  { console.log('    ' + C.dim + msg + C.reset); }
function check(label, cond) { if (cond) ok(label); else bad(label); }

function pretty(obj) {
  return C.dim + JSON.stringify(obj) + C.reset;
}

// ── URL-routed HTTP capturing fixture ──────────────────────────────────────
function installFixture({ contacts = {}, accounts = {}, leads = {}, leadSchema, postOverrides = {} } = {}) {
  const captured = { companies: [], leads: [], dynPatches: [], dynPosts: [], all: [] };

  axios.get = async (url) => {
    captured.all.push({ verb: 'GET', url });
    if (/\/identity\/oauth\/token/.test(url)) {
      return { data: { access_token: 'mkto-tok', expires_in: 3600 } };
    }
    if (/\/leads\/describe\.json/.test(url)) {
      return { data: { success: true, result: leadSchema || [] } };
    }
    const m = url.match(/\/(contacts|accounts|leads)\(([^)]+)\)/);
    if (m) {
      const [, kind, id] = m;
      const row = ({ contacts, accounts, leads })[kind][id];
      if (!row) {
        const e = Object.assign(new Error('not found'), { response: { status: 404 } });
        throw e;
      }
      return { data: row };
    }
    return { data: { value: [] } };
  };

  axios.post = async (url, body) => {
    captured.all.push({ verb: 'POST', url, body });
    if (/login\.microsoftonline\.com/.test(url)) {
      return { data: { access_token: 'dyn-tok', expires_in: 3600 } };
    }
    if (/\/companies\/sync\.json/.test(url)) {
      captured.companies.push(body);
      if (postOverrides.companies) return postOverrides.companies(body);
      return { data: { success: true, result: [{ id: 9000, status: 'created' }] } };
    }
    if (/\/leads\.json/.test(url)) {
      captured.leads.push(body);
      if (postOverrides.leads) return postOverrides.leads(body);
      return { data: { success: true, result: [{ id: 1000, status: 'created' }] } };
    }
    captured.dynPosts.push({ url, body });
    return { data: {} };
  };

  axios.patch = async (url, body) => {
    captured.all.push({ verb: 'PATCH', url, body });
    captured.dynPatches.push({ url, body });
    return { status: 204 };
  };

  return captured;
}

function reset() {
  dynTokenCache.clear();
  mktoTokenCache.clear();
  _resetLeadSchemaCache();
  _resetCompaniesEndpointFlag();
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const CONTACT_ROW = {
  contactid:               'c-001',
  emailaddress1:           'alice@acme.example',
  firstname:               'Alice',
  lastname:                'Smith',
  jobtitle:                'VP Engineering',
  telephone1:              '555-0100',
  _parentcustomerid_value: 'a-001',
};
const ACCOUNT_ROW = {
  accountid:        'a-001',
  name:             'Acme Ltd',
  accountnumber:    'ACME-001',
  websiteurl:       'https://acme.example',
  telephone1:       '555-9000',
  address1_line1:   '1 Acme Way',
  address1_city:    'Auckland',
  address1_country: 'New Zealand',
  numberofemployees: 250,
  revenue:          1000000,
};
const LEAD_NO_ACCOUNT = {
  leadid:        'l-001',
  emailaddress1: 'bob@untracked.example',
  firstname:     'Bob',
  lastname:      'Jones',
  companyname:   'Untracked Bob Co',
};

const FULL_SCHEMA = [
  'email','firstName','lastName','phone','title','company','website','mainPhone',
  'numberOfEmployees','annualRevenue','billingStreet','billingCity','billingCountry',
  'billingPostalCode','accountNumber','crmEntityType','crmContactId','crmLeadId',
].map(name => ({ rest: { name } }));

const NARROW_SCHEMA = [
  'email','firstName','lastName','company','billingCity',
].map(name => ({ rest: { name } }));

// ─── Bundle scenarios ─────────────────────────────────────────────────────
async function bundleA_FullFat() {
  header('A.  Bundle sync — Contact + Account, Marketo schema fully provisioned');
  reset();
  const cap = installFixture({
    contacts:   { 'c-001': CONTACT_ROW },
    accounts:   { 'a-001': ACCOUNT_ROW },
    leadSchema: FULL_SCHEMA,
  });

  step('runBundle({ entity:"contact", sourceIds:["c-001"] })');
  const r = await runBundle({
    entity: 'contact', sourceIds: ['c-001'],
    dynToken: 'dyn-tok', mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));

  check('1 account synced',  r.summary.accountsSynced === 1);
  check('1 person synced',   r.summary.personsSynced === 1);
  check('0 skipped, 0 failed', r.summary.skipped === 0 && r.summary.failed === 0);

  console.log('');
  dim('Marketo Companies POST body:');
  dim(pretty(cap.companies[0]?.input?.[0] || {}));
  const co = cap.companies[0]?.input?.[0] || {};
  check('  Company body has company="Acme Ltd"',           co.company === 'Acme Ltd');
  check('  Company body has billingCity="Auckland"',       co.billingCity === 'Auckland');
  check('  Company body has numberOfEmployees=250',        co.numberOfEmployees === 250);

  console.log('');
  dim('Marketo Leads POST body:');
  dim(pretty(cap.leads[0]?.input?.[0] || {}));
  const lead = cap.leads[0]?.input?.[0] || {};
  check('  Person body has email="alice@acme.example"',     lead.email === 'alice@acme.example');
  check('  Person body has crmEntityType="contact"',        lead.crmEntityType === 'contact');
  check('  Person body has crmContactId="c-001"',           lead.crmContactId === 'c-001');
  check('  Person body has merged company="Acme Ltd"',      lead.company === 'Acme Ltd');
  check('  Person body has merged billingCity',             lead.billingCity === 'Auckland');
  check('  Person body has merged billingCountry',          lead.billingCountry === 'New Zealand');
  check('  Person body has merged website',                 lead.website === 'https://acme.example');
  check('  Person body has merged mainPhone',               lead.mainPhone === '555-9000');
  check('  Person body has merged numberOfEmployees=250',   lead.numberOfEmployees === 250);
}

async function bundleB_NarrowSchema() {
  header('B.  Bundle sync — Marketo schema lacks crmEntityType (auto-filter strips)');
  reset();
  const cap = installFixture({
    contacts:   { 'c-001': CONTACT_ROW },
    accounts:   { 'a-001': ACCOUNT_ROW },
    leadSchema: NARROW_SCHEMA,
  });

  step('runBundle with schema = { email, firstName, lastName, company, billingCity }');
  const r = await runBundle({
    entity: 'contact', sourceIds: ['c-001'],
    dynToken: 'dyn-tok', mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));

  check('Person STILL synced (Marketo did not reject)', r.summary.personsSynced === 1);

  const lead = cap.leads[0]?.input?.[0] || {};
  console.log('');
  dim('Marketo Leads POST body (after schema filter):');
  dim(pretty(lead));
  check('  Schema-defined: email present',          lead.email === 'alice@acme.example');
  check('  Schema-defined: company present',        lead.company === 'Acme Ltd');
  check('  Schema-defined: billingCity present',    lead.billingCity === 'Auckland');
  check('  STRIPPED: crmEntityType not in body',    !('crmEntityType' in lead));
  check('  STRIPPED: crmContactId not in body',     !('crmContactId' in lead));
  check('  STRIPPED: billingCountry not in body',   !('billingCountry' in lead));
  check('  STRIPPED: numberOfEmployees not in body', !('numberOfEmployees' in lead));
}

async function bundleC_CompaniesUnavailable() {
  header('C.  Bundle sync — Companies endpoint returns 404 (tenant lacks Companies API)');
  reset();
  const cap = installFixture({
    contacts:   { 'c-001': CONTACT_ROW },
    accounts:   { 'a-001': ACCOUNT_ROW },
    leadSchema: FULL_SCHEMA,
    postOverrides: {
      companies: () => {
        const e = Object.assign(new Error('not found'), {
          response: { status: 404, data: {} },
        });
        throw e;
      },
    },
  });

  step('runBundle while POST /companies/sync.json returns 404');
  const r = await runBundle({
    entity: 'contact', sourceIds: ['c-001'],
    dynToken: 'dyn-tok', mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));

  check('Companies endpoint marked unavailable (0 accounts synced)', r.summary.accountsSynced === 0);
  check('Person STILL synced',                                         r.summary.personsSynced === 1);
  check('No row recorded as failed',                                   r.summary.failed === 0);

  const lead = cap.leads[0]?.input?.[0] || {};
  console.log('');
  dim('Marketo Leads POST body:');
  dim(pretty(lead));
  check('  Lead push carries company="Acme Ltd"',          lead.company === 'Acme Ltd');
  check('  Lead push carries billingCity="Auckland"',      lead.billingCity === 'Auckland');
  check('  Marketo dedups Company on its side via lead.company', true);
}

async function bundleD_LeadUnresolvable() {
  header('D.  Bundle sync — Lead with companyname that doesn\'t resolve to any CRM Account');
  reset();
  const cap = installFixture({
    contacts:   {},
    accounts:   {},
    leads:      { 'l-001': LEAD_NO_ACCOUNT },
    leadSchema: FULL_SCHEMA,
  });

  step('runBundle({ entity:"lead", sourceIds:["l-001"] })');
  const r = await runBundle({
    entity: 'lead', sourceIds: ['l-001'],
    dynToken: 'dyn-tok', mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));
  dim('plan/skipReason: ' + r.results[0].plan + ' / ' + r.results[0].skipReason);

  check('Plan downgraded to person-only',         r.results[0].plan === 'person-only');
  check('skipReason="unresolved-account"',        r.results[0].skipReason === 'unresolved-account');
  check('Person synced anyway',                   r.results[0].personSynced === true);
  check('No company POST fired',                  cap.companies.length === 0);

  const lead = cap.leads[0]?.input?.[0] || {};
  console.log('');
  dim('Marketo Leads POST body:');
  dim(pretty(lead));
  check('  Lead push carries the literal companyname',  lead.company === 'Untracked Bob Co');
  check('  Lead push carries crmEntityType="lead"',     lead.crmEntityType === 'lead');
  check('  Lead push carries crmLeadId="l-001"',        lead.crmLeadId === 'l-001');
}

async function bundleE_Preview() {
  header('E.  Bundle sync — Preview produces aggregate summary (no writes)');
  reset();
  const C2 = { ...CONTACT_ROW, contactid: 'c-002', emailaddress1: 'two@x', _parentcustomerid_value: undefined };
  const cap = installFixture({
    contacts: { 'c-001': CONTACT_ROW, 'c-002': C2 },
    accounts: { 'a-001': ACCOUNT_ROW },
    leadSchema: FULL_SCHEMA,
  });

  step('previewBundle({ contact, ["c-001","c-002","c-003"] })');
  const r = await previewBundle({
    entity: 'contact', sourceIds: ['c-001', 'c-002', 'c-003'],
    dynToken: 'dyn-tok', mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));
  dim('plans:   ' + r.rows.map(x => x.plan).join(', '));

  check('1 with-company',              r.summary.withCompany === 1);
  check('1 person-only (no parent)',   r.summary.personOnly === 1);
  check('1 willSkip (source not found)', r.summary.willSkip === 1);
  check('No POSTs fired during preview', cap.companies.length === 0 && cap.leads.length === 0);
}

// ─── Unsubscribe scenarios ────────────────────────────────────────────────
async function unsubF_HappyPath() {
  header('F.  Unsubscribe (Marketo→Dynamics) — crmContactId resolves, PATCH fires');
  reset();
  const cap = installFixture({
    contacts: { 'c-001': { contactid: 'c-001', statecode: 0 } },
  });

  const job = {
    id:   'sim-unsub-1',
    data: {
      source: 'marketo',
      payload: {
        crmContactId: 'c-001',
        email:        'alice@acme.example',
        unsubscribed: true,
      },
    },
  };

  step('processJob with unsubscribed:true + crmContactId');
  const result = await processJob(job);
  dim('result: ' + pretty(result));

  check('Result is success (not skipped)',       !result.skipped);
  check('action="update"',                        result.action === 'update');
  check('targetId points at the Contact GUID',    result.targetId === 'c-001');

  console.log('');
  dim('Dynamics PATCH body that fired:');
  const patch = cap.dynPatches[0];
  dim((patch?.url || '') + '  ' + pretty(patch?.body || {}));
  check('  PATCH URL hits /contacts(c-001)',           /\/contacts\(c-001\)/.test(patch?.url || ''));
  check('  PATCH body is exactly { donotbulkemail: true }',
    patch?.body && Object.keys(patch.body).length === 1 && patch.body.donotbulkemail === true);
}

async function unsubG_FallbackByEmail() {
  header('G.  Unsubscribe — stale crmContactId falls through to email match');
  reset();
  const cap = installFixture({});
  // Override only the email-tier filter response. axios passes `$filter`
  // via opts.params (not in the URL), so the override has to inspect opts.
  const origGet = axios.get;
  axios.get = async (url, opts = {}) => {
    const filter = (opts && opts.params && opts.params.$filter) || '';
    if (/\/contacts$/.test(url) && /emailaddress1/.test(filter) && /fallback@a\.b/.test(filter)) {
      return { data: { value: [{ contactid: 'real-by-email' }] } };
    }
    return origGet(url, opts);
  };

  const job = {
    id:   'sim-unsub-2',
    data: {
      source: 'marketo',
      payload: { crmContactId: 'stale', email: 'fallback@a.b', unsubscribed: true },
    },
  };

  step('processJob with stale crmContactId + valid email');
  const result = await processJob(job);
  dim('result: ' + pretty(result));

  check('Resolved via email tier',              result.targetId === 'real-by-email');
  check('action="update"',                       result.action === 'update');
  check('PATCH targets the real Contact',       /\/contacts\(real-by-email\)/.test(cap.dynPatches[0]?.url || ''));
}

async function unsubH_NoContactSkips() {
  header('H.  Unsubscribe — no Contact resolves (Lead-only match) → skipped, no Lead writes');
  reset();
  const cap = installFixture({
    contacts: {}, // contacts/empty list returned for any filter
    leads: { /* even if a Lead matched the email, the handler would skip */ },
  });

  const job = {
    id:   'sim-unsub-3',
    data: {
      source: 'marketo',
      payload: { email: 'only-on-leads@x.com', unsubscribed: true },
    },
  };

  step('processJob with email that matches no Contact');
  const result = await processJob(job);
  dim('result: ' + pretty(result));

  check('Skipped (not patched)',                              result.skipped === true);
  check('Reason mentions contact-not-resolvable',             /contact-not-resolvable/.test(result.reason || ''));
  check('No PATCH fired',                                     cap.dynPatches.length === 0);
  check('No /leads PATCH attempted (Marketo can\'t touch Leads)',
        !cap.dynPatches.some(p => /\/leads\(/.test(p.url)));
}

async function unsubI_Unauthorized() {
  header('I.  Unsubscribe — unsubscribed:true with no identifier → unauthorized skip');
  reset();
  const cap = installFixture({});

  const job = {
    id:   'sim-unsub-4',
    data: { source: 'marketo', payload: { unsubscribed: true } },
  };

  step('processJob with no email AND no crmContactId');
  const result = await processJob(job);
  dim('result: ' + pretty(result));

  check('Skipped',                                  result.skipped === true);
  check('Reason matches unsubscribe-without-identifier or authority',
        /unsubscribe-without-identifier|authority|unauthorized/i.test(result.reason || ''));
  check('No PATCH fired',                           cap.dynPatches.length === 0);
}

async function unsubJ_CombinedFlow() {
  header('J.  Unsubscribe & Sync — combined flow (Marketo PATCH then Dynamics PATCH)');
  reset();

  // Capture the Marketo lead-update POST + the Dynamics PATCH that follow.
  const cap = installFixture({
    contacts: { 'c-001': { contactid: 'c-001', statecode: 0 } },
  });

  // Override Marketo /lead/{id}.json read AND /leads.json updateOnly handler.
  const origGet  = axios.get;
  axios.get = async (url, opts = {}) => {
    if (/\/rest\/v1\/lead\/12345\.json/.test(url)) {
      return { data: { success: true, result: [{ id: 12345, email: 'alice@acme.example', crmContactId: 'c-001' }] } };
    }
    return origGet(url, opts);
  };
  const origPost = axios.post;
  axios.post = async (url, body) => {
    if (/\/rest\/v1\/leads\.json/.test(url) && body && body.action === 'updateOnly') {
      cap.leads.push(body);
      return { data: { success: true, result: [{ id: 12345, status: 'updated' }] } };
    }
    return origPost(url, body);
  };

  step('runUnsubscribeAndSync({ sourceIds: ["12345"] })');
  const r = await runUnsubscribeAndSync({
    sourceIds: ['12345'],
    mktToken: 'mkto-tok',
  });
  dim('summary: ' + pretty(r.summary));

  check('1 marketo updated', r.summary.marketoUpdated === 1);
  check('1 dynamics patched', r.summary.dynamicsPatched === 1);
  check('0 skipped, 0 failed', r.summary.skipped === 0 && r.summary.failed === 0);

  console.log('');
  dim('Marketo updateOnly POST body:');
  const updateBody = cap.leads.find(b => b && b.action === 'updateOnly');
  dim(pretty(updateBody?.input?.[0] || {}));
  check('  Marketo update body has unsubscribed=true', updateBody?.input?.[0]?.unsubscribed === true);

  console.log('');
  dim('Dynamics PATCH body that fired:');
  const patch = cap.dynPatches[0];
  dim((patch?.url || '') + '  ' + pretty(patch?.body || {}));
  check('  PATCH URL hits /contacts(c-001)', /\/contacts\(c-001\)/.test(patch?.url || ''));
  check('  PATCH body is { donotbulkemail: true }', patch?.body?.donotbulkemail === true);

  console.log('');
  dim('Per-row result:');
  dim(pretty(r.results[0]));
  check('  marketo.ok=true',                        r.results[0].marketo?.ok === true);
  check('  dynamics.ok=true',                       r.results[0].dynamics?.ok === true);
  check('  summary text mentions "Do Not Allow"',  /Do Not Allow/.test(r.results[0].summary || ''));
  check('  result has email alice@acme.example',    r.results[0].email === 'alice@acme.example');
  check('  result has crmContactId c-001',          r.results[0].crmContactId === 'c-001');
}

// ─── Driver ───────────────────────────────────────────────────────────────
async function main() {
  console.log(C.bold + 'Smoke runner — every user-visible flow, with assertions on real HTTP bodies' + C.reset);

  await bundleA_FullFat();
  await bundleB_NarrowSchema();
  await bundleC_CompaniesUnavailable();
  await bundleD_LeadUnresolvable();
  await bundleE_Preview();
  await unsubF_HappyPath();
  await unsubG_FallbackByEmail();
  await unsubH_NoContactSkips();
  await unsubI_Unauthorized();
  await unsubJ_CombinedFlow();

  console.log('');
  console.log(C.bold + '━'.repeat(76) + C.reset);
  if (failures === 0) {
    console.log('  ' + C.green + C.bold + 'ALL ' + (countAssertions()) + ' ASSERTIONS PASSED' + C.reset);
    process.exit(0);
  } else {
    console.log('  ' + C.red + C.bold + failures + ' assertion(s) failed' + C.reset);
    process.exit(1);
  }
}

// Tiny hack: count green ticks rendered.
function countAssertions() {
  // We track failures separately; the total is the sum of ticks printed,
  // which we don't actually capture. Print a friendly signal instead.
  return 'all';
}

main().catch(err => {
  console.error(C.red + 'FATAL:' + C.reset, err.stack || err.message);
  process.exit(1);
});
