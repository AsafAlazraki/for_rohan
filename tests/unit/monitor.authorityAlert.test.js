'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(),
}));

const axios        = require('axios');
const logger       = require('../../src/audit/logger');
const { getConfig } = require('../../src/config/loader');
const { _setPool } = require('../../src/audit/db');
const {
  checkAuthoritySkipRate,
  _resetAuthorityAlertState,
} = require('../../src/monitor/authorityAlerts');

const WINDOW_MS = 5 * 60 * 1000; // 5 min
const THRESHOLD = 10;

// Helper — build a pool mock that yields a fixed count / first_event / last_event
function mockPool({ count, firstEvent = null, lastEvent = null }) {
  const query = jest.fn().mockResolvedValue({
    rows: [{
      count,
      first_event: firstEvent,
      last_event:  lastEvent,
    }],
  });
  _setPool({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAuthorityAlertState();
  // Default: webhook is configured for most tests.
  getConfig.mockImplementation(async (key) => {
    if (key === 'ALERT_WEBHOOK_URL') return 'https://hooks.example/test';
    return null;
  });
  axios.post.mockResolvedValue({});
});

afterEach(() => {
  _resetAuthorityAlertState();
});

describe('checkAuthoritySkipRate()', () => {
  it('(a) count <= threshold → no webhook call', async () => {
    mockPool({ count: THRESHOLD }); // exactly at threshold, not over

    const result = await checkAuthoritySkipRate({
      windowMs: WINDOW_MS,
      threshold: THRESHOLD,
      now: 1_000_000,
    });

    expect(result.alertFired).toBe(false);
    expect(result.count).toBe(THRESHOLD);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('(b) count > threshold → one webhook call with correct body', async () => {
    const first = new Date('2026-04-19T10:00:00Z');
    const last  = new Date('2026-04-19T10:04:00Z');
    mockPool({ count: 15, firstEvent: first, lastEvent: last });

    const result = await checkAuthoritySkipRate({
      windowMs: WINDOW_MS,
      threshold: THRESHOLD,
      now: 1_000_000,
    });

    expect(result.alertFired).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('https://hooks.example/test');
    expect(body).toEqual({
      kind:       'authority-skip-spike',
      count:      15,
      windowMs:   WINDOW_MS,
      threshold:  THRESHOLD,
      firstEvent: first.toISOString(),
      lastEvent:  last.toISOString(),
    });
  });

  it('(c) second check within same window → no duplicate webhook call (debounced)', async () => {
    mockPool({
      count:      20,
      firstEvent: new Date('2026-04-19T10:00:00Z'),
      lastEvent:  new Date('2026-04-19T10:04:00Z'),
    });

    const t0 = 1_000_000;
    const r1 = await checkAuthoritySkipRate({ windowMs: WINDOW_MS, threshold: THRESHOLD, now: t0 });
    expect(r1.alertFired).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Second check, still within the same window (t0 + 1 min < t0 + 5 min)
    const r2 = await checkAuthoritySkipRate({
      windowMs: WINDOW_MS,
      threshold: THRESHOLD,
      now: t0 + 60_000,
    });

    expect(r2.alertFired).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1); // still just the first call
  });

  it('(d) second check after _lastFiredAt + windowMs → new webhook call fires', async () => {
    mockPool({
      count:      20,
      firstEvent: new Date('2026-04-19T10:00:00Z'),
      lastEvent:  new Date('2026-04-19T10:04:00Z'),
    });

    const t0 = 1_000_000;
    await checkAuthoritySkipRate({ windowMs: WINDOW_MS, threshold: THRESHOLD, now: t0 });
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Advance past the debounce window.
    const r2 = await checkAuthoritySkipRate({
      windowMs: WINDOW_MS,
      threshold: THRESHOLD,
      now: t0 + WINDOW_MS + 1,
    });

    expect(r2.alertFired).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('(e) missing ALERT_WEBHOOK_URL → logs warn and skips webhook without throwing', async () => {
    // Override config to return null, and ensure env is unset.
    const oldEnv = process.env.ALERT_WEBHOOK_URL;
    delete process.env.ALERT_WEBHOOK_URL;
    getConfig.mockImplementation(async () => null);

    mockPool({ count: 50 });

    await expect(
      checkAuthoritySkipRate({ windowMs: WINDOW_MS, threshold: THRESHOLD, now: 1_000_000 }),
    ).resolves.toMatchObject({ alertFired: false, count: 50 });

    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('ALERT_WEBHOOK_URL not configured'),
    );

    if (oldEnv != null) process.env.ALERT_WEBHOOK_URL = oldEnv;
  });

  it('uses default window/threshold when args omitted', async () => {
    // Exactly at default threshold (10) should not fire; 11 should.
    mockPool({ count: 11, firstEvent: new Date(), lastEvent: new Date() });

    const result = await checkAuthoritySkipRate({ now: 1_000_000 });

    expect(result.windowMs).toBe(WINDOW_MS);
    expect(result.threshold).toBe(10);
    expect(result.alertFired).toBe(true);
  });
});
