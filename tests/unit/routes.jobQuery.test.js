'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

const { getRecentJobs, getJobCount } = require('../../src/routes/jobQuery');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getRecentJobs', () => {
  it('queries with default options when no filters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'j1' }] });
    const rows = await getRecentJobs();
    expect(rows).toEqual([{ id: 'j1' }]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/pgboss\.job/);
    expect(sql).toMatch(/pgboss\.archive/);
    expect(params).toEqual([20, 0]);
  });

  it('applies queueName filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRecentJobs('sync-events', { limit: 5, offset: 10 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/name = \$1/);
    expect(params).toEqual(['sync-events', 5, 10]);
  });

  it('applies status filter (lowercased)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRecentJobs(null, { status: 'COMPLETED' });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toEqual(['completed', 20, 0]);
  });

  it('applies search filter (wildcard wrapped)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRecentJobs(null, { search: 'abc' });
    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBe('%abc%');
  });

  it('combines queueName + status + search', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRecentJobs('q', { limit: 5, offset: 0, status: 'failed', search: 'foo' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['q', 'failed', '%foo%', 5, 0]);
  });
});

describe('getJobCount', () => {
  it('returns 0 with no filters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const c = await getJobCount();
    expect(c).toBe(0);
  });

  it('returns parsed integer count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '42' }] });
    const c = await getJobCount('sync-events', { status: 'created' });
    expect(c).toBe(42);
  });

  it('applies search filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    const c = await getJobCount(null, { search: 'xyz' });
    expect(c).toBe(7);
    expect(mockQuery.mock.calls[0][1][0]).toBe('%xyz%');
  });

  it('applies queueName + status + search together', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    await getJobCount('q', { status: 'active', search: 'foo' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['q', 'active', '%foo%']);
  });
});
