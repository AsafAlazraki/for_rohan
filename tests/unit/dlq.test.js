'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockGetJobById   = jest.fn();
const mockPublish      = jest.fn().mockResolvedValue('new-job-id');
const mockOnComplete   = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/queue/queue', () => ({
  getBoss: jest.fn(() => ({
    getJobById:  mockGetJobById,
    publish:     mockPublish,
    onComplete:  mockOnComplete,
  })),
  startBoss:  jest.fn().mockResolvedValue(undefined),
  enqueue:    jest.fn().mockResolvedValue('new-job-id'),
  QUEUE_NAME: 'sync-events',
}));

jest.mock('../../src/audit/db', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

const { logEvent } = require('../../src/audit/db');
const { enqueue } = require('../../src/queue/queue');
const { captureFailed, replayDLQ, getDLQDepth, attachDLQListener } =
  require('../../src/queue/dlq');
const { getPool } = require('../../src/audit/db');

function makeJob(overrides = {}) {
  return {
    id: 'job-999',
    data: {
      source:  'dynamics',
      payload: { id: 'contact-1', email: 'x@y.com', type: 'contact' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  logEvent.mockResolvedValue({ id: 'audit-id' });
});

// ── captureFailed ─────────────────────────────────────────────────────────────
describe('captureFailed()', () => {
  it('calls logEvent with status=failed and error details', async () => {
    await captureFailed(makeJob(), new Error('Timeout'));
    expect(logEvent).toHaveBeenCalledTimes(1);
    const call = logEvent.mock.calls[0][0];
    expect(call.status).toBe('failed');
    expect(call.error_message).toBe('Timeout');
    expect(call.source_system).toBe('dynamics');
    expect(call.job_id).toBe('job-999');
  });

  it('does not rethrow if logEvent itself throws', async () => {
    logEvent.mockRejectedValueOnce(new Error('DB down'));
    await expect(captureFailed(makeJob(), new Error('oops'))).resolves.toBeUndefined();
  });

  it('handles job with missing data gracefully', async () => {
    const job = { id: 'j1', data: null };
    await expect(captureFailed(job, new Error('bad'))).resolves.toBeUndefined();
  });
});

// ── replayDLQ ─────────────────────────────────────────────────────────────────
describe('replayDLQ()', () => {
  it('finds the original job and re-sends it via enqueue', async () => {
    const original = makeJob();
    mockGetJobById.mockResolvedValueOnce(original);

    const res = await replayDLQ('job-999');

    expect(mockGetJobById).toHaveBeenCalledWith('job-999');
    expect(enqueue).toHaveBeenCalledWith('sync-events', original.data);
    expect(res).toEqual({ id: 'new-job-id' });
  });

  it('throws if the job is not found', async () => {
    mockGetJobById.mockResolvedValueOnce(null);
    await expect(replayDLQ('missing-id')).rejects.toThrow('Job not found');
  });
});

// ── attachDLQListener ─────────────────────────────────────────────────────────
describe('attachDLQListener()', () => {
  it('subscribes to pg-boss onComplete for the queue', async () => {
    await attachDLQListener();
    expect(mockOnComplete).toHaveBeenCalledWith('sync-events', expect.any(Function));
  });

  it('does not throw even if the subscription fails', async () => {
    mockOnComplete.mockRejectedValueOnce(new Error('unsupported'));
    await expect(attachDLQListener()).resolves.toBeUndefined();
  });

  it('captures only failed jobs, ignoring successful completions', async () => {
    await attachDLQListener();
    const handler = mockOnComplete.mock.calls[0][1];

    // A successful job — no logEvent call expected
    await handler({
      id: 'ok-1',
      data: { state: 'completed', request: { id: 'ok-1', data: makeJob().data } },
    });
    expect(logEvent).not.toHaveBeenCalled();

    // A failed job — logEvent should fire
    await handler({
      id: 'bad-1',
      data: {
        state:    'failed',
        request:  { id: 'bad-1', data: makeJob().data },
        response: { state: 'failed', message: 'boom' },
      },
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0].status).toBe('failed');
    expect(logEvent.mock.calls[0][0].error_message).toBe('boom');
  });
});
