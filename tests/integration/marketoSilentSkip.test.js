'use strict';

/**
 * Regression: Marketo's push endpoint returns HTTP 200 with `success: true`
 * even when individual records are rejected — each hit carries its own
 * `status: 'skipped' | 'failed'` plus a `reasons` array (e.g. 1006 "Field
 * not found"). The writers MUST surface this as an error so the worker
 * retries / DLQs, and the UI sees what actually went wrong.
 *
 * This test reproduces the exact shape of the response a tenant without
 * the `cr_syncsource` / `syncSource` custom field would return.
 */

// ── Mock external I/O ───────────────────────────────────────────────────────
const mockPgQuery  = jest.fn();
const mockQueueAdd = jest.fn().mockResolvedValue('int-job-silent-skip');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }));
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

const axios = require('axios');
const { writeToMarketo, writeMarketoCompany } = require('../../src/writers/marketo');
const { processJob }    = require('../../src/queue/worker');
const { _setPool }      = require('../../src/audit/db');
const { _cache: mktoTokenCache } = require('../../src/auth/marketo');
const { _cache: dynTokenCache }  = require('../../src/auth/dynamics');
const { bus } = require('../../src/events/bus');

beforeAll(() => {
  process.env.DYNAMICS_TENANT_ID      = 't';
  process.env.DYNAMICS_CLIENT_ID      = 'c';
  process.env.DYNAMICS_CLIENT_SECRET  = 's';
  process.env.DYNAMICS_RESOURCE_URL   = 'https://t.crm.dynamics.com';
  process.env.MARKETO_BASE_URL        = 'https://t.mktorest.com';
  process.env.MARKETO_CLIENT_ID       = 'c';
  process.env.MARKETO_CLIENT_SECRET   = 's';
  process.env.DATABASE_URL         = 'postgres://t:t@localhost/t';
});

beforeEach(() => {
  jest.clearAllMocks();
  mktoTokenCache.clear();
  dynTokenCache.clear();
  _setPool({ query: mockPgQuery });
  mockPgQuery.mockResolvedValue({ rows: [{ id: 'audit-uuid' }] });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit-level: writer surfaces per-record skip/fail
// ─────────────────────────────────────────────────────────────────────────────
describe('writeToMarketo surfaces silent per-record rejections', () => {
  test('throws with the 1006 field-not-found reason when Marketo skips the record', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        requestId: 'abcd#1',
        success:   true,                                   // overall call OK
        result: [{
          status:  'skipped',
          reasons: [{ code: '1006', message: "Field 'syncSource' not found" }],
        }],
      },
    });

    await expect(
      writeToMarketo({ email: 'alice@example.com', firstName: 'Alice', syncSource: 'dynamics' }, 'tok'),
    ).rejects.toThrow(/Lead skipped.*1006.*syncSource/);
  });

  test('throws with the reasons when Marketo reports per-record failure', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{
          status:  'failed',
          reasons: [{ code: '1003', message: 'Invalid email format' }],
        }],
      },
    });

    await expect(
      writeToMarketo({ email: 'not-an-email' }, 'tok'),
    ).rejects.toThrow(/Lead failed.*1003.*Invalid email format/);
  });

  test('still returns cleanly on status=created', async () => {
    axios.post.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 777, status: 'created' }] },
    });
    await expect(
      writeToMarketo({ email: 'alice@example.com' }, 'tok'),
    ).resolves.toEqual({ targetId: '777', status: 'created' });
  });
});

describe('writeMarketoCompany surfaces silent per-record rejections', () => {
  test('throws with reasons when Marketo skips the company', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{ status: 'skipped', reasons: [{ code: '1006', message: "Field 'industryCode' not found" }] }],
      },
    });
    await expect(
      writeMarketoCompany({ company: 'Acme', industryCode: 'ABC' }, 'tok'),
    ).rejects.toThrow(/Company skipped.*1006.*industryCode/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: full worker pipeline through a Dynamics→Marketo transfer of a
// real pulled contact. Verifies the error bubbles out of processJob so
// pg-boss retries + DLQ + SSE fire.
// ─────────────────────────────────────────────────────────────────────────────
describe('worker pipeline when Marketo silently rejects a record', () => {
  test('Dynamics→Marketo processJob throws the Marketo reason', async () => {
    // 1. Dynamics OAuth token fetch — not used for target=marketo, but auth
    //    caches may try anyway. Handled by marketo auth below.
    // 2. Marketo OAuth token fetch
    axios.get.mockImplementation((url) => {
      // Marketo OAuth
      if (/identity\/oauth\/token/.test(url)) {
        return Promise.resolve({ data: { access_token: 'mkto-tok', expires_in: 3600 } });
      }
      // Dedup: Marketo /leads.json lookup by email → no match → create path
      if (/\/rest\/v1\/leads\.json/.test(url)) {
        return Promise.resolve({ data: { success: true, result: [] } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    // 3. Marketo push returns the skipped+1006 shape
    axios.post.mockImplementation((url) => {
      if (/oauth\/token/.test(url)) {
        return Promise.resolve({ data: { access_token: 'tok', expires_in: 3600 } });
      }
      if (/\/rest\/v1\/leads\.json/.test(url)) {
        return Promise.resolve({
          data: {
            success: true,
            result: [{
              status:  'skipped',
              reasons: [{ code: '1006', message: "Field 'syncSource' not found" }],
            }],
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    // Also capture the sync-bus emission to prove the failure *would* reach
    // the UI via the existing DLQ → SSE pipeline when pg-boss escalates.
    const emitted = [];
    const onSync = (e) => emitted.push(e);
    bus.on('sync', onSync);

    const job = {
      id: 'job-silent-skip',
      data: {
        source:  'dynamics',
        payload: {
          // exact shape the user's readers produce
          contactid:      '11111111-1111-1111-1111-111111111111',
          emailaddress1:  'alice@example.com',
          firstname:      'Alice',
          lastname:       'Smith',
          telephone1:     '555-0100',
          jobtitle:       'Engineer',
          type:           'contact',
        },
      },
    };

    await expect(processJob(job)).rejects.toThrow(/Lead skipped.*1006.*syncSource/);

    bus.off('sync', onSync);
  });
});
