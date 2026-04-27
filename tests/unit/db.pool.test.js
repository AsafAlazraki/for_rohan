'use strict';

// Build a clean pg mock so we can inspect the constructor args.
const mockPoolCtor = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((opts) => {
    mockPoolCtor(opts);
    return { query: jest.fn().mockResolvedValue({ rows: [] }) };
  }),
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    readFileSync: jest.fn((p, ...rest) => {
      if (String(p).includes('FAKE_CA_OK')) return Buffer.from('---CA-PEM---');
      if (String(p).includes('FAKE_CA_BAD')) throw new Error('ENOENT');
      return real.readFileSync(p, ...rest);
    }),
  };
});

jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const logger = require('../../src/audit/logger');

function loadFresh() {
  jest.resetModules();
  // Re-establish jest.mock chains for the fresh module graph.
  jest.mock('../../src/audit/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }));
  jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation((opts) => {
      mockPoolCtor(opts);
      return { query: jest.fn().mockResolvedValue({ rows: [] }) };
    }),
  }));
  jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
      ...real,
      readFileSync: jest.fn((p, ...rest) => {
        if (String(p).includes('FAKE_CA_OK')) return Buffer.from('---CA-PEM---');
        if (String(p).includes('FAKE_CA_BAD')) throw new Error('ENOENT');
        return real.readFileSync(p, ...rest);
      }),
    };
  });
  const db = require('../../src/audit/db');
  const freshLogger = require('../../src/audit/logger');
  return { db, freshLogger };
}

const ENV_KEYS = ['DATABASE_URL', 'PG_CA_CERT', 'PGHOST', 'PGPORT',
  'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSL', 'PG_POOL_MAX', 'PG_POOL_IDLE_MS'];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  mockPoolCtor.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('getPool — DATABASE_URL path', () => {
  it('builds pool from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://u:p@h/d';
    const { db } = loadFresh();
    db.getPool();
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: 'postgres://u:p@h/d',
      max: 5,
    }));
  });

  it('reuses singleton on subsequent calls', () => {
    process.env.DATABASE_URL = 'postgres://x';
    const { db } = loadFresh();
    const a = db.getPool();
    const b = db.getPool();
    expect(a).toBe(b);
    expect(mockPoolCtor).toHaveBeenCalledTimes(1);
  });

  it('emits warn when DATABASE_URL set but no PG_CA_CERT', () => {
    process.env.DATABASE_URL = 'postgres://x';
    const { db, freshLogger } = loadFresh();
    db.getPool();
    expect(freshLogger.warn).toHaveBeenCalledWith(expect.stringContaining('PG_CA_CERT is not set'));
  });

  it('uses PG_CA_CERT when provided successfully', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.PG_CA_CERT   = '/some/FAKE_CA_OK.pem';
    const { db } = loadFresh();
    db.getPool();
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      ssl: expect.objectContaining({ ca: expect.any(Buffer) }),
    }));
  });

  it('falls back to system CA on PG_CA_CERT read error, with warn', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.PG_CA_CERT   = '/some/FAKE_CA_BAD.pem';
    const { db, freshLogger } = loadFresh();
    db.getPool();
    expect(freshLogger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('honours PG_POOL_MAX / PG_POOL_IDLE_MS overrides', () => {
    process.env.DATABASE_URL  = 'postgres://x';
    process.env.PG_POOL_MAX    = '12';
    process.env.PG_POOL_IDLE_MS = '7777';
    const { db } = loadFresh();
    db.getPool();
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      max: 12, idleTimeoutMillis: 7777,
    }));
  });
});

describe('getPool — host/port path', () => {
  it('builds pool from PGHOST etc when DATABASE_URL absent', () => {
    process.env.PGHOST     = 'h';
    process.env.PGPORT     = '6543';
    process.env.PGDATABASE = 'd';
    process.env.PGUSER     = 'u';
    process.env.PGPASSWORD = 'p';
    const { db } = loadFresh();
    db.getPool();
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      host: 'h', port: 6543, database: 'd', user: 'u', password: 'p', ssl: false,
    }));
  });

  it('uses PGSSL=true to enable SSL', () => {
    process.env.PGHOST = 'h';
    process.env.PGSSL  = 'true';
    const { db } = loadFresh();
    db.getPool();
    const opts = mockPoolCtor.mock.calls[0][0];
    // ssl is buildSslConfig() result — true when no CA, or object when CA set
    expect(opts.ssl).toBeTruthy();
  });

  it('uses sensible defaults for PGHOST etc when not set', () => {
    const { db } = loadFresh();
    db.getPool();
    expect(mockPoolCtor).toHaveBeenCalledWith(expect.objectContaining({
      host: 'localhost', port: 5432, database: 'sync_db',
    }));
  });
});

describe('warning for missing PG_CA_CERT is one-time only', () => {
  it('does not re-emit on subsequent getPool calls', () => {
    process.env.DATABASE_URL = 'postgres://x';
    const { db, freshLogger } = loadFresh();
    db.getPool();
    db.getPool();
    const noCAWarns = freshLogger.warn.mock.calls.filter(c =>
      String(c[0]).includes('PG_CA_CERT is not set'),
    );
    expect(noCAWarns.length).toBeLessThanOrEqual(1);
  });
});
