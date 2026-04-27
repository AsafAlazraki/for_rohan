'use strict';

const mockBoss = {
  work:     jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../src/queue/queue', () => ({
  getBoss:   () => mockBoss,
  startBoss: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(),
}));

jest.mock('../../src/engagement/runner', () => ({
  runOnce: jest.fn(),
}));

jest.mock('../../src/audit/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

const { getConfig } = require('../../src/config/loader');
const runner = require('../../src/engagement/runner');
const logger = require('../../src/audit/logger');
const {
  startEngagementScheduler,
  QUEUE_NAME,
  _reset,
  _isEnabled,
  _intervalMinutes,
} = require('../../src/engagement/scheduler');
const { startBoss } = require('../../src/queue/queue');

beforeEach(() => {
  jest.clearAllMocks();
  _reset();
});

describe('_isEnabled', () => {
  it('defaults to true on null/undefined/empty', () => {
    expect(_isEnabled(null)).toBe(true);
    expect(_isEnabled(undefined)).toBe(true);
    expect(_isEnabled('')).toBe(true);
  });

  it('returns false only on string "false" (case-insensitive)', () => {
    expect(_isEnabled('false')).toBe(false);
    expect(_isEnabled('FALSE')).toBe(false);
    expect(_isEnabled('true')).toBe(true);
    expect(_isEnabled('yes')).toBe(true);
  });
});

describe('_intervalMinutes', () => {
  it('returns 15 on invalid / missing', () => {
    expect(_intervalMinutes(undefined)).toBe(15);
    expect(_intervalMinutes('abc')).toBe(15);
    expect(_intervalMinutes('0')).toBe(15);
    expect(_intervalMinutes('-3')).toBe(15);
  });

  it('parses positive integers', () => {
    expect(_intervalMinutes('30')).toBe(30);
    expect(_intervalMinutes(5)).toBe(5);
  });
});

describe('startEngagementScheduler', () => {
  it('returns started:false when MARKETO_INGEST_ENABLED=false', async () => {
    getConfig.mockResolvedValueOnce('false');
    const r = await startEngagementScheduler();
    expect(r).toEqual({ started: false, cron: null, queue: QUEUE_NAME });
    expect(mockBoss.work).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('subscribes the worker, schedules cron, returns started:true', async () => {
    getConfig
      .mockResolvedValueOnce(null)   // MARKETO_INGEST_ENABLED → default ON
      .mockResolvedValueOnce('5');   // interval

    const r = await startEngagementScheduler();

    expect(r).toEqual({ started: true, cron: '*/5 * * * *', queue: QUEUE_NAME });
    expect(startBoss).toHaveBeenCalled();
    expect(mockBoss.work).toHaveBeenCalledTimes(1);
    expect(mockBoss.work.mock.calls[0][0]).toBe(QUEUE_NAME);
    expect(mockBoss.schedule).toHaveBeenCalledWith(QUEUE_NAME, '*/5 * * * *');
  });

  it('does not re-subscribe the worker on a second call', async () => {
    getConfig.mockResolvedValue(null);
    await startEngagementScheduler();
    await startEngagementScheduler();
    expect(mockBoss.work).toHaveBeenCalledTimes(1);
    // schedule is called every time (idempotent in pg-boss)
    expect(mockBoss.schedule).toHaveBeenCalledTimes(2);
  });

  it('runs the worker callback which delegates to runner.runOnce', async () => {
    getConfig.mockResolvedValue(null);
    runner.runOnce.mockResolvedValue({ ok: true, processed: 5 });

    await startEngagementScheduler();
    const handler = mockBoss.work.mock.calls[0][2];
    const out = await handler();

    expect(runner.runOnce).toHaveBeenCalled();
    expect(out).toEqual({ ok: true, processed: 5 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, processed: 5, cycleMs: expect.any(Number) }),
      expect.any(String),
    );
  });

  it('logs and rethrows when runner.runOnce throws', async () => {
    getConfig.mockResolvedValue(null);
    runner.runOnce.mockRejectedValue(new Error('boom'));

    await startEngagementScheduler();
    const handler = mockBoss.work.mock.calls[0][2];

    await expect(handler()).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs and rethrows when boss.schedule fails', async () => {
    getConfig.mockResolvedValue(null);
    mockBoss.schedule.mockRejectedValueOnce(new Error('cron-fail'));

    await expect(startEngagementScheduler()).rejects.toThrow('cron-fail');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'cron-fail' }),
      expect.stringContaining('schedule()'),
    );
  });
});
