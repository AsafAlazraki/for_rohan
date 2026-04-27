'use strict';

/**
 * End-to-end bundle-sync flow.
 *
 * Mocks ONLY leaf I/O (axios, pg, pg-boss). Every other code path runs
 * for real: route handler → bundleSync helper → fieldMapper → derivedFields
 * → writers (with the schema-filter auto-drop) → audit logger.
 *
 * Each test asserts on the actual HTTP body sent to Marketo, so a
 * regression in any in-between layer fails loudly. Mocks are URL-routed
 * (not order-based) so the test is robust to side-call additions.
 */

const mockPgQuery = jest.fn();

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));

jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:      jest.fn().mockResolvedValue(undefined),
  stop:       jest.fn().mockResolvedValue(undefined),
  send:       jest.fn().mockResolvedValue('queued'),
  work:       jest.fn().mockResolvedValue(undefined),
  onComplete: jest.fn().mockResolvedValue(undefined),
  getJobById: jest.fn(),
  on:         jest.fn(),
})));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockPgQuery })),
}));

const request = require('supertest');
const axios   = require('axios');

const { createApp }              = require('../../src/listeners/server');
const { _cache: dynTokenCache }  = require('../../src/auth/dynamics');
const { _cache: mktoTokenCache } = require('../../src/auth/marketo');
const { _setPool }               = require('../../src/audit/db');
const { _resetLeadSchemaCache, _resetCompaniesEndpointFlag } = require('../../src/writers/marketo');

beforeAll(() => {
  process.env.DYNAMICS_TENANT_ID      = 'flow-tenant';
  process.env.DYNAMICS_CLIENT_ID      = 'flow-dyn-client';
  process.env.DYNAMICS_CLIENT_SECRET  = 'flow-dyn-secret';
  process.env.DYNAMICS_RESOURCE_URL   = 'https://flow.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION    = '9.2';
  process.env.DYNAMICS_WEBHOOK_SECRET = 'flow-dwh';
  process.env.MARKETO_BASE_URL        = 'https://flow.mktorest.com';
  process.env.MARKETO_CLIENT_ID       = 'flow-mkto-client';
  process.env.MARKETO_CLIENT_SECRET   = 'flow-mkto-secret';
  process.env.MARKETO_WEBHOOK_SECRET  = 'flow-mwh';
  process.env.DATABASE_URL            = 'postgres://test:test@localhost/test';
});

afterAll(() => {
  for (const k of [
    'DYNAMICS_TENANT_ID','DYNAMICS_CLIENT_ID','DYNAMICS_CLIENT_SECRET',
    'DYNAMICS_RESOURCE_URL','DYNAMICS_API_VERSION','DYNAMICS_WEBHOOK_SECRET',
    'MARKETO_BASE_URL','MARKETO_CLIENT_ID','MARKETO_CLIENT_SECRET',
    'MARKETO_WEBHOOK_SECRET','DATABASE_URL',
  ]) delete process.env[k];
});

beforeEach(() => {
  jest.clearAllMocks();
  dynTokenCache.clear();
  mktoTokenCache.clear();
  _resetLeadSchemaCache();
  _resetCompaniesEndpointFlag();
  _setPool({ query: mockPgQuery });
  mockPgQuery.mockResolvedValue({ rows: [] });
});

// ── Fixtures ────────────────────────────────────────────────────────────────
const CONTACT_ROW = {
  contactid:               'c-guid-001',
  emailaddress1:           'alice@acme.example',
  firstname:               'Alice',
  lastname:                'Smith',
  jobtitle:                'VP Engineering',
  telephone1:              '555-0100',
  address1_city:           'Auckland',
  address1_postalcode:     '1010',
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
  address1_postalcode:      '1010',
  numberofemployees:        250,
  revenue:                  1000000,
};

const FULL_LEAD_SCHEMA = [
  'email','firstName','lastName','phone','title',
  'company','website','mainPhone','numberOfEmployees','annualRevenue',
  'billingStreet','billingCity','billingCountry','billingPostalCode',
  'accountNumber','crmEntityType','crmContactId','crmLeadId',
].map(name => ({ rest: { name } }));

