#!/usr/bin/env node
'use strict';

/**
 * Live HTTP demo runner.
 *
 * Boots the REAL Express app from src/listeners/server.js with leaf I/O
 * mocked (axios → URL-routed router; pg / pg-boss → no-ops). Listens on
 * an ephemeral port. Then fires real HTTP requests against every
 * user-visible endpoint and prints the request + response for each.
 *
 *   node scripts/http-demo.js   OR   npm run demo
 *
 * The point: prove the wiring all the way from the route handler →
 * engine helpers → writers → audit log without any external systems.
 * If any endpoint changes shape, this runner shows it loudly.
 */

const path  = require('path');
const http  = require('http');

process.env.NODE_ENV                = 'test';
process.env.DYNAMICS_TENANT_ID      = 'demo-tenant';
process.env.DYNAMICS_CLIENT_ID      = 'demo-dyn-client';
process.env.DYNAMICS_CLIENT_SECRET  = 'demo-dyn-secret';
process.env.DYNAMICS_RESOURCE_URL   = 'https://demo.crm.dynamics.com';
process.env.DYNAMICS_API_VERSION    = '9.2';
process.env.DYNAMICS_WEBHOOK_SECRET = 'demo-dwh';
process.env.MARKETO_BASE_URL        = 'https://demo.mktorest.com';
process.env.MARKETO_CLIENT_ID       = 'demo-mkto-client';
process.env.MARKETO_CLIENT_SECRET   = 'demo-mkto-secret';
process.env.MARKETO_WEBHOOK_SECRET  = 'demo-mwh';

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

const axios = require('axios');

// Silence app loggers so the demo output stays readable.
const logger = require(path.resolve('src/audit/logger'));
['info','warn','error','debug'].forEach(level => { logger[level] = () => {}; });

const auditDb = require(path.resolve('src/audit/db'));
auditDb._setPool({ query: async () => ({ rows: [] }) });

const { createApp }              = require(path.resolve('src/listeners/server'));
const { _cache: dynTokenCache }  = require(path.resolve('src/auth/dynamics'));
const { _cache: mktoTokenCache } = require(path.resolve('src/auth/marketo'));
const { _resetLeadSchemaCache, _resetCompaniesEndpointFlag } =
  require(path.resolve('src/writers/marketo'));

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
function bad(msg)  { console.log('  ' + C.red + '✗' + C.reset + ' ' + msg); failures += 1; }
function dim(msg)  { console.log('    ' + C.dim + msg + C.reset); }
function check(label, cond) { if (cond) ok(label); else bad(label); }
function pretty(obj) { return C.dim + JSON.stringify(obj) + C.reset; }

