'use strict';

jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

jest.mock('../../src/config/loader', () => ({ getConfig: jest.fn() }));

jest.mock('../../src/engagement/activityWriter', () => ({
  TYPE_LABELS: { 1: 'Web Visit', 9: 'Email Click' },
}));

jest.mock('../../src/engagement/dedupDb', () => ({
  listRecent: jest.fn(),
  aggregateStats: jest.fn(),
}));

jest.mock('../../src/engagement/runner', () => ({
  runOnce: jest.fn(),
  KEY_LAST_RUN: 'MARKETO_ENGAGEMENT_LAST_RUN',
}));

const express = require('express');
const request = require('supertest');
const { router } = require('../../src/routes/engagement');
const dedupDb = require('../../src/engagement/dedupDb');
const runner = require('../../src/engagement/runner');
const { getConfig } = require('../../src/config/loader');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/engagement', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/engagement/recent', () => {
  it('returns shaped rows', async () => {
    dedupDb.listRecent.mockResolvedValueOnce([{
      marketo_activity_id: 1, activity_type_id: 1,
      dynamics_contact_id: 'c1', dynamics_engagement_activity_id: 'e1',
      asset_name: 'home', occurred_at: '2026-01-01', filter_decision: 'written',
      filter_reason: null,
    }]);
    const res = await request(makeApp()).get('/api/engagement/recent');
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({
      id: '1', typeName: 'Web Visit', status: 'written',
    });
  });

  it('400 when type query is non-numeric', async () => {
    const res = await request(makeApp()).get('/api/engagement/recent?type=foo');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/numeric/);
  });

  it('clamps limit and forwards type+since', async () => {
    dedupDb.listRecent.mockResolvedValueOnce([]);
    await request(makeApp()).get('/api/engagement/recent?limit=9999&type=1&since=2026-01-01');
    expect(dedupDb.listRecent).toHaveBeenCalledWith({ limit: 500, type: 1, since: '2026-01-01' });
  });

  it('falls back to "Type N" label for unknown type', async () => {
    dedupDb.listRecent.mockResolvedValueOnce([{
      marketo_activity_id: 2, activity_type_id: 99,
      dynamics_contact_id: null, dynamics_engagement_activity_id: null,
      asset_name: null, occurred_at: null, filter_decision: 'skipped',
      filter_reason: 'no-match',
    }]);
    const res = await request(makeApp()).get('/api/engagement/recent');
    expect(res.body.rows[0].typeName).toBe('Type 99');
  });

  it('500 on DB error', async () => {
    dedupDb.listRecent.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/engagement/recent');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});

describe('GET /api/engagement/stats', () => {
  it('returns totals + lastRun', async () => {
    dedupDb.aggregateStats.mockResolvedValueOnce({
      total: 5,
      byType: [{ type: 1, n: 3 }, { type: 99, n: 2 }],
      byStatus: [{ status: 'written', n: 4 }, { status: 'skipped', n: 1 }, { status: 'extra', n: 99 }],
    });
    getConfig.mockResolvedValueOnce(JSON.stringify({ at: '2026-01-01', fetched: 10 }));

    const res = await request(makeApp()).get('/api/engagement/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalIngested: 5,
      byType: { 'Web Visit': 3, 'Type 99': 2 },
      byStatus: { written: 4, skipped: 1, unmatched: 0 },
      lastRun: { at: '2026-01-01', fetched: 10 },
    });
  });

  it('falls back to raw when JSON.parse fails', async () => {
    dedupDb.aggregateStats.mockResolvedValueOnce({ total: 0, byType: [], byStatus: [] });
    getConfig.mockResolvedValueOnce('not-json');
    const res = await request(makeApp()).get('/api/engagement/stats');
    expect(res.body.lastRun).toEqual({ raw: 'not-json' });
  });

  it('lastRun=null when no config blob exists', async () => {
    dedupDb.aggregateStats.mockResolvedValueOnce({ total: 0, byType: [], byStatus: [] });
    getConfig.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/api/engagement/stats');
    expect(res.body.lastRun).toBeNull();
  });

  it('500 on aggregator error', async () => {
    dedupDb.aggregateStats.mockRejectedValueOnce(new Error('agg-fail'));
    const res = await request(makeApp()).get('/api/engagement/stats');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/engagement/trigger', () => {
  it('returns runner summary', async () => {
    runner.runOnce.mockResolvedValueOnce({ fetched: 1, written: 1 });
    const res = await request(makeApp()).post('/api/engagement/trigger');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, summary: { fetched: 1, written: 1 } });
  });

  it('502 when runner throws', async () => {
    runner.runOnce.mockRejectedValueOnce(new Error('runner-fail'));
    const res = await request(makeApp()).post('/api/engagement/trigger');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'runner-fail' });
  });
});

describe('POST /api/engagement/dry-run', () => {
  it('returns dry-run summary with written=0 and samples', async () => {
    runner.runOnce.mockResolvedValueOnce({
      fetched: 5, written: 3, skipped: 1, unmatched: 1, durationMs: 100,
      samples: [{ id: 'a' }],
    });
    const res = await request(makeApp()).post('/api/engagement/dry-run');
    expect(res.status).toBe(200);
    expect(res.body.summary.written).toBe(0);
    expect(res.body.summary.samples).toHaveLength(1);
    expect(runner.runOnce).toHaveBeenCalledWith({ dryRun: true });
  });

  it('handles missing samples gracefully', async () => {
    runner.runOnce.mockResolvedValueOnce({
      fetched: 0, written: 0, skipped: 0, unmatched: 0, durationMs: 1,
    });
    const res = await request(makeApp()).post('/api/engagement/dry-run');
    expect(res.body.summary.samples).toEqual([]);
  });

  it('502 when runner throws', async () => {
    runner.runOnce.mockRejectedValueOnce(new Error('dry-fail'));
    const res = await request(makeApp()).post('/api/engagement/dry-run');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, dryRun: true, error: 'dry-fail' });
  });
});
