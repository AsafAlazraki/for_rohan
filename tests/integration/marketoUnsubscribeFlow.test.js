'use strict';

/**
 * End-to-end Marketo → Dynamics unsubscribe flow.
 *
 * Exercises the full pipeline: signed webhook → enqueue → worker dequeue
 * → authority router (GLOBAL_UNSUBSCRIBE) → resolvePerson → PATCH
 * /contacts({id}) with {donotbulkemail:true} → audit row.
 *
 * Per spec §Operational Behaviour, this is the ONE write path Marketo is
 * authorised to do against the CRM Contact entity. Every other Marketo
 * Contact write is unauthorised and must skip with reason='authority'.
 */

const mockPgQuery  = jest.fn();
const mockQueueAdd = jest.fn().mockResolvedValue('unsub-job-queued');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));

jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:      jest.fn().mockResolvedValue(undefined),
  stop:       jest.fn().mockResolvedValue(undefined),
  send:       (...args) => mockQueueAdd('sync', args[1]),
  work:       jest.fn().mockResolvedValue(undefined),
  onComplete: jest.fn().mockResolvedValue(undefined),
  getJobById: jest.fn(),
  on:         jest.fn(),
})));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockPgQuery })),
}));

const crypto  = require('crypto');
const request = require('supertest');
const axios   = require('axios');

const { processJob }             = require('../../src/queue/worker');
const { createApp }              = require('../../src/listeners/server');
const { _cache: dynTokenCache }  = require('../../src/auth/dynamics');
const { _cache: mktoTokenCache } = require('../../src/auth/marketo');
const { _setPool }               = require('../../src/audit/db');
const { _reset: resetQueue }     = require('../../src/queue/queue');

const MKTO_WH_SECRET = 'unsub-mkto-wh-secret';

