'use strict';

// ── Mock pg-boss before any require ───────────────────────────────────────────
const mockPublish = jest.fn().mockResolvedValue('pg-job-uuid');
const mockStart   = jest.fn().mockResolvedValue(undefined);
const mockStop    = jest.fn().mockResolvedValue(undefined);
const mockOn      = jest.fn();

jest.mock('pg-boss', () => jest.fn().mockImplementation(() => ({
  start:   mockStart,
  stop:    mockStop,
  send:    mockPublish,
  on:      mockOn,
})));

const PgBoss = require('pg-boss');
const { enqueue, getBoss, startBoss, stopBoss, QUEUE_NAME, _reset } =
  require('../../src/queue/queue');

beforeEach(() => {
  _reset();
  jest.clearAllMocks();
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SYNC_QUEUE_NAME = 'sync-events';
});

afterEach(() => {
  _reset();
  delete process.env.DATABASE_URL;
  delete process.env.SYNC_QUEUE_NAME;
});

describe('getBoss()', () => {
  it('constructs a pg-boss instance using the database connection string', () => {
    getBoss();
    expect(PgBoss).toHaveBeenCalledTimes(1);
    expect(PgBoss.mock.calls[0][0]).toMatchObject({
      connectionString: 'postgres://test:test@localhost:5432/test',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = getBoss();
    const b = getBoss();
    expect(a).toBe(b);
    expect(PgBoss).toHaveBeenCalledTimes(1);
  });

  it('throws when DATABASE_URL is not set', () => {
    delete process.env.DATABASE_URL;
    _reset();
    expect(() => getBoss()).toThrow(/DATABASE_URL/);
  });
});

describe('startBoss()', () => {
  it('starts pg-boss, idempotent across calls', async () => {
    await startBoss();
    await startBoss();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});

describe('enqueue()', () => {
  it('publishes the job to the managed queue with retry options', async () => {
    const data = { source: 'dynamics', payload: { email: 'a@b.com' } };
    const jobId = await enqueue('sync-events', data);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('sync-events', data, expect.objectContaining({
      retryLimit:   expect.any(Number),
      retryDelay:   expect.any(Number),
      retryBackoff: true,
    }));
    expect(jobId).toBe('pg-job-uuid');
  });

  it('ignores the queueName arg and always uses the managed queue name', async () => {
    await enqueue('anything', { source: 'marketo', payload: {} });
    expect(mockPublish).toHaveBeenCalledWith('sync-events', expect.any(Object), expect.any(Object));
  });
});

describe('stopBoss()', () => {
  it('gracefully drains pg-boss and nulls the singleton', async () => {
    await startBoss();
    await stopBoss();
    expect(mockStop).toHaveBeenCalledWith(expect.objectContaining({ graceful: true }));
  });
});

describe('QUEUE_NAME constant', () => {
  it('equals the SYNC_QUEUE_NAME env var', () => {
    expect(QUEUE_NAME).toBe('sync-events');
  });
});
