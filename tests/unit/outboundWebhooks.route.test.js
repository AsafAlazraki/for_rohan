'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));
// Keep the dispatcher itself real — we just need its CRUD helpers.

const express = require('express');
const request = require('supertest');

const { _setPool } = require('../../src/audit/db');
const { router } = require('../../src/routes/outboundWebhooks');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/webhooks', router);
  return a;
}

function makeSinkRow(overrides = {}) {
  return {
    id:              overrides.id || 'sink-1',
    name:            overrides.name || 'My sink',
    url:             overrides.url || 'https://example.test/hook',
    secret:          overrides.secret || 'super-secret-token',
    filter_status:   overrides.filter_status || null,
    filter_category: overrides.filter_category || null,
    filter_sources:  overrides.filter_sources  || null,
    enabled:         overrides.enabled === undefined ? true : overrides.enabled,
    created_at:      new Date('2026-04-01T00:00:00Z'),
    last_delivery:   null,
    last_status:     null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _setPool({ query: mockQuery });
});

describe('GET /api/webhooks/sinks', () => {
  test('returns sinks with masked secrets', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeSinkRow({ secret: 'abcdefghij' })] });

    const res = await request(app()).get('/api/webhooks/sinks');

    expect(res.status).toBe(200);
    expect(res.body.sinks).toHaveLength(1);
    // last 4 chars preserved, rest masked
    expect(res.body.sinks[0].secret).toBe('******ghij');
  });

  test('returns empty list gracefully', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/webhooks/sinks');
    expect(res.status).toBe(200);
    expect(res.body.sinks).toEqual([]);
  });
});

describe('POST /api/webhooks/sinks', () => {
  test('creates a sink and returns it with masked secret', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeSinkRow({ id: 'new-1', name: 'New', url: 'https://x', secret: 'topSecretKey' })],
    });

    const res = await request(app())
      .post('/api/webhooks/sinks')
      .send({
        name: 'New', url: 'https://x', secret: 'topSecretKey',
        filter_status: ['success'], filter_sources: ['dynamics'],
      });

    expect(res.status).toBe(201);
    expect(res.body.sink.id).toBe('new-1');
    expect(res.body.sink.secret).toBe('********tKey');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO outbound_webhook_sinks/i);
    expect(params[0]).toBe('New');
    expect(params[1]).toBe('https://x');
    expect(params[2]).toBe('topSecretKey');
    expect(params[3]).toEqual(['success']);
    expect(params[5]).toEqual(['dynamics']);
  });

  test('400 when required fields are missing', async () => {
    const res = await request(app())
      .post('/api/webhooks/sinks')
      .send({ name: 'only name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('500 with pg error message on insert failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('unique violation'));
    const res = await request(app())
      .post('/api/webhooks/sinks')
      .send({ name: 'n', url: 'u', secret: 's' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/unique violation/);
  });
});

describe('PUT /api/webhooks/sinks/:id', () => {
  test('updates allowed fields and returns masked sink', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makeSinkRow({ id: 'sink-2', name: 'Renamed', secret: 'freshSecret!' })],
    });

    const res = await request(app())
      .put('/api/webhooks/sinks/sink-2')
      .send({ name: 'Renamed', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.sink.id).toBe('sink-2');
    expect(res.body.sink.name).toBe('Renamed');
    expect(res.body.sink.secret).toBe('********ret!');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE outbound_webhook_sinks/i);
    expect(sql).toMatch(/name = \$1/);
    expect(sql).toMatch(/enabled = \$2/);
  });

  test('404 when row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app())
      .put('/api/webhooks/sinks/missing')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/webhooks/sinks/:id', () => {
  test('returns ok:true when a row is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app()).delete('/api/webhooks/sinks/sink-3');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('404 when no row existed', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(app()).delete('/api/webhooks/sinks/nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/webhooks/deliveries', () => {
  test('returns deliveries list filtered by sinkId', async () => {
    const deliveries = [
      {
        id: 'd1', sink_id: 'sink-1', event_id: 'e1',
        url: 'https://x', status: 200, response_ms: 42,
        error: null, attempt: 1, delivered_at: new Date(),
      },
    ];
    mockQuery.mockResolvedValueOnce({ rows: deliveries });

    const res = await request(app())
      .get('/api/webhooks/deliveries?sinkId=sink-1&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM outbound_webhook_deliveries/i);
    expect(sql).toMatch(/WHERE sink_id = \$1/i);
    expect(params).toEqual(['sink-1', 10]);
  });

  test('returns global deliveries when no sinkId provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/webhooks/deliveries');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM outbound_webhook_deliveries/i);
    expect(sql).not.toMatch(/WHERE sink_id/i);
    expect(params).toEqual([50]); // default limit
  });
});
