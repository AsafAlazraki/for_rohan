'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../../src/monitor/metrics', () => ({
  getDLQDepth:  jest.fn(),
  getErrorRate: jest.fn(),
}));

const axios  = require('axios');
const { getDLQDepth, getErrorRate } = require('../../src/monitor/metrics');

// Import after mocks are in place; re-require in beforeEach to reset module state
let sendAlert, checkAndAlert, startMonitor, stopMonitor;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Reset module so _timer singleton resets between tests
  jest.resetModules();
  jest.mock('axios', () => ({ post: jest.fn() }));
  jest.mock('../../src/audit/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }));
  jest.mock('../../src/monitor/metrics', () => ({
    getDLQDepth:  jest.fn(),
    getErrorRate: jest.fn(),
  }));

  ({ sendAlert, checkAndAlert, startMonitor, stopMonitor } =
    require('../../src/monitor/alerts'));
});

afterEach(() => {
  stopMonitor();
  jest.useRealTimers();
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_DLQ_THRESHOLD;
  delete process.env.ALERT_ERROR_RATE_THRESHOLD;
  delete process.env.ALERT_HEARTBEAT_MS;
});

// ── sendAlert ─────────────────────────────────────────────────────────────────
describe('sendAlert()', () => {
  it('POSTs to ALERT_WEBHOOK_URL', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const ax = require('axios');
    ax.post.mockResolvedValueOnce({});

    await sendAlert('Test alert message');

    expect(ax.post).toHaveBeenCalledTimes(1);
    const [url, body] = ax.post.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/test');
    expect(body.text).toContain('Test alert message');
  });

  it('does not call axios when ALERT_WEBHOOK_URL is not set', async () => {
    const ax = require('axios');
    await sendAlert('Silenced alert');
    expect(ax.post).not.toHaveBeenCalled();
  });
});

// ── checkAndAlert ─────────────────────────────────────────────────────────────
describe('checkAndAlert()', () => {
  it('fires no alerts when all metrics are within thresholds', async () => {
    const { getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics');
    dlq.mockResolvedValue(5);
    er.mockResolvedValue({ errorRate: 0.02, failedCount: 2, totalCount: 100 });

    const result = await checkAndAlert();

    expect(result.alertsFired).toBe(0);
    const ax = require('axios');
    expect(ax.post).not.toHaveBeenCalled();
  });

  it('fires an alert when DLQ depth exceeds threshold', async () => {
    process.env.ALERT_WEBHOOK_URL        = 'https://hooks.slack.com/test';
    process.env.ALERT_DLQ_THRESHOLD      = '10';
    const { getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics');
    dlq.mockResolvedValue(15);
    er.mockResolvedValue({ errorRate: 0.0, failedCount: 0, totalCount: 100 });
    const ax = require('axios');
    ax.post.mockResolvedValue({});

    const result = await checkAndAlert();

    expect(result.alertsFired).toBe(1);
    expect(ax.post).toHaveBeenCalledTimes(1);
    expect(ax.post.mock.calls[0][1].text).toMatch(/DLQ depth 15/);
  });

  it('fires an alert when error rate exceeds threshold', async () => {
    process.env.ALERT_WEBHOOK_URL            = 'https://hooks.slack.com/test';
    process.env.ALERT_ERROR_RATE_THRESHOLD   = '0.05';
    const { getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics');
    dlq.mockResolvedValue(0);
    er.mockResolvedValue({ errorRate: 0.10, failedCount: 10, totalCount: 100 });
    const ax = require('axios');
    ax.post.mockResolvedValue({});

    const result = await checkAndAlert();

    expect(result.alertsFired).toBe(1);
    expect(ax.post.mock.calls[0][1].text).toMatch(/Error rate/i);
  });

  it('fires two alerts when both thresholds are breached', async () => {
    process.env.ALERT_WEBHOOK_URL            = 'https://hooks.slack.com/test';
    process.env.ALERT_DLQ_THRESHOLD          = '5';
    process.env.ALERT_ERROR_RATE_THRESHOLD   = '0.05';
    const { getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics');
    dlq.mockResolvedValue(20);
    er.mockResolvedValue({ errorRate: 0.20, failedCount: 20, totalCount: 100 });
    const ax = require('axios');
    ax.post.mockResolvedValue({});

    const result = await checkAndAlert();

    expect(result.alertsFired).toBe(2);
    expect(ax.post).toHaveBeenCalledTimes(2);
  });

  it('returns dlqDepth and errorRate in the result', async () => {
    const { getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics');
    dlq.mockResolvedValue(3);
    er.mockResolvedValue({ errorRate: 0.01, failedCount: 1, totalCount: 100 });

    const result = await checkAndAlert();
    expect(result).toMatchObject({ dlqDepth: 3, errorRate: 0.01 });
  });
});

// ── startMonitor / stopMonitor ────────────────────────────────────────────────
// Uses a fresh module require with ALERT_HEARTBEAT_MS=50 so we can advance
// timers by a finite amount instead of runAllTimers (which loops forever on setInterval).
describe('startMonitor() / stopMonitor()', () => {
  let _start, _stop, dlq, er;

  beforeEach(() => {
    jest.resetModules();
    process.env.ALERT_HEARTBEAT_MS = '50';   // short heartbeat for timer tests
    jest.mock('axios', () => ({ post: jest.fn() }));
    jest.mock('../../src/audit/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    jest.mock('../../src/monitor/metrics', () => ({
      getDLQDepth:  jest.fn().mockResolvedValue(0),
      getErrorRate: jest.fn().mockResolvedValue({ errorRate: 0, failedCount: 0, totalCount: 0 }),
    }));
    ({ startMonitor: _start, stopMonitor: _stop } = require('../../src/monitor/alerts'));
    ({ getDLQDepth: dlq, getErrorRate: er } = require('../../src/monitor/metrics'));
  });

  afterEach(() => {
    _stop();
    delete process.env.ALERT_HEARTBEAT_MS;
  });

  it('calls checkAndAlert immediately on start', async () => {
    _start();
    // Drain the microtask queue so the fire-and-forget async chain resolves
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(dlq).toHaveBeenCalledTimes(1);
  });

  it('fires on the interval after the heartbeat elapses', async () => {
    _start();
    // Flush the immediate call
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const countAfterImmediate = dlq.mock.calls.length;

    // Advance past one 50 ms heartbeat — advanceTimersByTimeAsync is finite-safe
    await jest.advanceTimersByTimeAsync(80);

    expect(dlq.mock.calls.length).toBeGreaterThan(countAfterImmediate);
  });

  it('is idempotent — calling startMonitor twice returns the same timer', () => {
    const t1 = _start();
    const t2 = _start();
    expect(t1).toBe(t2);
  });

  it('stopMonitor() clears the interval so no further calls occur', async () => {
    _start();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const callsBefore = dlq.mock.calls.length;

    _stop();
    await jest.advanceTimersByTimeAsync(200); // would fire 4× if interval were still alive
    expect(dlq.mock.calls.length).toBe(callsBefore);
  });
});
