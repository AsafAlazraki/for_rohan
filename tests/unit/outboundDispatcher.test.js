'use strict';

const mockQuery = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));
jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const crypto = require('crypto');

const {
  dispatchEvent,
  _internals,
} = require('../../src/webhooks/outboundDispatcher');
const { _setPool } = require('../../src/audit/db');

// Use real timers but patch global setTimeout to fire immediately so retry
// tests don't actually wait 250/500ms.
const _origSetTimeout = global.setTimeout;
beforeAll(() => {
  global.setTimeout = (fn) => _origSetTimeout(fn, 0);
});
afterAll(() => {
  global.setTimeout = _origSetTimeout;
});

function makeSink(partial = {}) {
  return {
    id:              partial.id || 'sink-1',
    name:            partial.name || 'Test sink',
    url:             partial.url  || 'https://example.test/webhook',
    secret:          partial.secret || 'super-secret',
    filter_status:   partial.filter_status   === undefined ? null : partial.filter_status,
    filter_category: partial.filter_category === undefined ? null : partial.filter_category,
    filter_sources:  partial.filter_sources  === undefined ? null : partial.filter_sources,
    enabled:         partial.enabled === undefined ? true : partial.enabled,
    created_at:      new Date('2026-04-01T00:00:00Z'),
    last_delivery:   null,
    last_status:     null,
  };
}

function makeEvent(partial = {}) {
  return {
    id:               partial.id               || 'evt-1',
    source_system:    partial.source_system    || 'dynamics',
    source_id:        partial.source_id        || 'contact-guid-1',
    source_type:      partial.source_type      || 'contact',
    target_system:    partial.target_system    || 'marketo',
    target_id:        partial.target_id        || null,
    status:           partial.status           || 'success',
    reason_category:  partial.reason_category  || null,
    reason_criterion: partial.reason_criterion || null,
    error_message:    partial.error_message    || null,
    payload:          partial.payload          || { firstname: 'Jane' },
    created_at:       partial.created_at       || new Date('2026-04-19T10:00:00Z'),
  };
}

// dispatchEvent is already awaited — no separate flush needed. This helper
// is retained for readability at call sites.
async function flushAll() {
  // Let any trailing microtasks settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  _setPool({ query: mockQuery });
});

describe('outboundDispatcher.dispatchEvent', () => {
  test('(a) sink with matching filters gets POSTed', async () => {
    const sink = makeSink({
      filter_status:  ['success'],
      filter_sources: ['dynamics'],
    });
    mockQuery.mockImplementation((sql) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post.mockResolvedValue({ status: 200 });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [postedUrl, postedBody, opts] = axios.post.mock.calls[0];
    expect(postedUrl).toBe(sink.url);
    expect(typeof postedBody).toBe('string');
    expect(opts.timeout).toBe(5000);
  });

  test('(b) sink with non-matching filters does not get POSTed', async () => {
    const sink = makeSink({ filter_status: ['failed'] }); // event is "success"
    mockQuery.mockImplementation((sql) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post.mockResolvedValue({ status: 200 });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('(c) HMAC x-playground-signature header is present and matches sha256', async () => {
    const sink = makeSink({ secret: 'top-secret-key' });
    mockQuery.mockImplementation((sql) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post.mockResolvedValue({ status: 200 });

    await dispatchEvent(makeEvent());
    await flushAll();

    const [, postedBody, opts] = axios.post.mock.calls[0];
    const header = opts.headers['x-playground-signature'];
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expected = crypto.createHmac('sha256', 'top-secret-key').update(postedBody).digest('hex');
    expect(header).toBe(`sha256=${expected}`);
  });

  test('(d) disabled sinks are skipped (listSinks({enabledOnly:true}) only returns enabled)', async () => {
    // The SQL uses "WHERE enabled = TRUE". We emulate by returning no rows.
    mockQuery.mockImplementation((sql) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) {
        expect(sql).toMatch(/WHERE enabled = TRUE/i);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('(e) POST failure (network error) writes a delivery row with error', async () => {
    const sink = makeSink();
    const deliveryInserts = [];
    mockQuery.mockImplementation((sql, params) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      if (/INSERT INTO outbound_webhook_deliveries/i.test(sql)) {
        deliveryInserts.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));

    await dispatchEvent(makeEvent());
    await flushAll();

    // 3 attempts were tried (network error => retryable), one final delivery row.
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(deliveryInserts).toHaveLength(1);
    const final = deliveryInserts[0];
    // [sinkId, eventId, url, status, responseMs, error, attempt]
    expect(final[3]).toBe(null);        // status
    expect(final[5]).toMatch(/ECONNREFUSED/); // error
    expect(final[6]).toBe(3);           // attempt
  });

  test('(f) retry on 500, success on 3rd attempt', async () => {
    const sink = makeSink();
    const deliveryInserts = [];
    mockQuery.mockImplementation((sql, params) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      if (/INSERT INTO outbound_webhook_deliveries/i.test(sql)) {
        deliveryInserts.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ status: 200 });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(deliveryInserts).toHaveLength(1);
    expect(deliveryInserts[0][3]).toBe(200);   // status
    expect(deliveryInserts[0][6]).toBe(3);     // attempt
  });

  test('(g) exhausted retries write final delivery row with last status', async () => {
    const sink = makeSink();
    const deliveryInserts = [];
    mockQuery.mockImplementation((sql, params) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      if (/INSERT INTO outbound_webhook_deliveries/i.test(sql)) {
        deliveryInserts.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ status: 503 });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(deliveryInserts).toHaveLength(1);
    expect(deliveryInserts[0][3]).toBe(503);   // last status
    expect(deliveryInserts[0][6]).toBe(3);     // attempt
    expect(deliveryInserts[0][5]).toMatch(/HTTP 503/);
  });

  test('does not retry on 4xx; writes delivery row immediately', async () => {
    const sink = makeSink();
    const deliveryInserts = [];
    mockQuery.mockImplementation((sql, params) => {
      if (/FROM outbound_webhook_sinks/i.test(sql) && /SELECT/i.test(sql)) return Promise.resolve({ rows: [sink] });
      if (/INSERT INTO outbound_webhook_deliveries/i.test(sql)) {
        deliveryInserts.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    axios.post.mockResolvedValue({ status: 401 });

    await dispatchEvent(makeEvent());
    await flushAll();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(deliveryInserts).toHaveLength(1);
    expect(deliveryInserts[0][3]).toBe(401);
    expect(deliveryInserts[0][6]).toBe(1);
  });

  test('never throws even when pg blows up during listSinks', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg down'));

    await expect(dispatchEvent(makeEvent())).resolves.toBeUndefined();
    await flushAll();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('empty filter arrays match all (status/category/source)', async () => {
    const s = _internals.sinkMatchesEvent;
    const sink = makeSink({ filter_status: [], filter_category: [], filter_sources: [] });
    expect(s(sink, makeEvent({ status: 'skipped', reason_category: 'authority', source_system: 'marketo' }))).toBe(true);
  });
});

describe('outboundDispatcher concurrency cap', () => {
  test('runWithLimit respects the concurrency cap', async () => {
    const { runWithLimit } = _internals;
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);

    await runWithLimit(items, 5, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield a few microtasks so concurrency can overlap.
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });
});
