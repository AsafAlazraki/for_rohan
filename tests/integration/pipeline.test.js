'use strict';

/**
 * Phase 3 — Integration smoke tests for the complete sync pipeline.
 *
 * What is mocked:     axios (all external HTTP), pg (Postgres), bullmq, ioredis
 * What runs for real: loopGuard, fieldMapper, dedup, auth token caches,
 *                     marketo writer, dynamics writer, audit logger, Express webhook
 */

// ── Mock all external I/O ─────────────────────────────────────────────────────
const mockPgQuery  = jest.fn();
const mockQueueAdd = jest.fn().mockResolvedValue('int-job-queued');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));

// pg-boss: stub start/send/work so the server + worker modules construct
// without reaching a real database.
jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:     jest.fn().mockResolvedValue(undefined),
  stop:      jest.fn().mockResolvedValue(undefined),
  send:      (...args) => mockQueueAdd('sync', args[1]),
  work:      jest.fn().mockResolvedValue(undefined),
  onComplete:jest.fn().mockResolvedValue(undefined),
  getJobById:jest.fn(),
  on:        jest.fn(),
})));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockPgQuery })),
}));

// ── Real implementations under test ──────────────────────────────────────────
const crypto  = require('crypto');
const request = require('supertest');
const axios   = require('axios');

const { processJob }             = require('../../src/queue/worker');
const { createApp }              = require('../../src/listeners/server');
const { _cache: dynTokenCache }  = require('../../src/auth/dynamics');
const { _cache: mktoTokenCache } = require('../../src/auth/marketo');
const { _setPool }               = require('../../src/audit/db');
const { _reset: resetQueue }     = require('../../src/queue/queue');

// ── Fixtures ──────────────────────────────────────────────────────────────────
const DYN_CONTACT = {
  emailaddress1: 'alice@example.com',
  firstname:     'Alice',
  lastname:      'Smith',
  telephone1:    '555-1001',
  jobtitle:      'Engineer',
};

const MKTO_LEAD = {
  email:     'bob@example.com',
  firstName: 'Bob',
  lastName:  'Jones',
  title:     'Manager',
  company:   'Bob Corp',
};

const DYN_WH_SECRET  = 'int-dyn-wh-secret';
const MKTO_WH_SECRET = 'int-mkto-wh-secret';