// ── HTTP helper that uses the real Node http module against our server ─────
function httpRequest(host, port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host, port, method, path: urlPath,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function logRequest(method, urlPath, body) {
  console.log('  ' + C.cyan + '→' + C.reset + ' ' + C.bold + method + ' ' + urlPath + C.reset);
  if (body) dim('  body: ' + JSON.stringify(body));
}
function logResponse(res) {
  const statusColor = res.status >= 200 && res.status < 300 ? C.green
                    : res.status >= 400                   ? C.red
                    :                                        C.yellow;
  console.log('  ' + C.cyan + '←' + C.reset + ' ' + statusColor + res.status + C.reset);
  if (res.body !== null && res.body !== undefined) {
    const json = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const preview = json.length > 1500 ? json.slice(0, 1500) + '… (truncated)' : json;
    dim('  body: ' + preview);
  }
}

// ── Mock fixtures ──────────────────────────────────────────────────────────
const CONTACT_ROW = {
  contactid:               'c-guid-001',
  statecode:               0,    // active — needed by resolvePerson tier 1
  emailaddress1:           'alice@acme.example',
  firstname:               'Alice',
  lastname:                'Smith',
  jobtitle:                'VP Engineering',
  telephone1:              '555-0100',
  address1_city:           'Auckland',
  _parentcustomerid_value: 'a-guid-001',
};
const ACCOUNT_ROW = {
  accountid:                'a-guid-001',
  name:                     'Acme Ltd',
  accountnumber:            'ACME-001',
  websiteurl:               'https://acme.example',
  telephone1:               '555-9000',
  address1_line1:           '1 Acme Way',
  address1_city:            'Auckland',
  address1_country:         'New Zealand',
  numberofemployees:        250,
  revenue:                  1000000,
};

const FULL_LEAD_SCHEMA = [
  'email','firstName','lastName','phone','title','company','website','mainPhone',
  'numberOfEmployees','annualRevenue','billingStreet','billingCity','billingCountry',
  'billingPostalCode','accountNumber','crmEntityType','crmContactId','crmLeadId',
].map(name => ({ rest: { name } }));

// ── URL-routed axios stub installer ───────────────────────────────────────
function installAxiosFixture(opts = {}) {
  const {
    contacts   = { 'c-guid-001': CONTACT_ROW },
    accounts   = { 'a-guid-001': ACCOUNT_ROW },
    leads      = {},
    leadSchema = FULL_LEAD_SCHEMA,
    schemaStatus = 'ok',          // 'ok' | 'missing' | 'denied'
    companiesUnavailable = false,
  } = opts;

  axios.get = async (url) => {
    if (/\/identity\/oauth\/token/.test(url)) {
      return { data: { access_token: 'mkto-tok', expires_in: 3600 } };
    }
    if (/\/leads\/describe\.json/.test(url)) {
      if (schemaStatus === 'missing') {
        const narrow = ['email','firstName','lastName','company']
          .map(name => ({ rest: { name } }));
        return { data: { success: true, result: narrow } };
      }
      return { data: { success: true, result: leadSchema } };
    }
    // Marketo /lead/{id}.json — handled separately so it doesn't collide
    // with the Dynamics-style by-id matcher below.
    if (/\/rest\/v1\/lead\//.test(url)) {
      return { data: { success: true, result: [{ id: 12345, email: 'alice@acme.example', crmContactId: 'c-guid-001' }] } };
    }
    // Match Dynamics by-id reads only — `/contacts(<id>)`, `/accounts(<id>)`,
    // `/leads(<id>)`. Filter searches like `/contacts?$filter=...` don't
    // match (URL has no parens) and fall through to the empty-list default.
    const m = url.match(/\/(contacts|accounts|leads)\(([^)]+)\)/);
    if (m) {
      const [, kind, id] = m;
      const row = ({ contacts, accounts, leads })[kind] && ({ contacts, accounts, leads })[kind][id];
      if (!row) {
        const e = Object.assign(new Error('not found'), { response: { status: 404 } });
        throw e;
      }
      return { data: row };
    }
    // Default for filter searches and anything else — empty result list.
    return { data: { value: [] } };
  };

  axios.post = async (url, body) => {
    if (/login\.microsoftonline\.com/.test(url)) {
      return { data: { access_token: 'dyn-tok', expires_in: 3600 } };
    }
    // Marketo schema-write
    if (/\/leads\/schema\/fields\.json/.test(url)) {
      if (schemaStatus === 'denied') {
        return { data: { success: false, errors: [{ code: '603', message: 'Access denied' }] } };
      }
      return { data: { success: true, result: [{ status: 'created' }] } };
    }
    // Marketo Companies
    if (/\/companies\/sync\.json/.test(url)) {
      if (companiesUnavailable) {
        const e = Object.assign(new Error('not found'), { response: { status: 404, data: {} } });
        throw e;
      }
      return { data: { success: true, result: [{ id: 9000, status: 'created' }] } };
    }
    // Marketo Leads
    if (/\/leads\.json/.test(url)) {
      return { data: { success: true, result: [{ id: 1000, status: 'created' }] } };
    }
    return { data: {} };
  };

  axios.patch = async () => ({ status: 204 });
}

function reset() {
  dynTokenCache.clear();
  mktoTokenCache.clear();
  _resetLeadSchemaCache();
  _resetCompaniesEndpointFlag();
}

