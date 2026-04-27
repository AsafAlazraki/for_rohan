'use strict';

jest.mock('../../src/audit/db', () => ({ getPool: jest.fn() }));

const { getPool } = require('../../src/audit/db');
const dedupDb = require('../../src/engagement/dedupDb');

let mockQuery;
beforeEach(() => {
  mockQuery = jest.fn();
  getPool.mockReturnValue({ query: mockQuery });
});

describe('hasEmailOpen', () => {
  it('returns true when row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await dedupDb.hasEmailOpen(123, 'home')).toBe(true);
    expect(mockQuery.mock.calls[0][1]).toEqual([123, 'home']);
  });

  it('returns false when no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await dedupDb.hasEmailOpen(123, 'home')).toBe(false);
  });
});

describe('hasEmailClick', () => {
  it('queries with all 3 keys', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    expect(await dedupDb.hasEmailClick(1, 'home', '/x')).toBe(true);
    expect(mockQuery.mock.calls[0][1]).toEqual([1, 'home', '/x']);
  });

  it('returns false on empty', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await dedupDb.hasEmailClick(1, 'home', '/x')).toBe(false);
  });
});

describe('hasCampaignResponse', () => {
  it('encodes status into filter_reason', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    await dedupDb.hasCampaignResponse(7, 'Camp', 'opened');
    expect(mockQuery.mock.calls[0][1]).toEqual([7, 'Camp', 'status:opened']);
  });

  it('handles missing status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dedupDb.hasCampaignResponse(7, 'Camp', null);
    expect(mockQuery.mock.calls[0][1]).toEqual([7, 'Camp', 'status:']);
  });
});

describe('countRecentWebVisits', () => {
  it('returns numeric count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: 3 }] });
    expect(await dedupDb.countRecentWebVisits(99)).toBe(3);
  });

  it('returns 0 when no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await dedupDb.countRecentWebVisits(99)).toBe(0);
  });

  it('returns 0 when n missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    expect(await dedupDb.countRecentWebVisits(99)).toBe(0);
  });
});

describe('insertDedup', () => {
  it('inserts a full row with ON CONFLICT DO NOTHING', async () => {
    mockQuery.mockResolvedValueOnce({});
    await dedupDb.insertDedup({
      marketoActivityId:  1,
      activityTypeId:     9,
      marketoLeadId:      55,
      assetName:          'home',
      url:                '/x',
      dynamicsContactId:  'c',
      dynamicsEngagementActivityId: 'e',
      filterDecision:     'written',
      filterReason:       null,
      occurredAt:         '2026-01-01',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params).toEqual([1, 9, '55', 'home', '/x', 'c', 'e', 'written', null, '2026-01-01']);
  });

  it('coerces falsy optional fields to null', async () => {
    mockQuery.mockResolvedValueOnce({});
    await dedupDb.insertDedup({
      marketoActivityId: 2,
      activityTypeId:    1,
      marketoLeadId:     null,
      filterDecision:    'unmatched',
    });
    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBeNull(); // marketoLeadId
    expect(params[3]).toBeNull(); // assetName
    expect(params[4]).toBeNull(); // url
  });
});

describe('listRecent', () => {
  it('queries with no filters by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ marketo_activity_id: 1 }] });
    const rows = await dedupDb.listRecent();
    expect(rows).toHaveLength(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([50]);
  });

  it('applies type filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dedupDb.listRecent({ type: '9' });
    expect(mockQuery.mock.calls[0][1]).toEqual([9, 50]);
  });

  it('applies since filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dedupDb.listRecent({ since: '2026-01-01' });
    expect(mockQuery.mock.calls[0][1][0]).toBeInstanceOf(Date);
  });

  it('clamps limit to 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dedupDb.listRecent({ limit: 9999 });
    expect(mockQuery.mock.calls[0][1]).toEqual([500]);
  });

  it('handles invalid limit by defaulting to 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dedupDb.listRecent({ limit: 'abc' });
    expect(mockQuery.mock.calls[0][1]).toEqual([50]);
  });
});

describe('aggregateStats', () => {
  it('collects totals + byType + byStatus', async () => {
    mockQuery.mockImplementation((sql) => {
      if (sql.includes('COUNT(*)::int AS n FROM engagement_dedup\n  ')) return Promise.resolve({ rows: [{ n: 7 }] });
      if (sql.includes('activity_type_id AS type')) return Promise.resolve({ rows: [{ type: 1, n: 3 }] });
      if (sql.includes('filter_decision AS status')) return Promise.resolve({ rows: [{ status: 'written', n: 5 }] });
      return Promise.resolve({ rows: [] });
    });
    const r = await dedupDb.aggregateStats();
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(r.byType)).toBe(true);
    expect(Array.isArray(r.byStatus)).toBe(true);
  });

  it('falls back to 0 / empty arrays on no data', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await dedupDb.aggregateStats();
    expect(r.total).toBe(0);
    expect(r.byType).toEqual([]);
    expect(r.byStatus).toEqual([]);
  });
});