function hmac(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeJob(source, payload, id = `int-${source}-job`) {
  return {
    id,
    data:         { source, receivedAt: new Date().toISOString(), payload },
    opts:         { attempts: 3 },
    attemptsMade: 1,
  };
}

function make429Error() {
  return Object.assign(new Error('Too Many Requests'), {
    response: { status: 429, headers: { 'retry-after': '0' } },
  });
}

// ── Global test setup ─────────────────────────────────────────────────────────
beforeAll(() => {
  process.env.DYNAMICS_TENANT_ID      = 'int-tenant';
  process.env.DYNAMICS_CLIENT_ID      = 'int-dyn-client';
  process.env.DYNAMICS_CLIENT_SECRET  = 'int-dyn-secret';
  process.env.DYNAMICS_RESOURCE_URL   = 'https://int.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION    = '9.2';
  process.env.DYNAMICS_WEBHOOK_SECRET = DYN_WH_SECRET;
  process.env.MARKETO_BASE_URL        = 'https://int.mktorest.com';
  process.env.MARKETO_CLIENT_ID       = 'int-mkto-client';
  process.env.MARKETO_CLIENT_SECRET   = 'int-mkto-secret';
  process.env.MARKETO_WEBHOOK_SECRET  = MKTO_WH_SECRET;
  process.env.DATABASE_URL         = 'postgres://test:test@localhost/test';
});

afterAll(() => {
  for (const k of [
    'DYNAMICS_TENANT_ID','DYNAMICS_CLIENT_ID','DYNAMICS_CLIENT_SECRET',
    'DYNAMICS_RESOURCE_URL','DYNAMICS_API_VERSION','DYNAMICS_WEBHOOK_SECRET',
    'MARKETO_BASE_URL','MARKETO_CLIENT_ID','MARKETO_CLIENT_SECRET',
    'MARKETO_WEBHOOK_SECRET',
  ]) delete process.env[k];
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset auth token caches so each test performs a fresh token fetch
  dynTokenCache.clear();
  mktoTokenCache.clear();
  // Reset BullMQ queue singleton
  resetQueue();
  // Inject mock Postgres pool
  _setPool({ query: mockPgQuery });
  // Default: queries succeed. getConfig calls often fall through to process.env
  // or return null on error.
  mockPgQuery.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1: Dynamics → Marketo happy path
//     Webhook fires → signature verified → payload enqueued → processJob
//     → loop guard passes → dedup (no existing lead) → field mapper
//     → Marketo writer → audit log
// ─────────────────────────────────────────────────────────────────────────────
it('T1 Dynamics→Marketo: webhook validates signature, maps fields, writes to Marketo, audits', async () => {
  // ── HTTP layer ──────────────────────────────────────────────────────────────
  const app     = createApp();
  const rawBody = JSON.stringify(DYN_CONTACT);
  const sig     = hmac(DYN_WH_SECRET, rawBody);

  const httpRes = await request(app)
    .post('/webhook/dynamics')
    .set('Content-Type', 'application/json')
    .set('x-dynamics-signature', sig)
    .send(rawBody);

  expect(httpRes.body).toEqual({ status: 'SUCCESS', jobId: 'int-job-queued' });

  // Flush the setImmediate callback that calls enqueue
  await new Promise(resolve => setImmediate(resolve));

  // The webhook must have enqueued the payload
  expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  const enqueuedData = mockQueueAdd.mock.calls[0][1]; // queue.add('sync', data)
  expect(enqueuedData.source).toBe('dynamics');
  expect(enqueuedData.payload).toMatchObject({ emailaddress1: 'alice@example.com' });

  // ── Pipeline layer ──────────────────────────────────────────────────────────
  // getMarketoToken (GET)
  axios.get.mockResolvedValueOnce({ data: { access_token: 'mkto-tok', expires_in: 3600 } });
  // dedup: no existing lead (GET)
  axios.get.mockResolvedValueOnce({ data: { success: true, result: [] } });
  // writeToMarketo (POST)
  axios.post.mockResolvedValueOnce({
    data: { success: true, result: [{ id: 42, status: 'created' }] },
  });

  const job    = { id: 'pipe-job-t1', data: enqueuedData, opts: { attempts: 3 }, attemptsMade: 1 };
  const result = await processJob(job);

  // Writer returned the expected result
  expect(result).toEqual({ targetId: '42', status: 'created' });

  // Marketo push called with correctly mapped fields
  const [pushUrl, pushBody] = axios.post.mock.calls[0];
  expect(pushUrl).toContain('/leads.json');
  expect(pushBody).toMatchObject({
    action:      'createOrUpdate',
    lookupField: 'email',
  });
  expect(pushBody.input[0]).toMatchObject({
    email:     'alice@example.com',
    firstName: 'Alice',
    lastName:  'Smith',
    phone:     '555-1001',
    title:     'Engineer',
  });

  // Audit log written with success
  expect(mockPgQuery).toHaveBeenCalledWith(
    expect.stringMatching(/INSERT INTO sync_events/i),
    expect.arrayContaining(['dynamics', 'marketo', 'success']),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T2: Marketo → Dynamics new-lead (compliance-rewritten; ASSUMPTIONS §5)
//     Per spec §Operational Behaviour, Marketo cannot create Contacts. The
//     authority guard routes `isLead=true` + no IDs + eligible payload to the
//     new-lead handler, which POSTs to /leads (not /contacts) and binds the
//     resolved Account via parentaccountid@odata.bind — it does NOT auto-
//     create the Account.
// ─────────────────────────────────────────────────────────────────────────────
it('T2 Marketo→Dynamics: eligible new-lead payload creates a Lead (not Contact), binds resolved Account', async () => {
  const LEAD_PAYLOAD = {
    ...MKTO_LEAD,
    id:             'MKTO-99',
    isLead:         true,
    accountNumber:  'AN-BOB',
  };

  // getDynamicsToken (POST to Azure AD)
  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });

  // pre-check: resolvePerson with entityHint=contact fires 2 GETs because
  // payload.id is set → (a) contacts by ubt_marketoid, (b) contacts by email.
  // Both miss.
  axios.get.mockResolvedValueOnce({ data: { value: [] } }); // contacts by marketoId
  axios.get.mockResolvedValueOnce({ data: { value: [] } }); // contacts by email
  // eligibility.companyExists → accountResolver searches accountnumber first.
  axios.get.mockResolvedValueOnce({
    data: { value: [{ accountid: 'bob-corp-guid' }] },
  });
  // newLead POST /leads
  axios.post.mockResolvedValueOnce({
    data: { leadid: 'new-lead-guid' },
    headers: { 'OData-EntityId': 'https://x.crm.dynamics.com/api/data/v9.2/leads(new-lead-guid)' },
  });

  const result = await processJob(makeJob('marketo', LEAD_PAYLOAD));

  expect(result).toEqual({ targetId: 'new-lead-guid', action: 'create' });

  // POST calls: [0] token, [1] /leads — no /accounts POST (Marketo can't
  // create accounts) and no /contacts POST.
  const leadPost = axios.post.mock.calls.find(([url]) => url.includes('/leads'));
  expect(leadPost).toBeDefined();
  expect(axios.post.mock.calls.some(([url]) => url.includes('/accounts'))).toBe(false);
  expect(axios.post.mock.calls.some(([url]) => url.includes('/contacts'))).toBe(false);

  const [, leadBody] = leadPost;
  expect(leadBody).toMatchObject({
    firstname:     'Bob',
    lastname:      'Jones',
    emailaddress1: 'bob@example.com',
    jobtitle:      'Manager',
    companyname:   'Bob Corp',
  });
  expect(leadBody['parentaccountid@odata.bind']).toBe('/accounts(bob-corp-guid)');

  // Audit row carries source_type='lead' per the router
  expect(mockPgQuery).toHaveBeenCalledWith(
    expect.stringMatching(/INSERT INTO sync_events/i),
    expect.arrayContaining(['marketo', 'dynamics', 'success']),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T3: Loop prevention
//     source=marketo + payload.syncSource='dynamics'
//     → targetSystem='dynamics' → syncSource===targetSystem → skip=true
//     → no writer calls, audit records 'skipped'
// ─────────────────────────────────────────────────────────────────────────────
it('T3 Loop guard: skips job when syncSource matches targetSystem, no API calls fired', async () => {
  // syncSource='dynamics' and targetSystem='dynamics' → loop guard fires
  const loopPayload = { ...MKTO_LEAD, syncSource: 'dynamics' };

  const result = await processJob(makeJob('marketo', loopPayload));

  expect(result.skipped).toBe(true);
  expect(result.reason).toMatch(/Loop guard/i);

  // No token, dedup, or writer calls made
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(axios.patch).not.toHaveBeenCalled();

  // Audit log still written with 'skipped' status
  expect(mockPgQuery).toHaveBeenCalledWith(
    expect.stringMatching(/INSERT INTO sync_events/i),
    expect.arrayContaining(['skipped']),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T4: Marketo-sourced payload resolving to an existing Contact (compliance-rewritten)
//     Per spec §Operational Behaviour, Marketo cannot update Contact fields
//     outside consent. A NEW_LEAD-intent payload whose pre-check resolves to
//     an active Contact is skipped with reason `person-resolves-to-existing-
//     contact` (ASSUMPTIONS §6). No PATCH, no POST /leads.
// ─────────────────────────────────────────────────────────────────────────────
it('T4 Marketo→Dynamics: new-lead payload resolving to existing Contact is skipped, no writes', async () => {
  const existingContactGuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const LEAD_PAYLOAD = {
    ...MKTO_LEAD,
    id:             'MKTO-EXISTING',
    isLead:         true,
    accountNumber:  'AN-BOB',
  };

  // getDynamicsToken
  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
  // pre-check: contacts by ubt_marketoid → hit
  axios.get.mockResolvedValueOnce({
    data: { value: [{ contactid: existingContactGuid }] },
  });

  const result = await processJob(makeJob('marketo', LEAD_PAYLOAD));

  expect(result).toEqual({
    skipped: true,
    reason:  'person-resolves-to-existing-contact',
  });

  // No Contact PATCH, no Lead POST — only the Azure AD token POST happened.
  expect(axios.patch).not.toHaveBeenCalled();
  const nonTokenPosts = axios.post.mock.calls.filter(
    ([url]) => !url.includes('login.microsoftonline.com'),
  );
  expect(nonTokenPosts).toHaveLength(0);

  // Audit row records the skip with source_type='lead' (NEW_LEAD intent).
  expect(mockPgQuery).toHaveBeenCalledWith(
    expect.stringMatching(/INSERT INTO sync_events/i),
    expect.arrayContaining(['marketo', 'dynamics', 'skipped']),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// T5: Retry behaviour
//     Marketo writer throws 429 twice → sleeps (fake timer) → succeeds on 3rd
//     → processJob completes with success result + audit log written
// ─────────────────────────────────────────────────────────────────────────────
it('T5 Retry: writer recovers after two 429 failures and logs success', async () => {
  jest.useFakeTimers();

  try {
    // getMarketoToken (GET)
    axios.get.mockResolvedValueOnce({ data: { access_token: 'mkto-tok', expires_in: 3600 } });
    // dedup: no existing lead (GET)
    axios.get.mockResolvedValueOnce({ data: { success: true, result: [] } });
    // write attempt 1 → 429
    axios.post.mockRejectedValueOnce(make429Error());
    // write attempt 2 → 429
    axios.post.mockRejectedValueOnce(make429Error());
    // write attempt 3 → success
    axios.post.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 77, status: 'created' }] },
    });

    const p = processJob(makeJob('dynamics', DYN_CONTACT, 'retry-job'));
    // Suppress unhandled-rejection warning while timer advancement is in progress
    p.catch(() => {});

    // First runAllTimersAsync fires the 0 ms sleep after attempt 1,
    // allowing the retry chain to proceed.
    await jest.runAllTimersAsync();
    // Second call catches the sleep after attempt 2 if still pending.
    await jest.runAllTimersAsync();

    const result = await p;

    expect(result).toEqual({ targetId: '77', status: 'created' });

    // 1 original + 2 retries = 3 POST calls total for the push endpoint
    const pushCalls = axios.post.mock.calls.filter(([url]) =>
      url.includes('/leads.json'),
    );
    expect(pushCalls).toHaveLength(3);

    // Audit log was written after the final success
    expect(mockPgQuery).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO sync_events/i),
      expect.arrayContaining(['dynamics', 'marketo', 'success']),
    );
  } finally {
    jest.useRealTimers();
  }
});
