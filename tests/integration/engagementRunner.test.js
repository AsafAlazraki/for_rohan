'use strict';

/**
 * Integration tests for the engagement-ingest pipeline (Doc 2).
 *
 * Mocks axios + pg + the auth modules so the runner / filter / writer / route
 * stack exercises end-to-end without any external I/O. Driven via supertest
 * against the full createApp() Express tree.
 */

const mockPgQuery = jest.fn();

jest.mock('axios', () => ({
  get:     jest.fn(),
  post:    jest.fn(),
  patch:   jest.fn(),
  request: jest.fn(),
}));
jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:      jest.fn().mockResolvedValue(undefined),
  stop:       jest.fn().mockResolvedValue(undefined),
  publish:    jest.fn().mockResolvedValue('eng-job'),
  subscribe:  jest.fn().mockResolvedValue(undefined),
  onComplete: jest.fn().mockResolvedValue(undefined),
  schedule:   jest.fn().mockResolvedValue(undefined),
  getJobById: jest.fn(),
  on:         jest.fn(),
})));
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockPgQuery })),
}));

jest.mock('../../src/auth/marketo', () => ({
  getMarketoToken: jest.fn(async () => 'mkto-tok'),
  _cache: { clear: jest.fn(), isValid: () => false, get: () => null, set: jest.fn() },
}));
jest.mock('../../src/auth/dynamics', () => ({
  getDynamicsToken: jest.fn(async () => 'dyn-tok'),
  _cache: { clear: jest.fn(), isValid: () => false, get: () => null, set: jest.fn() },
}));
jest.mock('../../src/config/loader', () => {
  const store = new Map();
  return {
    getConfig: jest.fn(async (k) => {
      if (store.has(k)) return store.get(k);
      const env = {
        MARKETO_BASE_URL:                'https://test.mktorest.com',
        DYNAMICS_RESOURCE_URL:           'https://t.crm.dynamics.com',
        DYNAMICS_API_VERSION:            '9.2',
        MARKETO_INGEST_LOOKBACK_HOURS:   '24',
        MARKETO_INGEST_INTERVAL_MIN:     '15',
        MARKETO_WEB_VISIT_KEY_URLS:      '',
      };
      return env[k] || null;
    }),
    setConfig: jest.fn(async (k, v) => { store.set(k, v); }),
    listConfig: jest.fn(async () => []),
    maskSecret: (v) => v,
    _reset: () => store.clear(),
    _store: store,
  };
});

const request = require('supertest');
const axios   = require('axios');
const { createApp } = require('../../src/listeners/server');
const { _setPool }  = require('../../src/audit/db');
const runner = require('../../src/engagement/runner');
const { _store: configStore } = require('../../src/config/loader');

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://t:t@localhost/t';
});

beforeEach(() => {
  jest.clearAllMocks();
  configStore.clear();
  // Default pg behaviour: SELECT lookups return zero rows, INSERT/COUNT are happy.
  mockPgQuery.mockImplementation(async (sql) => {
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  });
  _setPool({ query: mockPgQuery });
});

