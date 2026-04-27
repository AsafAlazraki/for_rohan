'use strict';

const path = require('path');
const fs = require('fs');

const tmp = path.join(__dirname, '..', '..', '_tmp_logger_prod');

describe('logger — non-test environment', () => {
  let prevNodeEnv, prevCwd;

  beforeAll(() => {
    prevNodeEnv = process.env.NODE_ENV;
    prevCwd     = process.cwd();
    delete process.env.NODE_ENV;
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);
    jest.resetModules();
  });

  afterAll(() => {
    process.chdir(prevCwd);
    process.env.NODE_ENV = prevNodeEnv;
    // Best-effort cleanup
    try {
      const logsDir = path.join(tmp, 'logs');
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          try { fs.unlinkSync(path.join(logsDir, f)); } catch { /* ignore */ }
        }
        fs.rmdirSync(logsDir);
      }
      fs.rmdirSync(tmp);
    } catch { /* ignore */ }
  });

  it('creates a logs directory and adds a File transport when NODE_ENV != test', () => {
    const logger = require('../../src/audit/logger');
    expect(fs.existsSync(path.join(tmp, 'logs'))).toBe(true);
    const fileTransports = logger.transports.filter(t => t.constructor.name === 'File');
    expect(fileTransports.length).toBe(1);
  });

  it('reuses existing logs directory without throwing', () => {
    // Already exists from the first test → exercises the "if exists" branch.
    expect(() => require('../../src/audit/logger')).not.toThrow();
  });
});
