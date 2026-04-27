const request = require('supertest');
const express = require('express');
const eventsRouter = require('../../src/routes/events');
const db = require('../../src/audit/db');

jest.mock('../../src/audit/db', () => ({
  getPool: jest.fn(),
}));

describe('GET /api/events/stats', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use('/api/events', eventsRouter);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns aggregated stats successfully', async () => {
    const mockQuery = jest.fn();
    db.getPool.mockReturnValue({ query: mockQuery });

    // Mock the 6 queries in /api/events/stats
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // 1. Total events (success)
      .mockResolvedValueOnce({ rows: [{ count: '20' }] })  // 2. Last 24h (success)
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })  // 2. Prev 24h (success)
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })   // 3. Recent errors (24h)
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // NEW: Total errors (all time)
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // 4. Failures 1h
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // 4. Pending 10m
      .mockResolvedValueOnce({ rows: [{ total: '50', success: '45' }] }) // 5. Webhooks
      .mockResolvedValueOnce({ rows: [                     // 6. Hourly data
        { hour: new Date().toISOString(), count: '5' }
      ]});

    const res = await request(app).get('/api/events/stats');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalEvents: 100,
      count24h: 20,
      percentChange: 100, // (20 - 10) / 10 * 100
      totalErrors: 5,
      recentErrors: 2,
      syncStatus: 'Healthy', // 0 failures, 5 pending (<50)
      webhookSuccessRate: 90, // (45 / 50) * 100
    });
    expect(res.body.graphData).toBeInstanceOf(Array);
    expect(res.body.graphData.length).toBe(24);
  });

  it('calculates degraded status correctly', async () => {
    const mockQuery = jest.fn();
    db.getPool.mockReturnValue({ query: mockQuery });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // 1
      .mockResolvedValueOnce({ rows: [{ count: '20' }] })  // 2
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })  // 2
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })   // 3
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // NEW: Total errors
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // 4. Failures 1h (Degraded: 1-10)
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // 4. Pending 10m
      .mockResolvedValueOnce({ rows: [{ total: '0', success: '0' }] }) // 5. Webhooks
      .mockResolvedValueOnce({ rows: [] });                // 6. Hourly

    const res = await request(app).get('/api/events/stats');

    expect(res.status).toBe(200);
    expect(res.body.syncStatus).toBe('Degraded');
    expect(res.body.webhookSuccessRate).toBe(100); // Defaults to 100% if no deliveries
  });

  it('calculates unhealthy status correctly', async () => {
    const mockQuery = jest.fn();
    db.getPool.mockReturnValue({ query: mockQuery });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }] })
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // NEW: Total errors
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // 4. Failures 1h
      .mockResolvedValueOnce({ rows: [{ count: '150' }] }) // 4. Pending 10m (Unhealthy: >100)
      .mockResolvedValueOnce({ rows: [{ total: '10', success: '10' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/events/stats');

    expect(res.status).toBe(200);
    expect(res.body.syncStatus).toBe('Unhealthy');
  });

  it('handles database errors gracefully', async () => {
    const mockQuery = jest.fn().mockRejectedValue(new Error('DB failure'));
    db.getPool.mockReturnValue({ query: mockQuery });

    const res = await request(app).get('/api/events/stats');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'DB failure' });
  });
});