function hmac(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeJob(payload, id = 'unsub-job') {
  return {
    id,
    data:         { source: 'marketo', receivedAt: new Date().toISOString(), payload },
    opts:         { attempts: 3 },
    attemptsMade: 1,
  };
}

beforeAll(() => {
  process.env.DYNAMICS_TENANT_ID      = 'tenant';
  process.env.DYNAMICS_CLIENT_ID      = 'dyn-client';
  process.env.DYNAMICS_CLIENT_SECRET  = 'dyn-secret';
  process.env.DYNAMICS_RESOURCE_URL   = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION    = '9.2';
  process.env.MARKETO_BASE_URL        = 'https://test.mktorest.com';
  process.env.MARKETO_CLIENT_ID       = 'mkto-client';
  process.env.MARKETO_CLIENT_SECRET   = 'mkto-secret';
  process.env.MARKETO_WEBHOOK_SECRET  = MKTO_WH_SECRET;
  process.env.DATABASE_URL            = 'postgres://test:test@localhost/test';
});

afterAll(() => {
  for (const k of [
    'DYNAMICS_TENANT_ID','DYNAMICS_CLIENT_ID','DYNAMICS_CLIENT_SECRET',
    'DYNAMICS_RESOURCE_URL','DYNAMICS_API_VERSION',
    'MARKETO_BASE_URL','MARKETO_CLIENT_ID','MARKETO_CLIENT_SECRET',
    'MARKETO_WEBHOOK_SECRET','DATABASE_URL',
  ]) delete process.env[k];
});

beforeEach(() => {
  jest.clearAllMocks();
  dynTokenCache.clear();
  mktoTokenCache.clear();
  resetQueue();
  _setPool({ query: mockPgQuery });
  mockPgQuery.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-1: Webhook → audit row, with crmContactId in the payload
// ─────────────────────────────────────────────────────────────────────────────
it('E2E unsubscribe: signed webhook → PATCH donotbulkemail=true → audit success', async () => {
  const app = createApp();
  const payload = {
    id:           'MKTO-LEAD-1',
    crmContactId: '11111111-1111-1111-1111-111111111111',
    email:        'sub@example.com',
    unsubscribed: true,
  };
  const rawBody = JSON.stringify(payload);
  const sig     = hmac(MKTO_WH_SECRET, rawBody);

  // ── 1. Webhook layer: signature verified + enqueued ──────────────────────
  const httpRes = await request(app)
    .post('/webhook/marketo')
    .set('Content-Type', 'application/json')
    .set('x-marketo-signature', sig)
    .send(rawBody);

  expect(httpRes.status).toBe(200);
  expect(httpRes.body).toEqual({ status: 'SUCCESS', jobId: 'unsub-job-queued' });
  await new Promise(resolve => setImmediate(resolve));
  expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  const enqueuedData = mockQueueAdd.mock.calls[0][1];
  expect(enqueuedData.source).toBe('marketo');
  expect(enqueuedData.payload.unsubscribed).toBe(true);

  // ── 2. Pipeline layer: process the dequeued job ──────────────────────────
  // getDynamicsToken (POST to Azure AD)
  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
  // resolvePerson tier 1: GET /contacts({id}) — returns active contact
  axios.get.mockResolvedValueOnce({
    data: { contactid: payload.crmContactId, statecode: 0 },
  });
  // PATCH /contacts({id}) with the donotbulkemail body
  axios.patch.mockResolvedValueOnce({ status: 204 });

  const result = await processJob(makeJob(payload));

  expect(result).toEqual({
    targetId: payload.crmContactId,
    action:   'update',
  });

  // ── 3. Verify the PATCH body and URL ─────────────────────────────────────
  expect(axios.patch).toHaveBeenCalledTimes(1);
  const [patchUrl, patchBody, patchOpts] = axios.patch.mock.calls[0];
  expect(patchUrl).toContain(`/contacts(${payload.crmContactId})`);
  expect(patchBody).toEqual({ donotbulkemail: true });
  expect(Object.keys(patchBody)).toEqual(['donotbulkemail']);
  // Auth + OData headers properly set
  expect(patchOpts.headers.Authorization).toBe('Bearer dyn-tok');
  expect(patchOpts.headers['OData-Version']).toBe('4.0');

  // ── 4. No accidental Lead writes — Marketo can't update Lead consent ─────
  expect(axios.post.mock.calls.some(([url]) => /\/leads(\?|$|\()/.test(url))).toBe(false);

  // ── 5. Audit row written to sync_events with status=success ──────────────
  const auditCalls = mockPgQuery.mock.calls.filter(([sql]) =>
    /INSERT INTO sync_events/i.test(sql),
  );
  expect(auditCalls.length).toBeGreaterThanOrEqual(1);
  const auditArgs = auditCalls[0][1];
  expect(auditArgs).toContain('marketo');
  expect(auditArgs).toContain('dynamics');
  expect(auditArgs).toContain('success');
  expect(auditArgs).toContain('contact');
  expect(auditArgs).toContain(payload.crmContactId);
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-2: Stale crmContactId — falls through to email match
// ─────────────────────────────────────────────────────────────────────────────
it('E2E unsubscribe: stale crmContactId falls through to email match, still patches', async () => {
  const payload = {
    crmContactId: 'stale-id',
    email:        'fallback@example.com',
    unsubscribed: true,
  };

  // getDynamicsToken
  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
  // tier 1: GET /contacts(stale-id) → 404
  const e404 = Object.assign(new Error('not found'), { response: { status: 404 } });
  axios.get.mockRejectedValueOnce(e404);
  // tier 4: GET /contacts?$filter=emailaddress1 eq '...' → hit
  axios.get.mockResolvedValueOnce({
    data: { value: [{ contactid: 'real-contact-by-email' }] },
  });
  // PATCH succeeds
  axios.patch.mockResolvedValueOnce({ status: 204 });

  const result = await processJob(makeJob(payload));

  expect(result).toEqual({ targetId: 'real-contact-by-email', action: 'update' });
  expect(axios.patch.mock.calls[0][0]).toContain('/contacts(real-contact-by-email)');
  expect(axios.patch.mock.calls[0][1]).toEqual({ donotbulkemail: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-3: No Contact resolves at all → skipped (NOT a write to the Lead!)
// ─────────────────────────────────────────────────────────────────────────────
it('E2E unsubscribe: no resolvable Contact → skipped, no PATCH, audit row marks skip', async () => {
  const payload = {
    email:        'nobody@nowhere.com',
    unsubscribed: true,
  };

  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });
  // entityHint=contact short-circuits Lead fallback. We only see one GET on contacts.
  axios.get.mockResolvedValueOnce({ data: { value: [] } });

  const result = await processJob(makeJob(payload));

  expect(result).toEqual({ skipped: true, reason: 'contact-not-resolvable' });
  expect(axios.patch).not.toHaveBeenCalled();

  const auditCalls = mockPgQuery.mock.calls.filter(([sql]) =>
    /INSERT INTO sync_events/i.test(sql),
  );
  expect(auditCalls.length).toBeGreaterThanOrEqual(1);
  const args = auditCalls[0][1];
  expect(args).toContain('skipped');
  // reason_category='authority' for unsubscribe-without-contact (per worker)
  expect(args.some(v => typeof v === 'string' && /contact-not-resolvable/i.test(v))).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-4: Unsubscribe without crmContactId AND without email → unauthorized
//         (the authority guard catches this before the handler runs)
// ─────────────────────────────────────────────────────────────────────────────
it('E2E unsubscribe: unsubscribed=true with no crmContactId and no email → unauthorized skip', async () => {
  const payload = { unsubscribed: true };

  // Worker fetches the Dynamics token before the authority router runs —
  // mock it. The authority guard rejects before any handler / writer fires.
  axios.post.mockResolvedValueOnce({ data: { access_token: 'dyn-tok', expires_in: 3600 } });

  const result = await processJob(makeJob(payload));

  expect(result.skipped).toBe(true);
  expect(result.reason).toMatch(/unsubscribe-without-identifier|authority|unauthorized/i);
  expect(axios.patch).not.toHaveBeenCalled();
  // Only the token POST should have fired — no /contacts or /leads writes.
  expect(axios.post.mock.calls.length).toBe(1);
  expect(axios.post.mock.calls[0][0]).toMatch(/oauth2|token/);
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E-5: Marketo signs the webhook wrong → 401, never reaches the queue
// ─────────────────────────────────────────────────────────────────────────────
it('E2E unsubscribe: invalid HMAC signature → 401 before enqueue', async () => {
  const app = createApp();
  const payload = { unsubscribed: true, email: 'a@b.com' };
  const rawBody = JSON.stringify(payload);
  const wrongSig = hmac('not-the-real-secret', rawBody);

  const httpRes = await request(app)
    .post('/webhook/marketo')
    .set('Content-Type', 'application/json')
    .set('x-marketo-signature', wrongSig)
    .send(rawBody);

  expect(httpRes.status).toBe(401);
  expect(mockQueueAdd).not.toHaveBeenCalled();
});
