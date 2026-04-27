'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));
jest.mock('../../src/events/bus', () => ({ bus: { on: jest.fn(), off: jest.fn() } }));


const express = require('express');
const request = require('supertest');

const { _setPool } = require('../../src/audit/db');
const eventsRouter = require('../../src/routes/events');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/events', eventsRouter);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  _setPool({ query: mockQuery });
});

describe('GET /api/events/skipped', () => {
  test('filters by status=skipped and created_at >= since', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const since = '2026-04-10T00:00:00.000Z';
    const res = await request(app()).get(`/api/events/skipped?since=${encodeURIComponent(since)}`);

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM sync_events/i);
    expect(sql).toMatch(/status\s*=\s*'skipped'/i);
    expect(sql).toMatch(/created_at\s*>=\s*\$1/i);
    expect(sql).toMatch(/GROUP BY reason_category, reason_criterion/i);
    expect(params[0]).toBe(since);
  });

  test('aggregates groups and totals with lastSeen as ISO', async () => {
    const d1 = new Date('2026-04-18T09:00:00.000Z');
    const d2 = new Date('2026-04-19T12:30:00.000Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        { category: 'authority',   criterion: 'marketo-cannot-update-existing-lead', count: 17, last_seen: d2 },
        { category: 'eligibility', criterion: 'companyExists,dataCompleteness',      count: 10, last_seen: d1 },
      ],
    });

    const res = await request(app()).get('/api/events/skipped');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(27);
    expect(res.body.groups).toEqual([
      { category: 'authority',   criterion: 'marketo-cannot-update-existing-lead', count: 17, lastSeen: d2.toISOString() },
      { category: 'eligibility', criterion: 'companyExists,dataCompleteness',      count: 10, lastSeen: d1.toISOString() },
    ]);
    expect(typeof res.body.since).toBe('string');
  });

  test('respects explicit limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app()).get('/api/events/skipped?limit=7');

    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe(7);
  });

  test('clamps limit to sane bounds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/events/skipped?limit=99999');
    expect(mockQuery.mock.calls[0][1][1]).toBe(500);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/events/skipped?limit=0');
    // 0 is falsy -> falls back to default 50
    expect(mockQuery.mock.calls[1][1][1]).toBe(50);
  });

  test('defaults since to ~24h ago and limit to 50 when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const before = Date.now();
    const res = await request(app()).get('/api/events/skipped');
    const after = Date.now();

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    const sinceMs = new Date(params[0]).getTime();
    const windowMs = 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(before - windowMs - 50);
    expect(sinceMs).toBeLessThanOrEqual(after - windowMs + 50);

    expect(params[1]).toBe(50);
    expect(res.body.since).toBe(params[0]);
  });

  test('empty result returns total:0 and groups:[]', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app()).get('/api/events/skipped');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  test('rejects invalid since parameter', async () => {
    const res = await request(app()).get('/api/events/skipped?since=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('returns 500 with error message on pg failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg exploded'));

    const res = await request(app()).get('/api/events/skipped');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'pg exploded' });
  });
});