// ── URL-routed mock builders ────────────────────────────────────────────────
function makeRouter({ contacts = {}, accounts = {}, leadSchema = FULL_LEAD_SCHEMA } = {}) {
  // axios.get router — returns whatever the URL implies. Anything not
  // matched returns an empty list (safe default for picklist/lookup probes).
  axios.get.mockImplementation((url, opts = {}) => {
    // Marketo identity (token)
    if (/\/identity\/oauth\/token/.test(url)) {
      return Promise.resolve({ data: { access_token: 'mkto-tok', expires_in: 3600 } });
    }
    // Marketo lead schema
    if (/\/leads\/describe\.json/.test(url)) {
      return Promise.resolve({ data: { success: true, result: leadSchema } });
    }
    // Dynamics contact by id
    const contactById = url.match(/\/contacts\(([^)]+)\)/);
    if (contactById && contacts[contactById[1]]) {
      return Promise.resolve({ data: contacts[contactById[1]] });
    }
    // Dynamics account by id
    const accountById = url.match(/\/accounts\(([^)]+)\)/);
    if (accountById && accounts[accountById[1]]) {
      return Promise.resolve({ data: accounts[accountById[1]] });
    }
    // Dynamics 404 for unmatched ids
    if (contactById || accountById) {
      const e = Object.assign(new Error('not found'), { response: { status: 404 } });
      return Promise.reject(e);
    }
    // Account search by filter (resolveAccount)
    if (/\/accounts\?/.test(url) || /\/accounts$/.test(url)) {
      return Promise.resolve({ data: { value: [] } });
    }
    // Contact search by filter
    if (/\/contacts\?/.test(url) || /\/contacts$/.test(url)) {
      return Promise.resolve({ data: { value: [] } });
    }
    // EntityDefinitions / OptionSet / Connection roles — optional/empty
    return Promise.resolve({ data: { value: [] } });
  });
}

