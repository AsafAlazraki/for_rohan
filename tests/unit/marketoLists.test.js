'use strict';

/**
 * Unit tests for src/writers/marketoLists.js — Marketo Named Account List APIs.
 *
 * Mocks axios.request (the method callMarketo uses internally) and the config
 * loader so MARKETO_BASE_URL resolves without touching the DB.
 */

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn(), request: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(async (k) => (k === 'MARKETO_BASE_URL' ? 'https://test.mktorest.com' : null)),
}));

const axios = require('axios');
const {
  createNamedAccountList,
  upsertNamedAccounts,
  addNamedAccountsToList,
} = require('../../src/writers/marketoLists');

// ── helpers ────────────────────────────────────────────────────────────────
function make429(retryAfterSecs = 0) {
  return Object.assign(new Error('Too Many Requests'), {
    response: { status: 429, headers: { 'retry-after': String(retryAfterSecs) } },
  });
}

function makeHttpError(status, body) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, headers: {}, data: body },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// createNamedAccountList
// ─────────────────────────────────────────────────────────────────────────────
describe('createNamedAccountList()', () => {
  test('happy path returns { listId, name } and POSTs to namedaccountlists.json', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: true, result: [{ id: 555, name: 'My List', status: 'created' }] },
    });

    const result = await createNamedAccountList({
      name: 'My List', description: 'desc', token: 'tok',
    });

    expect(result).toEqual({ listId: '555', name: 'My List' });
    expect(axios.request).toHaveBeenCalledTimes(1);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toContain('/rest/v1/namedaccountlists.json');
    expect(cfg.data).toEqual({ input: [{ name: 'My List', description: 'desc' }] });
    expect(cfg.headers.Authorization).toBe('Bearer tok');
  });

  test('throws when data.success is false', async () => {
    axios.request.mockResolvedValueOnce({
      data: { success: false, errors: [{ code: '1003', message: 'Bad input' }] },
    });
    await expect(
      createNamedAccountList({ name: 'X', token: 'tok' }),
    ).rejects.toThrow(/Create list failed.*1003.*Bad input/);
  });

  test('throws when result is missing or empty', async () => {
    axios.request.mockResolvedValueOnce({ data: { success: true, result: [] } });
    await expect(
      createNamedAccountList({ name: 'X', token: 'tok' }),
    ).rejects.toThrow(/Create list returned no id/);
  });

  test('throws with reasons string when status is skipped', async () => {
    axios.request.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{
          id: 1, name: 'X', status: 'skipped',
          reasons: [{ code: '1013', message: 'Named Account List already exists' }],
        }],
      },
    });
    await expect(
      createNamedAccountList({ name: 'X', token: 'tok' }),
    ).rejects.toThrow(/List skipped.*1013.*already exists/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertNamedAccounts
// ─────────────────────────────────────────────────────────────────────────────
describe('upsertNamedAccounts()', () => {
  test('happy path returns mapped per-record results', async () => {
    axios.request.mockResolvedValueOnce({
      data: {
        success: true,
        result: [
          { id: 1, status: 'created' },
          { id: 2, status: 'updated' },
        ],
      },
    });

    const out = await upsertNamedAccounts({
      accounts: [{ name: 'Acme' }, { name: 'Beta' }],
      token:    'tok',
    });

    expect(out).toEqual([
      { name: 'Acme', namedAccountId: '1', status: 'created' },
      { name: 'Beta', namedAccountId: '2', status: 'updated' },
    ]);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg.url).toContain('/rest/v1/namedaccounts.json');
    expect(cfg.data).toMatchObject({ action: 'createOrUpdate', dedupeBy: 'dedupeFields' });
  });

  test('flags mixed statuses (one created, one skipped) with reason', async () => {
    axios.request.mockResolvedValueOnce({
      data: {
        success: true,
        result: [
          { id: 10, status: 'created' },
          { status: 'skipped', reasons: [{ code: '1006', message: "Field 'industryCode' not found" }] },
        ],
      },
    });

    const out = await upsertNamedAccounts({
      accounts: [{ name: 'Acme' }, { name: 'Beta', industryCode: 'BAD' }],
      token:    'tok',
    });

    expect(out[0]).toEqual({ name: 'Acme', namedAccountId: '10', status: 'created' });
    expect(out[1]).toMatchObject({
      name: 'Beta',
      namedAccountId: null,
      status: 'skipped',
      error: expect.stringMatching(/1006.*industryCode/),
    });
  });

  test('returns [] without calling axios when accounts is empty', async () => {
    const out = await upsertNamedAccounts({ accounts: [], token: 'tok' });
    expect(out).toEqual([]);
    expect(axios.request).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addNamedAccountsToList
// ─────────────────────────────────────────────────────────────────────────────
describe('addNamedAccountsToList()', () => {
  test('happy path POSTs to the list-scoped endpoint and returns per-record statuses', async () => {
    axios.request.mockResolvedValueOnce({
      data: {
        success: true,
        result: [
          { status: 'added' },
          { status: 'added' },
        ],
      },
    });

    const out = await addNamedAccountsToList({
      listId:           '555',
      namedAccountIds:  ['1', '2'],
      token:            'tok',
    });

    expect(out).toEqual([
      { id: '1', status: 'added' },
      { id: '2', status: 'added' },
    ]);
    const cfg = axios.request.mock.calls[0][0];
    expect(cfg.url).toContain('/rest/v1/namedaccountlists/555/namedaccounts.json');
    expect(cfg.data).toEqual({ input: [{ id: 1 }, { id: 2 }] });
  });

  test('throws when listId is missing', async () => {
    await expect(
      addNamedAccountsToList({ namedAccountIds: ['1'], token: 'tok' }),
    ).rejects.toThrow(/listId required/);
    expect(axios.request).not.toHaveBeenCalled();
  });

  test('returns [] without calling axios when namedAccountIds is empty', async () => {
    const out = await addNamedAccountsToList({
      listId: '555', namedAccountIds: [], token: 'tok',
    });
    expect(out).toEqual([]);
    expect(axios.request).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: 429 backoff + axios error unwrapping
// ─────────────────────────────────────────────────────────────────────────────
describe('callMarketo cross-cutting concerns', () => {
  test('retries up to MAX_429_RETRIES then throws the unwrapped HTTP error', async () => {
    jest.useFakeTimers();
    try {
      // Always 429 — exhaust retries
      axios.request.mockRejectedValue(make429(0));

      const p = createNamedAccountList({ name: 'X', token: 'tok' });
      // Suppress unhandled-rejection warning while we flush timers
      p.catch(() => {});

      // Flush each backoff sleep (1 original + up to 3 retries)
      for (let i = 0; i < 5; i++) await jest.runAllTimersAsync();

      await expect(p).rejects.toMatchObject({ response: { status: 429 } });
      // 1 original attempt + 3 retries = 4 calls max
      expect(axios.request.mock.calls.length).toBeLessThanOrEqual(4);
      expect(axios.request.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('unwraps a 403 with errors[] body into an "HTTP 403: 614:Access Denied" message', async () => {
    axios.request.mockRejectedValueOnce(makeHttpError(403, {
      errors: [{ code: '614', message: 'Access Denied' }],
    }));

    await expect(
      createNamedAccountList({ name: 'X', token: 'tok' }),
    ).rejects.toThrow(/createNamedAccountList HTTP 403: 614:Access Denied/);
  });
});
