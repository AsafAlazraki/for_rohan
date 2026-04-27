'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('../../src/listeners/server', () => ({
  createApp: jest.fn(),
  startListeners: jest.fn(),
}));
jest.mock('../../src/queue/worker', () => ({
  startWorkers: jest.fn().mockResolvedValue({ close: jest.fn() }),
}));
jest.mock('../../src/queue/dlq', () => ({
  attachDLQListener: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/queue/queue', () => ({
  stopBoss: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/monitor/alerts', () => ({
  startMonitor: jest.fn(),
  stopMonitor: jest.fn(),
}));
jest.mock('../../src/engagement/scheduler', () => ({
  startEngagementScheduler: jest.fn().mockResolvedValue({ started: true, queue: 'q' }),
}));
jest.mock('../../src/engagement/activityWriter', () => ({
  checkEngagementEntity: jest.fn().mockResolvedValue({ ok: true, logicalName: 'x' }),
}));
jest.mock('../../src/auth/dynamics', () => ({
  getDynamicsToken: jest.fn().mockResolvedValue('tok'),
}));
jest.mock('../../src/audit/db', () => ({
  getPool: jest.fn().mockReturnValue({ end: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const { validateEnv, main, REQUIRED_ENV, ADMIN_UI_ENV } = require('../../src/index');
const { createApp } = require('../../src/listeners/server');
const { startMonitor, stopMonitor } = require('../../src/monitor/alerts');
const { startEngagementScheduler } = require('../../src/engagement/scheduler');
const { getDynamicsToken } = require('../../src/auth/dynamics');
const { checkEngagementEntity } = require('../../src/engagement/activityWriter');

beforeEach(() => {
  jest.clearAllMocks();
});

const ENV_BACKUP = {};
function snapshotEnv() {
  for (const k of [...REQUIRED_ENV, ...ADMIN_UI_ENV]) ENV_BACKUP[k] = process.env[k];
}
function restoreEnv() {
  for (const k of [...REQUIRED_ENV, ...ADMIN_UI_ENV]) {
    if (ENV_BACKUP[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_BACKUP[k];
  }
}

describe('validateEnv', () => {
  beforeEach(() => snapshotEnv());
  afterEach(() => restoreEnv());

  it('warns about unset Admin UI vars but does not exit when DATABASE_URL set', () => {
    for (const k of REQUIRED_ENV) process.env[k] = 'set';
    for (const k of ADMIN_UI_ENV) delete process.env[k];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => validateEnv(false)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/runtime config var/));
    warn.mockRestore();
  });

  it('throws when DATABASE_URL is missing and exitOnMissing=false', () => {
    for (const k of REQUIRED_ENV) delete process.env[k];
    expect(() => validateEnv(false)).toThrow(/missing required environment variables/);
  });

  it('exits process when DATABASE_URL missing and exitOnMissing=true', () => {
    for (const k of REQUIRED_ENV) delete process.env[k];
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit-stub');
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnv(true)).toThrow('exit-stub');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    error.mockRestore();
  });

  it('returns silently when all required vars set + admin vars set', () => {
    for (const k of REQUIRED_ENV) process.env[k] = 'set';
    for (const k of ADMIN_UI_ENV) process.env[k] = 'set';
    expect(() => validateEnv(false)).not.toThrow();
  });
});

describe('main', () => {
  let mockServer;
  let mockApp;
  beforeEach(() => {
    mockServer = {
      on:    jest.fn(),
      close: jest.fn((cb) => cb && cb()),
    };
    mockApp = {
      listen: jest.fn((port, cb) => { setImmediate(() => cb && cb()); return mockServer; }),
    };
    createApp.mockReturnValue(mockApp);
  });

  it('boots HTTP, worker, scheduler, monitor', async () => {
    const { server, worker } = await main();
    expect(server).toBe(mockServer);
    expect(worker).toBeDefined();
    expect(startEngagementScheduler).toHaveBeenCalled();
    expect(startMonitor).toHaveBeenCalled();
  });

  it('logs error if engagement scheduler fails (does not crash boot)', async () => {
    startEngagementScheduler.mockRejectedValueOnce(new Error('sched-down'));
    const r = await main();
    expect(r).toBeDefined();
  });

  it('runs the engagement-entity boot probe asynchronously', async () => {
    await main();
    await new Promise(r => setImmediate(r));
    expect(checkEngagementEntity).toHaveBeenCalled();
  });

  it('logs info when boot probe token fetch fails', async () => {
    getDynamicsToken.mockRejectedValueOnce(new Error('no-token'));
    const logger = require('../../src/audit/logger');
    await main();
    await new Promise(r => setImmediate(r));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'no-token' }),
      expect.stringContaining('engagement-entity boot check'),
    );
  });

  it('shutdown handler closes server, stops worker, monitor, db pool', async () => {
    const removed = [];
    const origOnce = process.once.bind(process);
    const handlers = {};
    jest.spyOn(process, 'once').mockImplementation((sig, fn) => {
      handlers[sig] = fn;
      return process;
    });
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});

    await main();
    await handlers.SIGTERM();
    expect(stopMonitor).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);

    process.once = origOnce;
    exit.mockRestore();
  });

  it('shutdown handler logs errors when stopBoss/getPool().end() throw', async () => {
    const { stopBoss } = require('../../src/queue/queue');
    const { getPool } = require('../../src/audit/db');
    const logger = require('../../src/audit/logger');
    stopBoss.mockRejectedValueOnce(new Error('stop-fail'));
    const endMock = jest.fn().mockRejectedValueOnce(new Error('end-fail'));
    getPool.mockReturnValueOnce({ end: endMock });

    const handlers = {};
    jest.spyOn(process, 'once').mockImplementation((sig, fn) => { handlers[sig] = fn; return process; });
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});

    await main();
    await handlers.SIGINT();
    expect(logger.error).toHaveBeenCalled();

    exit.mockRestore();
  });
});
