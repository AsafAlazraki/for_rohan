'use strict';

/**
 * Integration test for src/routes/accountList.js.
 *
 * Mounts the full Express app via createApp() and drives it with supertest.
 * The Marketo writer module and the auth helper are mocked so the route's
 * orchestration logic (validation, three-step flow, ABM-not-enabled hint,
 * partial-success handling, auth failure surfacing) can be exercised
 * without any network I/O.
 */

// ── Mock external I/O before requiring the app ─────────────────────────────
const mockPgQuery  = jest.fn();
const mockQueueAdd = jest.fn().mockResolvedValue('acct-list-job');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), request: jest.fn() }));
jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:      jest.fn().mockResolvedValue(undefined),
  stop:       jest.fn().mockResolvedValue(undefined),
  publish:    (...args) => mockQueueAdd('sync', args[1]),
  subscribe:  jest.fn().mockResolvedValue(undefined),
  onComplete: jest.fn().mockResolvedValue(undefined),
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

jest.mock('../../src/writers/marketoLists', () => ({
  createNamedAccountList: jest.fn(),
  upsertNamedAccounts:    jest.fn(),
  addNamedAccountsToList: jest.fn(),
}));

const request = require('supertest');
const { createApp }      = require('../../src/listeners/server');
const { getMarketoToken } = require('../../src/auth/marketo');
const {
  createNamedAccountList,
  upsertNamedAccounts,
  addNamedAccountsToList,
} = require('../../src/writers/marketoLists');

// ── Fixtures ───────────────────────────────────────────────────────────────
const ACME = {
  name:          'Acme Corp',
  websiteurl:    'acme.example',
  industrycode:  'Software',
  revenue:       1000000,
  address1_city: 'Sydney',
};
const BETA  = { name: 'Beta LLC', websiteurl: 'beta.example' };
const NONAME = { websiteurl: 'no-name.example' }; // dropped by shapeForMarketo

// ── Global setup: env vars (mirrors pipeline.test.js) ──────────────────────
beforeAll(() => {
  process.env.DYNAMICS_TENANT_ID      = 'int-tenant';
  process.env.DYNAMICS_CLIENT_ID      = 'int-dyn-client';
  process.env.DYNAMICS_CLIENT_SECRET  = 'int-dyn-secret';
  process.env.DYNAMICS_RESOURCE_URL   = 'https://int.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION    = '9.2';
  process.env.MARKETO_BASE_URL        = 'https://int.mktorest.com';
  process.env.MARKETO_CLIENT_ID       = 'int-mkto-client';
  process.env.MARKETO_CLIENT_SECRET   = 'int-mkto-secret';
  process.env.DATABASE_URL         = 'postgres://test:test@localhost/test';
});

afterAll(() => {
  for (const k of [
    'DYNAMICS_TENANT_ID','DYNAMICS_CLIENT_ID','DYNAMICS_CLIENT_SECRET',
    'DYNAMICS_RESOURCE_URL','DYNAMICS_API_VERSION',
    'MARKETO_BASE_URL','MARKETO_CLIENT_ID','MARKETO_CLIENT_SECRET',
    'DATABASE_URL',
  ]) delete process.env[k];
});