function defaultPostRouter() {
  axios.post.mockImplementation((url, body) => {
    // Dynamics token
    if (/login\.microsoftonline\.com/.test(url)) {
      return Promise.resolve({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
    }
    // Marketo Companies sync — default: success, returns id 9000
    if (/\/companies\/sync\.json/.test(url)) {
      return Promise.resolve({
        data: { success: true, result: [{ id: 9000, status: 'created' }] },
      });
    }
    // Marketo Leads — default: success, returns id 1000
    if (/\/leads\.json/.test(url)) {
      return Promise.resolve({
        data: { success: true, result: [{ id: 1000, status: 'created' }] },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

function findCallByUrl(mockFn, urlPattern) {
  const found = mockFn.mock.calls.find(([url]) => urlPattern.test(url));
  return found ? { url: found[0], body: found[1] } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PREVIEW endpoint — returns merged Person body + Account body
// ─────────────────────────────────────────────────────────────────────────────
it('PREVIEW: Person body carries merged company info (company + billingCity + ...)', async () => {
  const app = createApp();
  makeRouter({
    contacts: { 'c-guid-001': CONTACT_ROW },
    accounts: { 'a-guid-001': ACCOUNT_ROW },
  });
  defaultPostRouter();

  const httpRes = await request(app)
    .post('/api/transfer/with-company/preview')
    .set('Content-Type', 'application/json')
    .send({ entity: 'contact', sourceIds: ['c-guid-001'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary).toMatchObject({
    total: 1, withCompany: 1, personOnly: 0, willSkip: 0, errors: 0,
  });

  const row = httpRes.body.rows[0];
  expect(row.plan).toBe('with-company');
  expect(row.accountId).toBe('a-guid-001');
  expect(row.personBody).toMatchObject({
    email:              'alice@acme.example',
    firstName:          'Alice',
    crmEntityType:      'contact',
    crmContactId:       'c-guid-001',
    company:            'Acme Ltd',
    accountNumber:      'ACME-001',
    website:            'https://acme.example',
    mainPhone:          '555-9000',
    billingStreet:      '1 Acme Way',
    billingCity:        'Auckland',
    billingCountry:     'New Zealand',
    billingPostalCode:  '1010',
    numberOfEmployees:  250,
    annualRevenue:      1000000,
  });
  expect(row.personBody).not.toHaveProperty('crmLeadId');
  expect(row.accountBody).toMatchObject({
    company:        'Acme Ltd',
    billingCity:    'Auckland',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIVE endpoint — Person body sent to Marketo carries full company info
// ─────────────────────────────────────────────────────────────────────────────
it('LIVE: writeToMarketo body includes merged company info + crmEntityType + crmContactId', async () => {
  const app = createApp();
  makeRouter({
    contacts: { 'c-guid-001': CONTACT_ROW },
    accounts: { 'a-guid-001': ACCOUNT_ROW },
  });
  defaultPostRouter();

  const httpRes = await request(app)
    .post('/api/transfer/with-company')
    .set('Content-Type', 'application/json')
    .send({ entity: 'contact', sourceIds: ['c-guid-001'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary).toMatchObject({
    total: 1, personsSynced: 1, accountsSynced: 1, skipped: 0, failed: 0,
  });

  // ── Marketo Companies — body shape ──────────────────────────────────────
  const companyCall = findCallByUrl(axios.post, /\/companies\/sync\.json/);
  expect(companyCall).not.toBeNull();
  expect(companyCall.body).toMatchObject({
    action:   'createOrUpdate',
    dedupeBy: 'dedupeFields',
  });
  expect(companyCall.body.input[0]).toMatchObject({
    company:           'Acme Ltd',
    accountNumber:     'ACME-001',
    website:           'https://acme.example',
    billingCity:       'Auckland',
    billingCountry:    'New Zealand',
    numberOfEmployees: 250,
  });

  // ── Marketo Leads — body shape (the hero assertion) ─────────────────────
  const leadCall = findCallByUrl(axios.post, /\/leads\.json/);
  expect(leadCall).not.toBeNull();
  expect(leadCall.body).toMatchObject({
    action:      'createOrUpdate',
    lookupField: 'email',
  });
  expect(leadCall.body.input[0]).toMatchObject({
    email:             'alice@acme.example',
    firstName:         'Alice',
    title:             'VP Engineering',
    crmEntityType:     'contact',
    crmContactId:      'c-guid-001',
    company:           'Acme Ltd',
    billingCity:       'Auckland',
    billingCountry:    'New Zealand',
    website:           'https://acme.example',
    mainPhone:         '555-9000',
    numberOfEmployees: 250,
  });

  // ── Two audit rows: one for the Account, one for the Person ─────────────
  const auditCalls = mockPgQuery.mock.calls.filter(([sql]) =>
    /INSERT INTO sync_events/i.test(sql),
  );
  expect(auditCalls.length).toBe(2);
  expect(auditCalls[0][1]).toEqual(expect.arrayContaining([
    'dynamics', 'marketo', 'success', 'manual', 'manual:sync-with-company',
  ]));
  expect(auditCalls[1][1]).toEqual(expect.arrayContaining([
    'dynamics', 'marketo', 'success', 'manual', 'manual:sync-with-company',
  ]));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Companies endpoint 404 — Person push still succeeds with merged fields
// ─────────────────────────────────────────────────────────────────────────────
it('Companies endpoint 404 → Person push still carries the merged company info', async () => {
  const app = createApp();
  makeRouter({
    contacts: { 'c-guid-001': CONTACT_ROW },
    accounts: { 'a-guid-001': ACCOUNT_ROW },
  });
  axios.post.mockImplementation((url) => {
    if (/login\.microsoftonline\.com/.test(url)) {
      return Promise.resolve({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
    }
    if (/\/companies\/sync\.json/.test(url)) {
      const e = Object.assign(new Error('not found'), { response: { status: 404, data: {} } });
      return Promise.reject(e);
    }
    if (/\/leads\.json/.test(url)) {
      return Promise.resolve({
        data: { success: true, result: [{ id: 1000, status: 'created' }] },
      });
    }
    return Promise.resolve({ data: {} });
  });

  const httpRes = await request(app)
    .post('/api/transfer/with-company')
    .set('Content-Type', 'application/json')
    .send({ entity: 'contact', sourceIds: ['c-guid-001'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary).toMatchObject({
    total: 1, personsSynced: 1, accountsSynced: 0, skipped: 0, failed: 0,
  });

  // Lead push still has the merged fields.
  const leadCall = findCallByUrl(axios.post, /\/leads\.json/);
  expect(leadCall.body.input[0]).toMatchObject({
    email:        'alice@acme.example',
    company:      'Acme Ltd',
    billingCity:  'Auckland',
    crmEntityType:'contact',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Marketo schema lacks crmEntityType — auto-filter strips, push succeeds
// ─────────────────────────────────────────────────────────────────────────────
it('SCHEMA FILTER: lacks crmEntityType / crmContactId — those keys are stripped before push', async () => {
  const app = createApp();
  const NARROW_SCHEMA = [
    'email','firstName','lastName','phone','title','company','billingCity',
  ].map(name => ({ rest: { name } }));

  makeRouter({
    contacts:   { 'c-guid-001': CONTACT_ROW },
    accounts:   { 'a-guid-001': ACCOUNT_ROW },
    leadSchema: NARROW_SCHEMA,
  });
  defaultPostRouter();

  const httpRes = await request(app)
    .post('/api/transfer/with-company')
    .set('Content-Type', 'application/json')
    .send({ entity: 'contact', sourceIds: ['c-guid-001'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary.personsSynced).toBe(1);

  const leadCall = findCallByUrl(axios.post, /\/leads\.json/);
  const sentToLead = leadCall.body.input[0];
  // Fields the schema DOES define are present.
  expect(sentToLead).toMatchObject({
    email:       'alice@acme.example',
    firstName:   'Alice',
    company:     'Acme Ltd',
    billingCity: 'Auckland',
  });
  // Fields the schema DOES NOT define are stripped — Marketo would have
  // rejected the whole record with code 1006 otherwise.
  expect(sentToLead).not.toHaveProperty('crmEntityType');
  expect(sentToLead).not.toHaveProperty('crmContactId');
  expect(sentToLead).not.toHaveProperty('billingCountry');
  expect(sentToLead).not.toHaveProperty('numberOfEmployees');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Lead with unresolvable companyname → person-only with `company` carried
// ─────────────────────────────────────────────────────────────────────────────
it('Lead with unresolvable companyname → person-only push carrying the literal company name', async () => {
  const app = createApp();
  const LEAD_ROW = {
    leadid:        'l-guid-001',
    emailaddress1: 'bob@untracked.example',
    firstname:     'Bob',
    lastname:      'Jones',
    companyname:   'Untracked Bob Co',
  };
  makeRouter({
    // No accounts mocked → resolveAccount returns null
    contacts: {},
    accounts: {},
  });
  // Lead-by-id fetch needs custom routing
  axios.get.mockImplementation((url) => {
    if (/\/identity\/oauth\/token/.test(url)) {
      return Promise.resolve({ data: { access_token: 'mkto-tok', expires_in: 3600 } });
    }
    if (/\/leads\/describe\.json/.test(url)) {
      return Promise.resolve({ data: { success: true, result: FULL_LEAD_SCHEMA } });
    }
    if (/\/leads\(/.test(url)) {
      return Promise.resolve({ data: LEAD_ROW });
    }
    if (/\/accounts\(|\/accounts\?|\/accounts$/.test(url)) {
      return Promise.resolve({ data: { value: [] } });
    }
    return Promise.resolve({ data: { value: [] } });
  });
  defaultPostRouter();

  const httpRes = await request(app)
    .post('/api/transfer/with-company')
    .set('Content-Type', 'application/json')
    .send({ entity: 'lead', sourceIds: ['l-guid-001'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary).toMatchObject({
    total: 1, personsSynced: 1, accountsSynced: 0, skipped: 0, failed: 0,
  });
  expect(httpRes.body.results[0]).toMatchObject({
    plan:         'person-only',
    skipReason:   'unresolved-account',
    personSynced: true,
  });
  expect(findCallByUrl(axios.post, /\/companies\/sync\.json/)).toBeNull();
  const leadCall = findCallByUrl(axios.post, /\/leads\.json/);
  expect(leadCall.body.input[0]).toMatchObject({
    email:         'bob@untracked.example',
    firstName:     'Bob',
    company:       'Untracked Bob Co',
    crmEntityType: 'lead',
    crmLeadId:     'l-guid-001',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Multi-row sequential — one row's Person write fails, batch keeps going
// ─────────────────────────────────────────────────────────────────────────────
it('Multi-row batch: one row fails mid-batch, others still complete; summary is accurate', async () => {
  const app = createApp();
  const C1 = { ...CONTACT_ROW, contactid: 'c-001', emailaddress1: 'one@example' };
  const C2 = { ...CONTACT_ROW, contactid: 'c-002', emailaddress1: 'two@example' };
  const C3 = { ...CONTACT_ROW, contactid: 'c-003', emailaddress1: 'three@example' };
  makeRouter({
    contacts: { 'c-001': C1, 'c-002': C2, 'c-003': C3 },
    accounts: { 'a-guid-001': ACCOUNT_ROW },
  });

  // Companies always succeed; row 2's lead push fails.
  let leadCallCount = 0;
  axios.post.mockImplementation((url, body) => {
    if (/login\.microsoftonline\.com/.test(url)) {
      return Promise.resolve({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
    }
    if (/\/companies\/sync\.json/.test(url)) {
      return Promise.resolve({
        data: { success: true, result: [{ id: 9000, status: 'created' }] },
      });
    }
    if (/\/leads\.json/.test(url)) {
      leadCallCount += 1;
      if (leadCallCount === 2) {
        const e = Object.assign(new Error('5xx'), {
          response: { status: 503, data: {} },
        });
        return Promise.reject(e);
      }
      return Promise.resolve({
        data: { success: true, result: [{ id: 1000 + leadCallCount, status: 'created' }] },
      });
    }
    return Promise.resolve({ data: {} });
  });

  const httpRes = await request(app)
    .post('/api/transfer/with-company')
    .set('Content-Type', 'application/json')
    .send({ entity: 'contact', sourceIds: ['c-001', 'c-002', 'c-003'] });

  expect(httpRes.status).toBe(200);
  expect(httpRes.body.summary).toMatchObject({
    total: 3,
    personsSynced: 2,
    accountsSynced: 3,
    skipped: 0,
    failed: 1,
  });
  expect(httpRes.body.results[0].personSynced).toBe(true);
  expect(httpRes.body.results[1].personSynced).toBe(false);
  expect(httpRes.body.results[1].error).toMatch(/person-write-failed/);
  expect(httpRes.body.results[2].personSynced).toBe(true);
});
