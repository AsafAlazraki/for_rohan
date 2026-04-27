'use strict';

// Mock pg before requiring loader
jest.mock('pg', () => {
  const mPool = {
    query: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

const { Pool } = require('pg');
const loader = require('../../src/config/loader');
const pool = new Pool();

beforeEach(() => {
  loader._reset();
  jest.clearAllMocks();
});

describe('config/loader.getConfig', () => {
  test('returns value from process.env if set', async () => {
    process.env.TEST_KEY = 'env-value';
    const val = await loader.getConfig('TEST_KEY');
    expect(val).toBe('env-value');
    delete process.env.TEST_KEY;
  });

  test('caches bulk refresh for 60s — second call hits cache only', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ key: 'K1', value: 'v1', is_secret: false, updated_at: 't' }],
    });

    await loader.getConfig('K1');
    await loader.getConfig('K1');

    // Bulk refresh happens exactly once across both calls
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT key, value, is_secret, updated_at FROM admin_config'));
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('returns null when key missing in both DB and env', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // bulk refresh
    pool.query.mockResolvedValueOnce({ rows: [] }); // single key fallback

    const val = await loader.getConfig('MISSING_KEY');
    expect(val).toBeNull();
  });
});

describe('config/loader.setConfig', () => {
  test('can round-trip a non-secret value', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    // Ensure env doesn't shadow the DB value on the read leg.
    delete process.env.LEAD_COUNTRY_ALLOWLIST;

    await loader.setConfig('LEAD_COUNTRY_ALLOWLIST', 'NZ,AU', false);

    // setConfig primes the in-memory cache immediately so the next read is
    // instantaneous — exactly the round-trip the Admin UI relies on.
    expect(await loader.getConfig('LEAD_COUNTRY_ALLOWLIST')).toBe('NZ,AU');

    // And the upserted row was marked non-secret, so listConfig returns the
    // plain value (not the masked ••••-prefixed form).
    pool.query.mockResolvedValueOnce({
      rows: [{ key: 'LEAD_COUNTRY_ALLOWLIST', value: 'NZ,AU', is_secret: false, updated_at: 't' }],
    });
    const listed = await loader.listConfig();
    const row    = listed.find(r => r.key === 'LEAD_COUNTRY_ALLOWLIST');
    expect(row).toMatchObject({ key: 'LEAD_COUNTRY_ALLOWLIST', value: 'NZ,AU', is_secret: false });
  });
});

describe('config/loader.maskSecret', () => {
  test('masks all but last 4 chars', () => {
    expect(loader.maskSecret('supersecretkey1234')).toBe('••••1234');
  });
  test('fully masks short values', () => {
    expect(loader.maskSecret('abc')).toBe('••••');
    expect(loader.maskSecret('')).toBe('');
  });
});