// ── Boot the real Express app on an ephemeral port ────────────────────────
async function bootServer() {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

// ── Demo scenarios ─────────────────────────────────────────────────────────
async function demo() {
  reset();
  installAxiosFixture();

  const { server, port } = await bootServer();
  const HOST = '127.0.0.1';
  console.log('');
  console.log(C.bold + 'Live HTTP demo' + C.reset);
  console.log(C.dim + 'Real Express server bound on http://' + HOST + ':' + port + ' (ephemeral port).' + C.reset);
  console.log(C.dim + 'Leaf I/O (axios, pg, pg-boss) is mocked. Everything else runs for real.' + C.reset);

  // ── 1. /health ─────────────────────────────────────────────────────────
  header('1.  GET /health  — liveness check');
  {
    logRequest('GET', '/health');
    const r = await httpRequest(HOST, port, 'GET', '/health');
    logResponse(r);
    check('200 OK',                  r.status === 200);
    check('status:"ok"',              r.body && r.body.status === 'ok');
    check('service:"dynamics-marketo-sync"', r.body && r.body.service === 'dynamics-marketo-sync');
  }

  // ── 2. /api/marketo/schema-status — fields exist ───────────────────────
  header('2.  GET /api/marketo/schema-status  — schema is fully provisioned');
  {
    logRequest('GET', '/api/marketo/schema-status');
    const r = await httpRequest(HOST, port, 'GET', '/api/marketo/schema-status');
    logResponse(r);
    check('200 OK',           r.status === 200);
    check('ready:true',       r.body && r.body.ready === true);
    check('missing is empty', Array.isArray(r.body.missing) && r.body.missing.length === 0);
  }

  // ── 3. /api/marketo/schema-status — fields missing ─────────────────────
  reset();
  installAxiosFixture({ schemaStatus: 'missing' });
  header('3.  GET /api/marketo/schema-status  — schema MISSING the three custom fields');
  {
    logRequest('GET', '/api/marketo/schema-status');
    const r = await httpRequest(HOST, port, 'GET', '/api/marketo/schema-status');
    logResponse(r);
    check('200 OK',                       r.status === 200);
    check('ready:false',                  r.body && r.body.ready === false);
    check('missing lists all 3 fields',   Array.isArray(r.body.missing) && r.body.missing.length === 3);
    check('  includes crmEntityType',     r.body.missing.includes('crmEntityType'));
    check('  includes crmContactId',      r.body.missing.includes('crmContactId'));
    check('  includes crmLeadId',         r.body.missing.includes('crmLeadId'));
  }

  // ── 4. /api/marketo/setup-custom-fields — happy path ───────────────────
  reset();
  installAxiosFixture();
  header('4.  POST /api/marketo/setup-custom-fields  — happy path (creates the 3 fields)');
  {
    logRequest('POST', '/api/marketo/setup-custom-fields', {});
    const r = await httpRequest(HOST, port, 'POST', '/api/marketo/setup-custom-fields', {});
    logResponse(r);
    check('200 OK',                 r.status === 200);
    check('created:3',              r.body && r.body.created === 3);
    check('failed:0',               r.body && r.body.failed === 0);
    check('no manualSetup payload (success path)', !r.body.manualSetup);
  }

  // ── 5. /api/marketo/setup-custom-fields — Marketo error 603 ────────────
  reset();
  installAxiosFixture({ schemaStatus: 'denied' });
  header('5.  POST /api/marketo/setup-custom-fields  — Marketo returns 603 Access Denied');
  {
    logRequest('POST', '/api/marketo/setup-custom-fields', {});
    const r = await httpRequest(HOST, port, 'POST', '/api/marketo/setup-custom-fields', {});
    logResponse(r);
    check('502 Bad Gateway',           r.status === 502);
    check('accessDenied:true',         r.body && r.body.accessDenied === true);
    check('manualSetup hint included', r.body && r.body.manualSetup);
    check('manualSetup.fields.length=3', r.body.manualSetup && r.body.manualSetup.fields && r.body.manualSetup.fields.length === 3);
    check('manualSetup.permissionFix mentions Read-Write Schema',
          r.body.manualSetup && /Read-Write Schema/.test(r.body.manualSetup.permissionFix || ''));
  }

  // ── 6. /api/transfer/with-company/preview ──────────────────────────────
  reset();
  installAxiosFixture();
  header('6.  POST /api/transfer/with-company/preview  — Contact + Account preview');
  {
    const body = { entity: 'contact', sourceIds: ['c-guid-001'] };
    logRequest('POST', '/api/transfer/with-company/preview', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/transfer/with-company/preview', body);
    logResponse(r);
    check('200 OK',                            r.status === 200);
    check('summary.withCompany=1',             r.body && r.body.summary.withCompany === 1);
    check('row[0].plan="with-company"',        r.body && r.body.rows[0].plan === 'with-company');
    check('row[0].personBody.crmEntityType="contact"', r.body.rows[0].personBody.crmEntityType === 'contact');
    check('row[0].personBody.crmContactId="c-guid-001"', r.body.rows[0].personBody.crmContactId === 'c-guid-001');
    check('row[0].personBody.company="Acme Ltd" (merged from Account)',
          r.body.rows[0].personBody.company === 'Acme Ltd');
    check('row[0].personBody.billingCity="Auckland" (merged from Account)',
          r.body.rows[0].personBody.billingCity === 'Auckland');
    check('row[0].personBody.numberOfEmployees=250',
          r.body.rows[0].personBody.numberOfEmployees === 250);
  }

  // ── 7. /api/transfer/with-company — live ───────────────────────────────
  reset();
  installAxiosFixture();
  header('7.  POST /api/transfer/with-company  — LIVE push (Account + Person)');
  {
    const body = { entity: 'contact', sourceIds: ['c-guid-001'] };
    logRequest('POST', '/api/transfer/with-company', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/transfer/with-company', body);
    logResponse(r);
    check('200 OK',                       r.status === 200);
    check('summary.personsSynced=1',      r.body && r.body.summary.personsSynced === 1);
    check('summary.accountsSynced=1',     r.body && r.body.summary.accountsSynced === 1);
    check('summary.failed=0',             r.body && r.body.summary.failed === 0);
    check('result.plan="with-company"',   r.body.results[0].plan === 'with-company');
    check('result.personSynced=true',     r.body.results[0].personSynced === true);
  }

  // ── 8. /api/transfer/with-company — Companies endpoint 404 ─────────────
  reset();
  installAxiosFixture({ companiesUnavailable: true });
  header('8.  POST /api/transfer/with-company  — Companies endpoint UNAVAILABLE (404)');
  {
    const body = { entity: 'contact', sourceIds: ['c-guid-001'] };
    logRequest('POST', '/api/transfer/with-company', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/transfer/with-company', body);
    logResponse(r);
    check('200 OK (graceful, not 5xx)',         r.status === 200);
    check('summary.personsSynced=1',            r.body.summary.personsSynced === 1);
    check('summary.accountsSynced=0',           r.body.summary.accountsSynced === 0);
    check('summary.failed=0 (account is soft-skipped)', r.body.summary.failed === 0);
    check('result.personSynced=true',           r.body.results[0].personSynced === true);
  }

  // ── 9. /api/transfer/unsubscribe-and-sync ──────────────────────────────
  reset();
  installAxiosFixture();
  header('9.  POST /api/transfer/unsubscribe-and-sync  — Marketo PATCH then Dynamics PATCH');
  {
    const body = { sourceIds: ['12345'] };
    logRequest('POST', '/api/transfer/unsubscribe-and-sync', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/transfer/unsubscribe-and-sync', body);
    logResponse(r);
    check('200 OK',                        r.status === 200);
    check('summary.marketoUpdated=1',      r.body.summary.marketoUpdated === 1);
    check('summary.dynamicsPatched=1',     r.body.summary.dynamicsPatched === 1);
    check('summary.failed=0',              r.body.summary.failed === 0);
    check('result.marketo.ok=true',        r.body.results[0].marketo.ok === true);
    check('result.dynamics.ok=true',       r.body.results[0].dynamics.ok === true);
    check('result.summary mentions "Do Not Allow"',
          /Do Not Allow/.test(r.body.results[0].summary || ''));
  }

  // ── 10. /api/simulate/unsubscribe — single-record trigger ──────────────
  reset();
  installAxiosFixture();
  header('10. POST /api/simulate/unsubscribe  — single-record ad-hoc trigger');
  {
    const body = { crmContactId: 'c-guid-001', email: 'alice@acme.example' };
    logRequest('POST', '/api/simulate/unsubscribe', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/simulate/unsubscribe', body);
    logResponse(r);
    check('200 OK',                          r.status === 200);
    check('ok=true',                         r.body.ok === true);
    check('result.action="update"',          r.body.result && r.body.result.action === 'update');
    check('result.targetId is the Contact GUID', r.body.result.targetId === 'c-guid-001');
    check('hint mentions Patched',           /Patched/.test(r.body.hint || ''));
  }

  // ── 11. /api/transfer/with-company/preview — 400 validation ────────────
  reset();
  installAxiosFixture();
  header('11. POST /api/transfer/with-company/preview  — invalid body (validation)');
  {
    const body = { entity: 'opportunity', sourceIds: [] };
    logRequest('POST', '/api/transfer/with-company/preview', body);
    const r = await httpRequest(HOST, port, 'POST', '/api/transfer/with-company/preview', body);
    logResponse(r);
    check('400 Bad Request',                 r.status === 400);
    check('error mentions entity',           r.body && /entity must be one of/.test(r.body.error || ''));
  }

  server.close();

  console.log('');
  console.log(C.bold + '━'.repeat(76) + C.reset);
  if (failures === 0) {
    console.log('  ' + C.green + C.bold + 'EVERY ENDPOINT BEHAVED AS EXPECTED' + C.reset);
    process.exit(0);
  } else {
    console.log('  ' + C.red + C.bold + failures + ' assertion(s) failed' + C.reset);
    process.exit(1);
  }
}

demo().catch(err => {
  console.error(C.red + 'FATAL:' + C.reset, err.stack || err.message);
  process.exit(1);
});