// ─────────────────────────────────────────────────────────────────────────────
// runner.runOnce — happy path
// ─────────────────────────────────────────────────────────────────────────────
describe('runner.runOnce — full happy path', () => {
  test('paging-token init → fetch → resolve email → write engagement activity', async () => {
    // No pre-existing cursor (config returns null), so runner asks for a paging token
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/rest/v1/activities/pagingtoken.json')) {
        return { data: { success: true, nextPageToken: 'PAGE-1' } };
      }
      if (url.includes('/activities/types.json')) {
        return { data: { success: true, result: [{ id: 7 }] } };
      }
      if (url.includes('/rest/v1/activities.json')) {
        return {
          data: {
            success: true,
            moreResult: false,
            nextPageToken: 'PAGE-2',
            result: [{
              id: 5001, activityTypeId: 7, leadId: 700,
              primaryAttributeValue: 'Welcome Email',
              activityDate: '2026-04-18T10:00:00Z',
              attributes: [{ name: 'Subject', value: 'Hi' }],
            }],
          },
        };
      }
      if (url.includes('/rest/v1/leads.json')) {
        return {
          data: {
            success: true,
            result: [{ id: 700, email: 'engaged@example.com' }],
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    // Dynamics: dedup lookup finds the contact → writeEngagementActivity returns activityid
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/contacts')) {
        return { data: { value: [{ contactid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', emailaddress1: 'engaged@example.com' }] } };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    axios.post.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/ubt_marketingengagementactivities')) {
        return {
          data: { activityid: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' },
          headers: {},
        };
      }
      throw new Error(`unexpected POST ${url}`);
    });

    const summary = await runner.runOnce();

    expect(summary.fetched).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.unmatched).toBe(0);
    expect(summary.lastCursor).toBe('PAGE-2');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    // Dedup INSERT for the written row should have been issued
    const inserts = mockPgQuery.mock.calls.filter(([sql]) => /INSERT INTO engagement_dedup/i.test(sql));
    expect(inserts.length).toBe(1);
    const params = inserts[0][1];
    expect(params[0]).toBe(5001);                                 // marketo_activity_id
    expect(params[1]).toBe(7);                                    // activity_type_id
    expect(params[7]).toBe('written');                            // filter_decision
  });

  test('records an unmatched row when Dynamics has no matching contact', async () => {
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/pagingtoken.json'))        return { data: { success: true, nextPageToken: 'P1' } };
      if (url.includes('/activities/types.json'))   return { data: { success: true, result: [{ id: 7 }] } };
      if (url.includes('/rest/v1/activities.json')) return {
        data: {
          success: true, moreResult: false, nextPageToken: 'P2',
          result: [{ id: 6001, activityTypeId: 7, leadId: 800,
                     primaryAttributeValue: 'X', activityDate: '2026-04-18T10:00:00Z', attributes: [] }],
        },
      };
      if (url.includes('/rest/v1/leads.json')) return {
        data: { success: true, result: [{ id: 800, email: 'unknown@example.com' }] },
      };
      throw new Error(url);
    });
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/contacts')) return { data: { value: [] } };
      throw new Error(url);
    });

    const summary = await runner.runOnce();
    expect(summary.unmatched).toBe(1);
    expect(summary.written).toBe(0);

    const inserts = mockPgQuery.mock.calls.filter(([sql]) => /INSERT INTO engagement_dedup/i.test(sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1][7]).toBe('unmatched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runner.runOnce({ dryRun: true }) — preview / SIM mode
// ─────────────────────────────────────────────────────────────────────────────
describe('runner.runOnce({ dryRun: true }) — SIM mode', () => {
  test('reads Marketo, resolves contacts, but skips writes / cursor / dedup', async () => {
    // Two activities that would normally both be written.
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/pagingtoken.json')) {
        return { data: { success: true, nextPageToken: 'PAGE-A' } };
      }
      if (url.includes('/activities/types.json')) {
        return { data: { success: true, result: [{ id: 7 }, { id: 2 }] } };
      }
      if (url.includes('/rest/v1/activities.json')) {
        return {
          data: {
            success: true, moreResult: false, nextPageToken: 'PAGE-B',
            result: [
              { id: 9001, activityTypeId: 7, leadId: 100,
                primaryAttributeValue: 'Drip 1', activityDate: '2026-04-18T10:00:00Z', attributes: [] },
              { id: 9002, activityTypeId: 2, leadId: 101,
                primaryAttributeValue: 'Demo Form', activityDate: '2026-04-18T10:01:00Z', attributes: [] },
            ],
          },
        };
      }
      if (url.includes('/rest/v1/leads.json')) {
        return {
          data: {
            success: true,
            result: [
              { id: 100, email: 'a@example.com' },
              { id: 101, email: 'b@example.com' },
            ],
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    // Dynamics contact lookups still resolve (reads are real); writes won't be called.
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/contacts')) {
        return { data: { value: [{ contactid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', emailaddress1: 'whatever' }] } };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    // SSE capture
    const { bus } = require('../../src/events/bus');
    const seen = [];
    const onSync = (e) => seen.push(e);
    bus.on('sync', onSync);

    let summary;
    try {
      summary = await runner.runOnce({ dryRun: true });
    } finally {
      bus.off('sync', onSync);
    }

    // (a) No writes happened — engagement-entity POST was never made.
    const engagementPosts = axios.post.mock.calls.filter(
      ([url]) => /\/ubt_marketingengagementactivities/i.test(url),
    );
    expect(engagementPosts).toHaveLength(0);

    // (b) No 'written' dedup rows inserted (in fact: no inserts at all in dry-run)
    const inserts = mockPgQuery.mock.calls.filter(([sql]) => /INSERT INTO engagement_dedup/i.test(sql));
    expect(inserts).toHaveLength(0);

    // (c) Cursor not advanced (no UPSERT to admin_config for the cursor key)
    const { setConfig } = require('../../src/config/loader');
    const cursorWrites = setConfig.mock.calls.filter(([k]) => k === 'MARKETO_ENGAGEMENT_CURSOR');
    expect(cursorWrites).toHaveLength(0);
    // and no last-run summary write either
    const lastRunWrites = setConfig.mock.calls.filter(([k]) => k === runner.KEY_LAST_RUN);
    expect(lastRunWrites).toHaveLength(0);

    // (d) summary shape + samples
    expect(summary.fetched).toBe(2);
    expect(summary.written).toBe(0);
    expect(Array.isArray(summary.samples)).toBe(true);
    expect(summary.samples.length).toBe(2);
    expect(summary.samples.length).toBeLessThanOrEqual(20);
    expect(summary.samples[0]).toMatchObject({
      decision: 'would-write',
      type:     7,
      typeName: 'Email Delivered',
    });

    // (e) SSE events emitted with status: 'preview'
    const previewEvts = seen.filter(e => e.status === 'preview' && e.entityType === 'engagement');
    expect(previewEvts.length).toBeGreaterThanOrEqual(2);
  });

  test('caps samples at 20 even when more activities would qualify', async () => {
    // 25 Email-Delivered activities → all qualify for write, but samples should cap at 20.
    const result = Array.from({ length: 25 }, (_, i) => ({
      id: 20000 + i, activityTypeId: 7, leadId: 200 + i,
      primaryAttributeValue: `Mail ${i}`, activityDate: '2026-04-18T10:00:00Z', attributes: [],
    }));
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/pagingtoken.json'))        return { data: { success: true, nextPageToken: 'P' } };
      if (url.includes('/activities/types.json'))   return { data: { success: true, result: [{ id: 7 }] } };
      if (url.includes('/rest/v1/activities.json')) return { data: { success: true, moreResult: false, nextPageToken: 'P2', result } };
      if (url.includes('/rest/v1/leads.json'))      return {
        data: { success: true, result: result.map(a => ({ id: a.leadId, email: `u${a.leadId}@example.com` })) },
      };
      throw new Error(url);
    });
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/contacts')) {
        return { data: { value: [{ contactid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', emailaddress1: 'x' }] } };
      }
      throw new Error(url);
    });

    const summary = await runner.runOnce({ dryRun: true });
    expect(summary.fetched).toBe(25);
    expect(summary.samples).toHaveLength(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/engagement/trigger
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/engagement/trigger', () => {
  test('runs the ingest cycle and returns the summary', async () => {
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/pagingtoken.json'))         return { data: { success: true, nextPageToken: 'P1' } };
      if (url.includes('/activities/types.json'))    return { data: { success: true, result: [{ id: 7 }] } };
      if (url.includes('/rest/v1/activities.json'))  return {
        data: { success: true, moreResult: false, nextPageToken: 'P2', result: [] },
      };
      if (url.includes('/rest/v1/leads.json'))       return { data: { success: true, result: [] } };
      throw new Error(url);
    });

    const app = createApp();
    const res = await request(app).post('/api/engagement/trigger').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toMatchObject({
      fetched: 0, written: 0, skipped: 0, unmatched: 0,
    });
    expect(res.body.summary.lastCursor).toBe('P2');
  });

  test('returns 502 when Marketo auth fails', async () => {
    const { getMarketoToken } = require('../../src/auth/marketo');
    getMarketoToken.mockRejectedValueOnce(new Error('invalid_client'));

    const app = createApp();
    const res = await request(app).post('/api/engagement/trigger').send({});
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/invalid_client/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/engagement/dry-run
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/engagement/dry-run', () => {
  test('returns 200 with dryRun:true and summary.written === 0', async () => {
    axios.request.mockImplementation(async (cfg) => {
      const url = cfg.url || '';
      if (url.includes('/pagingtoken.json'))        return { data: { success: true, nextPageToken: 'P1' } };
      if (url.includes('/activities/types.json'))   return { data: { success: true, result: [{ id: 7 }] } };
      if (url.includes('/rest/v1/activities.json')) return {
        data: {
          success: true, moreResult: false, nextPageToken: 'P2',
          result: [{
            id: 8001, activityTypeId: 7, leadId: 500,
            primaryAttributeValue: 'Welcome', activityDate: '2026-04-18T10:00:00Z', attributes: [],
          }],
        },
      };
      if (url.includes('/rest/v1/leads.json')) return {
        data: { success: true, result: [{ id: 500, email: 'sim@example.com' }] },
      };
      throw new Error(url);
    });
    axios.get.mockImplementation(async (url) => {
      if (url.includes('/api/data/v9.2/contacts')) {
        return { data: { value: [{ contactid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', emailaddress1: 'sim@example.com' }] } };
      }
      throw new Error(url);
    });

    const app = createApp();
    const res = await request(app).post('/api/engagement/dry-run').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary.written).toBe(0);
    expect(res.body.summary.fetched).toBe(1);
    expect(Array.isArray(res.body.summary.samples)).toBe(true);
    expect(res.body.summary.samples).toHaveLength(1);
    expect(res.body.summary.samples[0]).toMatchObject({
      decision: 'would-write',
      typeName: 'Email Delivered',
    });

    // No engagement-entity POST and no engagement_dedup INSERT — true preview.
    const engagementPosts = axios.post.mock.calls.filter(
      ([url]) => /\/ubt_marketingengagementactivities/i.test(url),
    );
    expect(engagementPosts).toHaveLength(0);
    const inserts = mockPgQuery.mock.calls.filter(([sql]) => /INSERT INTO engagement_dedup/i.test(sql));
    expect(inserts).toHaveLength(0);
  });

  test('returns 502 when Marketo auth fails (mirrors /trigger error shape)', async () => {
    const { getMarketoToken } = require('../../src/auth/marketo');
    getMarketoToken.mockRejectedValueOnce(new Error('invalid_client'));

    const app = createApp();
    const res = await request(app).post('/api/engagement/dry-run').send({});
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.error).toMatch(/invalid_client/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/engagement/recent
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/engagement/recent', () => {
  test('returns shaped rows from engagement_dedup', async () => {
    mockPgQuery.mockImplementation(async (sql) => {
      if (/FROM engagement_dedup/i.test(sql) && /ORDER BY/i.test(sql)) {
        return {
          rows: [
            {
              marketo_activity_id:             '7001',
              activity_type_id:                10,
              marketo_lead_id:                 '900',
              asset_name:                      'Spring Newsletter',
              url:                             null,
              dynamics_contact_id:             'cccccccc-cccc-cccc-cccc-cccccccccccc',
              dynamics_engagement_activity_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
              filter_decision:                 'written',
              filter_reason:                   null,
              occurred_at:                     '2026-04-18T10:00:00Z',
              created_at:                      '2026-04-18T10:00:01Z',
            },
            {
              marketo_activity_id:             '7002',
              activity_type_id:                1,
              marketo_lead_id:                 '901',
              asset_name:                      '/blog/x',
              url:                             'https://x/blog/x',
              dynamics_contact_id:             null,
              dynamics_engagement_activity_id: null,
              filter_decision:                 'skipped',
              filter_reason:                   'web visit url not on allow-list',
              occurred_at:                     '2026-04-18T10:00:00Z',
              created_at:                      '2026-04-18T10:00:02Z',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const app = createApp();
    const res = await request(app).get('/api/engagement/recent?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0]).toMatchObject({
      marketoActivityId:  '7001',
      type:               10,
      typeName:           'Email Open',
      status:             'written',
      dynamicsActivityId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    });
    expect(res.body.rows[1]).toMatchObject({
      type: 1,
      typeName: 'Web Visit',
      status: 'skipped',
      reason: expect.stringMatching(/allow-list/),
    });
  });

  test('400s when type is not numeric', async () => {
    const app = createApp();
    const res = await request(app).get('/api/engagement/recent?type=oops');
    expect(res.status).toBe(400);
  });
});
