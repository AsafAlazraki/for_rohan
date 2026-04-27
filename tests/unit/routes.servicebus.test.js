'use strict';

jest.mock('../../src/routes/jobQuery', () => ({
  getRecentJobs: jest.fn(),
  getJobCount:   jest.fn(),
}));

jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const router = require('../../src/routes/servicebus');
const { getRecentJobs, getJobCount } = require('../../src/routes/jobQuery');

function makeApp() {
  const app = express();
  app.use('/api/servicebus', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/servicebus/messages', () => {
  it('returns empty list with pagination when no jobs', async () => {
    getRecentJobs.mockResolvedValueOnce([]);
    getJobCount.mockResolvedValueOnce(0);

    const res = await request(makeApp()).get('/api/servicebus/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.pagination).toEqual({ total: 0, page: 1, limit: 50, pages: 0 });
  });

  it('honours limit/page query params and clamps limit', async () => {
    getRecentJobs.mockResolvedValueOnce([]);
    getJobCount.mockResolvedValueOnce(0);
    await request(makeApp()).get('/api/servicebus/messages?limit=99999&page=3');
    expect(getRecentJobs).toHaveBeenCalledWith(null, expect.objectContaining({
      limit: 500, offset: 1000, status: null, search: null,
    }));
  });

  it('parses Marketo engagement-ingest jobs (Activity type, source/destination)', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j1',
      name: 'marketo-engagement-ingest',
      state: 'completed',
      data: { activityTypeId: 1, assetName: 'home', campaignName: 'Camp1' },
      createdon: '2026-01-01T00:00:00Z',
      completedon: '2026-01-01T00:00:01Z',
      retrycount: 0,
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const res = await request(makeApp()).get('/api/servicebus/messages?limit=10');
    expect(res.status).toBe(200);
    const m = res.body.messages[0];
    expect(m.activityTypeLabel).toBe('Web Visit');
    expect(m.assetName).toBe('home');
    expect(m.campaignName).toBe('Camp1');
    expect(m.source).toBe('Marketo');
    expect(m.destination).toBe('Dynamics');
    expect(m.type).toBe('Activity');
  });

  it('falls back to primaryAttributeValue when assetName missing', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j2', name: 'marketo-engagement-ingest', state: 'created',
      data: { activityTypeId: 999, primaryAttributeValue: 'PV' },
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const res = await request(makeApp()).get('/api/servicebus/messages');
    const m = res.body.messages[0];
    expect(m.activityTypeLabel).toBeNull();
    expect(m.assetName).toBe('PV');
  });

  it('parses sync jobs with source=dynamics', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j3', name: 'sync-events', state: 'completed',
      data: { source: 'dynamics', payload: { type: 'contact' } },
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.source).toBe('Dynamics');
    expect(m.destination).toBe('Marketo');
    expect(m.type).toBe('Contact');
  });

  it('parses sync jobs with source=marketo and lead payload', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j4', name: 'sync-events', state: 'completed',
      data: { source: 'marketo', payload: { leadid: 'L1' } },
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.source).toBe('Marketo');
    expect(m.destination).toBe('Dynamics');
    expect(m.type).toBe('Lead');
  });

  it('handles unknown source', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j5', name: 'sync-events', state: 'created',
      data: { source: 'other', type: 'account' },
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.source).toBe('other');
    expect(m.destination).toBeNull();
    expect(m.type).toBe('Account');
  });

  it('parses string-encoded JSON data', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j6', name: 'sync-events', state: 'created',
      data: JSON.stringify({ source: 'marketo', payload: { contactid: 'c' } }),
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.type).toBe('Contact');
    expect(m.parseError).toBeNull();
  });

  it('reports parseError on invalid JSON string', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j7', name: 'sync-events', state: 'created', data: 'not-json',
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.parseError).toBe('Invalid JSON');
  });

  it('detects Account from payload.accountid', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j8', name: 'sync-events', state: 'created',
      data: { payload: { accountid: 'a1' } },
    }]);
    getJobCount.mockResolvedValueOnce(1);

    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.type).toBe('Account');
  });

  it('detects Lead from crmLeadId', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j9', name: 'sync-events', state: 'created',
      data: { payload: { crmLeadId: 'l1' } },
    }]);
    getJobCount.mockResolvedValueOnce(1);
    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.type).toBe('Lead');
  });

  it('detects Contact from crmContactId', async () => {
    getRecentJobs.mockResolvedValueOnce([{
      id: 'j10', name: 'sync-events', state: 'created',
      data: { payload: { crmContactId: 'c1' } },
    }]);
    getJobCount.mockResolvedValueOnce(1);
    const m = (await request(makeApp()).get('/api/servicebus/messages')).body.messages[0];
    expect(m.type).toBe('Contact');
  });

  it('returns 500 when query fails', async () => {
    getRecentJobs.mockRejectedValueOnce(new Error('db down'));
    getJobCount.mockResolvedValueOnce(0);
    const res = await request(makeApp()).get('/api/servicebus/messages');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db down');
  });

  it('honours status and search filters', async () => {
    getRecentJobs.mockResolvedValueOnce([]);
    getJobCount.mockResolvedValueOnce(0);
    await request(makeApp()).get('/api/servicebus/messages?status=failed&search=foo');
    expect(getRecentJobs).toHaveBeenCalledWith(null, expect.objectContaining({
      status: 'failed', search: 'foo',
    }));
  });
});