beforeEach(() => {
  jest.clearAllMocks();
  getMarketoToken.mockResolvedValue('mkto-tok');
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/account-list/dry-run
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/account-list/dry-run', () => {
  test('returns shaped members and uses the provided listName', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/dry-run')
      .send({ listName: 'My Sync', accounts: [ACME, BETA] });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.listName).toBe('My Sync');
    expect(res.body.droppedNoName).toBe(0);
    expect(res.body.note).toMatch(/No external API calls/i);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).toMatchObject({
      name: 'Acme Corp', domain: 'acme.example', industry: 'Software',
      annualRevenue: 1000000, billingCity: 'Sydney',
    });
  });

  test('uses defaultListName() when listName is not provided', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/dry-run')
      .send({ accounts: [ACME] });

    expect(res.status).toBe(200);
    expect(res.body.listName).toMatch(/D365 Account Sync/);
  });

  test('counts dropped no-name rows in droppedNoName', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/dry-run')
      .send({ accounts: [ACME, NONAME] });

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.droppedNoName).toBe(1);
  });

  test('rejects empty accounts array with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/dry-run')
      .send({ accounts: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accounts array is required/i);
  });

  test('rejects more than 100 accounts with 400', async () => {
    const app = createApp();
    const accounts = Array.from({ length: 101 }, (_, i) => ({ name: `A${i}` }));
    const res = await request(app)
      .post('/api/account-list/dry-run')
      .send({ accounts });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Too many accounts/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/account-list/sync
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/account-list/sync', () => {
  test('full happy path: createList → upsert → addToList', async () => {
    createNamedAccountList.mockResolvedValueOnce({ listId: '999', name: 'My Sync' });
    upsertNamedAccounts.mockResolvedValueOnce([
      { name: 'Acme Corp', namedAccountId: '1', status: 'created' },
      { name: 'Beta LLC',  namedAccountId: '2', status: 'updated' },
    ]);
    addNamedAccountsToList.mockResolvedValueOnce([
      { id: '1', status: 'added' },
      { id: '2', status: 'added' },
    ]);

    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ listName: 'My Sync', accounts: [ACME, BETA] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      listId:   '999',
      listName: 'My Sync',
      error:    null,
    });
    expect(res.body.upserted).toHaveLength(2);
    expect(res.body.addedToList).toHaveLength(2);

    expect(createNamedAccountList).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My Sync', token: 'mkto-tok',
    }));
    expect(upsertNamedAccounts).toHaveBeenCalledWith(expect.objectContaining({
      token: 'mkto-tok',
      accounts: expect.arrayContaining([expect.objectContaining({ name: 'Acme Corp' })]),
    }));
    expect(addNamedAccountsToList).toHaveBeenCalledWith({
      listId: '999', namedAccountIds: ['1', '2'], token: 'mkto-tok',
    });
  });

  test('ABM not enabled (createList throws 403) → 502 with hint', async () => {
    createNamedAccountList.mockRejectedValueOnce(
      new Error('[writers/marketoLists] createNamedAccountList HTTP 403: 614:Access Denied'),
    );

    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ listName: 'My Sync', accounts: [ACME] });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/HTTP 403.*Access Denied/);
    expect(res.body.hint).toMatch(/Account-Based Marketing/i);
    expect(upsertNamedAccounts).not.toHaveBeenCalled();
    expect(addNamedAccountsToList).not.toHaveBeenCalled();
  });

  test('partial success: one account skipped during upsert → still adds the rest', async () => {
    createNamedAccountList.mockResolvedValueOnce({ listId: '999', name: 'My Sync' });
    upsertNamedAccounts.mockResolvedValueOnce([
      { name: 'Acme Corp', namedAccountId: '1', status: 'created' },
      { name: 'Beta LLC',  namedAccountId: null, status: 'skipped', error: '1006:Field not found' },
    ]);
    addNamedAccountsToList.mockResolvedValueOnce([
      { id: '1', status: 'added' },
    ]);

    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ listName: 'My Sync', accounts: [ACME, BETA] });

    expect(res.status).toBe(200);
    expect(res.body.upserted).toHaveLength(2);
    expect(res.body.addedToList).toEqual([{ id: '1', status: 'added' }]);

    // Only the successfully upserted id should be sent to addNamedAccountsToList
    expect(addNamedAccountsToList).toHaveBeenCalledWith(expect.objectContaining({
      namedAccountIds: ['1'],
    }));
  });

  test('auth failure → 502 with "Marketo auth failed:" message', async () => {
    getMarketoToken.mockRejectedValueOnce(new Error('invalid_client'));

    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ listName: 'My Sync', accounts: [ACME] });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Marketo auth failed:.*invalid_client/);
    expect(createNamedAccountList).not.toHaveBeenCalled();
  });

  test('rejects missing listName with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ accounts: [ACME] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/listName is required/i);
    expect(getMarketoToken).not.toHaveBeenCalled();
  });

  test('rejects missing accounts with 400', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/account-list/sync')
      .send({ listName: 'My Sync' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accounts array is required/i);
    expect(getMarketoToken).not.toHaveBeenCalled();
  });
});
