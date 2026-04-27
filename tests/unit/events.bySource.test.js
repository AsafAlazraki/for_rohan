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

describe('GET /api/events/by-source', () => {
  test('filters by source_system and source_id, orders by created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app())
      .get('/api/events/by-source?source=dynamics&sourceId=contact-guid-1');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM sync_events/i);
    expect(sql).toMatch(/source_system\s*=\s*\$1/i);
    expect(sql).toMatch(/source_id\s*=\s*\$2/i);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(sql).toMatch(/LIMIT\s*\$3/i);
    expect(params[0]).toBe('dynamics');
    expect(params[1]).toBe('contact-guid-1');
  });

  test('returns events with ISO timestamps and a total count', async () => {
    const t1 = new Date('2026-04-18T09:00:00.000Z');
    const t2 = new Date('2026-04-19T12:30:00.000Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id:               'evt-2',
          status:           'success',
          source_type:      'contact',
          target_id:        'mkto-42',
          error_message:    null,
          reason_category:  null,
          reason_criterion: null,
          payload:          { firstname: 'Jane' },
          created_at:       t2,
        },
        {
          id:               'evt-1',
          status:           'skipped',
          source_type:      'contact',
          target_id:        null,
          error_message:    'authority:marketo-cannot-update-existing-lead',
          reason_category:  'authority',
          reason_criterion: 'marketo-cannot-update-existing-lead',
          payload:          { email: 'j@x.com' },
          created_at:       t1,
        },
      ],
    });

    const res = await request(app())
      .get('/api/events/by-source?source=marketo&sourceId=MKTO-9');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('marketo');
    expect(res.body.sourceId).toBe('MKTO-9');
    expect(res.body.total).toBe(2);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].id).toBe('evt-2');
    expect(res.body.events[0].created_at).toBe(t2.toISOString());
    expect(res.body.events[0].payload_truncated).toBe(false);
    expect(res.body.events[0].payload_preview).toBe(JSON.stringify({ firstname: 'Jane' }));
    expect(res.body.events[1].reason_category).toBe('authority');
  });

  test('respects explicit limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app())
      .get('/api/events/by-source?source=dynamics&sourceId=x&limit=7');

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe(7);
  });

  test('defaults limit to 50 when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app())
      .get('/api/events/by-source?source=dynamics&sourceId=x');

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe(50);
  });

  test('clamps limit to sane bounds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/events/by-source?source=dynamics&sourceId=x&limit=99999');
    expect(mockQuery.mock.calls[0][1][2]).toBe(500);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/api/events/by-source?source=dynamics&sourceId=x&limit=0');
    expect(mockQuery.mock.calls[1][1][2]).toBe(50); // 0 is falsy -> fallback to default
  });

  test('truncates payload_preview past 500 chars and flags payload_truncated', async () => {
    // Build a string > 500 chars once JSON-serialized.
    const big = 'x'.repeat(800);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e', status: 'success', source_type: 'contact',
        target_id: null, error_message: null,
        reason_category: null, reason_criterion: null,
        payload: { blob: big },
        created_at: new Date(),
      }],
    });

    const res = await request(app())
      .get('/api/events/by-source?source=dynamics&sourceId=big');

    expect(res.status).toBe(200);
    const evt = res.body.events[0];
    expect(evt.payload_truncated).toBe(true);
    // 500 chars + 1 trailing ellipsis
    expect(evt.payload_preview.length).toBe(501);
    expect(evt.payload_preview.endsWith('…')).toBe(true);
  });

  test('handles payload stored as a JSON string (pg JSONB string path)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'e', status: 'success', source_type: 'contact',
        target_id: null, error_message: null,
        reason_category: null, reason_criterion: null,
        payload: '{"foo":"bar"}',
        created_at: new Date(),
      }],
    });

    const res = await request(app())
      .get('/api/events/by-source?source=dynamics&sourceId=s');

    expect(res.status).toBe(200);
    expect(res.body.events[0].payload_preview).toBe('{"foo":"bar"}');
    expect(res.body.events[0].payload_truncated).toBe(false);
  });

  test('rejects missing/invalid source', async () => {
    const res1 = await request(app()).get('/api/events/by-source?sourceId=x');
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/source/i);

    const res2 = await request(app()).get('/api/events/by-source?source=salesforce&sourceId=x');
    expect(res2.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects missing sourceId', async () => {
    const res = await request(app()).get('/api/events/by-source?source=dynamics');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sourceId/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('returns 500 with error message on pg failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg exploded'));
    const res = await request(app()).get('/api/events/by-source?source=dynamics&sourceId=x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'pg exploded' });
  });

  test('empty result returns total:0 and events:[]', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get('/api/events/by-source?source=dynamics&sourceId=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.events).toEqual([]);
  });
});
