'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('../../src/queue/queue', () => ({
  QUEUE_NAME: 'sync-events',
}));

const mockPoolQuery = jest.fn();
jest.mock('../../src/audit/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

const { getQueueDepth, getDLQDepth, getErrorRate, getMetrics } =
  require('../../src/monitor/metrics');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── getQueueDepth ──────────────────────────────────────────────────────────────
describe('getQueueDepth()', () => {
  it('returns waiting (created) + active + delayed (retry) counts and total', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { state: 'created', c: 3 },
        { state: 'retry',   c: 1 },
        { state: 'active',  c: 2 },
      ],
    });
    const result = await getQueueDepth();
    expect(result).toEqual({ waiting: 3, active: 2, delayed: 1, total: 6 });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('pgboss.job');
    expect(params[0]).toBe('sync-events');
    expect(params[1]).toEqual(['created', 'retry', 'active']);
  });

  it('defaults missing states to 0', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getQueueDepth();
    expect(result).toEqual({ waiting: 0, active: 0, delayed: 0, total: 0 });
  });
});

// ── getDLQDepth ───────────────────────────────────────────────────────────────
describe('getDLQDepth()', () => {
  it('returns the failed count from pgboss.job', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ state: 'failed', c: 12 }] });
    expect(await getDLQDepth()).toBe(12);
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[1]).toEqual(['failed']);
  });

  it('returns 0 when no failed rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getDLQDepth()).toBe(0);
  });
});

// ── getErrorRate ──────────────────────────────────────────────────────────────
describe('getErrorRate()', () => {
  it('calculates error rate correctly', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ failed_count: '5', total_count: '100' }],
    });
    const result = await getErrorRate(15);
    expect(result).toEqual({ failedCount: 5, totalCount: 100, errorRate: 0.05 });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('sync_events');
    expect(params[0]).toBeInstanceOf(Date);
  });

  it('returns errorRate=0 when totalCount is 0', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ failed_count: '0', total_count: '0' }],
    });
    expect((await getErrorRate()).errorRate).toBe(0);
  });

  it('queries within the correct time window', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ failed_count: '0', total_count: '0' }] });
    const before = new Date();
    await getErrorRate(30);
    const [, params] = mockPoolQuery.mock.calls[0];
    const diffMs = before - params[0];
    expect(diffMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(diffMs).toBeLessThan(31 * 60 * 1000);
  });
});

// ── getMetrics ─────────────────────────────────────────────────────────────────
describe('getMetrics()', () => {
  it('aggregates all three metrics into a single snapshot', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [                      // queueDepth
        { state: 'created', c: 1 },
        { state: 'retry',   c: 0 },
        { state: 'active',  c: 0 },
      ]})
      .mockResolvedValueOnce({ rows: [{ state: 'failed', c: 2 }] })  // dlqDepth
      .mockResolvedValueOnce({ rows: [                              // errorRate
        { failed_count: '1', total_count: '20' },
      ]});

    const metrics = await getMetrics();
    expect(metrics).toMatchObject({
      queueDepth: { waiting: 1, active: 0, delayed: 0, total: 1 },
      dlqDepth:   2,
      errorRate:  { failedCount: 1, totalCount: 20, errorRate: 0.05 },
      ts:         expect.any(String),
    });
  });
});
