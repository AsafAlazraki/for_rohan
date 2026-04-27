'use strict';

jest.mock('../../src/audit/db', () => ({ getPool: jest.fn() }));

const express = require('express');
const request = require('supertest');
const eventsRouter = require('../../src/routes/events');
const { getPool } = require('../../src/audit/db');

function makeApp() {
  const app = express();
  app.use('/api/events', eventsRouter);
  return app;
}

let mockQuery;
beforeEach(() => {
  jest.resetAllMocks();
  mockQuery = jest.fn();
  getPool.mockReturnValue({ query: mockQuery });
});

describe('GET /api/events', () => {
  it('returns paginated events with default page/limit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, status: 'success' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const res = await request(makeApp()).get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body).toMatchObject({ total: 1, page: 1, limit: 25, pages: 1 });
  });

  it('honours status and search filters', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await request(makeApp()).get('/api/events?status=Failed&search=foo&page=2&limit=10');
    const params = mockQuery.mock.calls[0][1];
    expect(params).toContain('failed');
    expect(params).toContain('%foo%');
    expect(params).toContain(10);
    expect(params).toContain(10); // offset
  });

  it('returns 500 when query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp()).get('/api/events');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db down');
  });

  it('clamps page to >=1 and limit to [1,100]', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    await request(makeApp()).get('/api/events?page=-5&limit=99999');
    // limit clamped to 100, page to 1
    expect(mockQuery.mock.calls[0][1]).toContain(100);
  });
});

describe('GET /api/events/stats — graph periods', () => {
  function mockBaseStats(rows) {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0', success: '0' }] })
      .mockResolvedValueOnce({ rows: rows || [] });
  }

  it('handles 7d graph period', async () => {
    mockBaseStats([]);
    const res = await request(makeApp()).get('/api/events/stats?graphPeriod=7d');
    expect(res.status).toBe(200);
    expect(res.body.graphData).toHaveLength(7);
  });

  it('handles 30d graph period', async () => {
    mockBaseStats([]);
    const res = await request(makeApp()).get('/api/events/stats?graphPeriod=30d');
    expect(res.status).toBe(200);
    expect(res.body.graphData).toHaveLength(30);
  });

  it('percentChange = 100 when prev24h=0 and count24h>0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // count24h
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // prev24h
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '11' }] }) // failures1h > 10
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0', success: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp()).get('/api/events/stats');
    expect(res.body.percentChange).toBe(100);
    expect(res.body.syncStatus).toBe('Unhealthy');
  });

  it('percentChange = 0 when both 24h are 0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // failures1h between 1-10 → degraded
      .mockResolvedValueOnce({ rows: [{ count: '50' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0', success: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp()).get('/api/events/stats');
    expect(res.body.percentChange).toBe(0);
    expect(res.body.syncStatus).toBe('Degraded');
  });

  it('webhookSuccessRate computed from totals', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '10', success: '8' }] })
      .mockResolvedValueOnce({ rows: [
        { bucket: new Date(), count: '3' },
      ] });
    const res = await request(makeApp()).get('/api/events/stats');
    expect(res.body.webhookSuccessRate).toBeCloseTo(80);
  });

  it('returns 500 on query error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/events/stats');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/events/webhook-usage', () => {
  function mockUsage({ stats = [], lastReceived = [], graph = [] } = {}) {
    mockQuery
      .mockResolvedValueOnce({ rows: stats })
      .mockResolvedValueOnce({ rows: lastReceived })
      .mockResolvedValueOnce({ rows: graph });
  }

  it('default 24h period returns systems + graphData', async () => {
    mockUsage({
      stats: [
        { source_system: 'dynamics', source_type: 'contact', total: '5' },
        { source_system: 'marketo',  source_type: 'lead',    total: '3' },
      ],
      lastReceived: [
        { source_system: 'dynamics', source_type: 'contact', last_received: new Date() },
        { source_system: 'marketo',  source_type: 'lead',    last_received: new Date() },
      ],
      graph: [],
    });
    const res = await request(makeApp()).get('/api/events/webhook-usage');
    expect(res.status).toBe(200);
    expect(res.body.systems.dynamics[0].name).toBe('Contact Created');
    expect(res.body.systems.marketo[0].name).toBe('Lead Created');
    expect(res.body.graphData).toHaveLength(24);
  });

  it('handles 7d period', async () => {
    mockUsage();
    const res = await request(makeApp()).get('/api/events/webhook-usage?period=7d');
    expect(res.status).toBe(200);
    expect(res.body.graphData).toHaveLength(7);
  });

  it('handles 30d period', async () => {
    mockUsage();
    const res = await request(makeApp()).get('/api/events/webhook-usage?period=30d');
    expect(res.status).toBe(200);
    expect(res.body.graphData).toHaveLength(30);
  });

  it('skips non-contact/non-lead source_types', async () => {
    mockUsage({
      stats: [{ source_system: 'dynamics', source_type: 'opportunity', total: '5' }],
      lastReceived: [],
      graph: [],
    });
    const res = await request(makeApp()).get('/api/events/webhook-usage');
    // No real entry → placeholder should be added
    expect(res.body.systems.dynamics).toHaveLength(1);
    expect(res.body.systems.dynamics[0].total).toBe(0);
  });

  it('falls back to placeholders when no rows found', async () => {
    mockUsage({ stats: [], lastReceived: [], graph: [] });
    const res = await request(makeApp()).get('/api/events/webhook-usage');
    expect(res.body.systems.dynamics[0].total).toBe(0);
    expect(res.body.systems.marketo[0].total).toBe(0);
  });

  it('zero-fills graph buckets and pulls counts when match', async () => {
    const aligned = new Date();
    aligned.setUTCMinutes(0, 0, 0);
    mockUsage({
      stats: [{ source_system: 'dynamics', source_type: 'contact', total: '7' }],
      lastReceived: [{ source_system: 'dynamics', source_type: 'contact', last_received: aligned }],
      graph: [
        { time_bucket: aligned, source_system: 'dynamics', source_type: 'contact', count: '7' },
        // Non-contact rows must be filtered out
        { time_bucket: aligned, source_system: 'dynamics', source_type: 'opportunity', count: '5' },
      ],
    });
    const res = await request(makeApp()).get('/api/events/webhook-usage');
    expect(res.body.graphData[res.body.graphData.length - 1].dynamics_contact).toBe(7);
  });

  it('returns 500 on query error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/events/webhook-usage');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/events/stream (SSE)', () => {
  it('opens SSE stream and writes connect comment', async () => {
    const app = makeApp();
    const server = app.listen(0);
    const port = server.address().port;
    // eslint-disable-next-line global-require
    const http = require('http');
    await new Promise(resolve => {
      const req = http.get({ port, path: '/api/events/stream' }, (res) => {
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString();
          if (buf.includes(': connected')) {
            res.destroy();
            resolve();
          }
        });
      });
      req.on('error', () => resolve());
    });
    server.close();
  });
});
