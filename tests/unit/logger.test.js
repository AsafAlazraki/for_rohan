'use strict';

describe('logger', () => {
  let logger;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    // Load after env is set
    logger = require('../../src/audit/logger');
  });

  it('is a winston logger instance with standard methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('does not throw when logging an info message', () => {
    expect(() => logger.info('test message')).not.toThrow();
  });

  it('does not throw when logging an error with an Error object', () => {
    expect(() => logger.error(new Error('test error'))).not.toThrow();
  });

  it('does not throw when logging with metadata', () => {
    expect(() => logger.warn({ jobId: '123', reason: 'test' }, 'meta log')).not.toThrow();
  });

  it('respects LOG_LEVEL env var', () => {
    // Level is set at creation time so we just verify the property
    // (default in test is 'info')
    expect(logger.level).toBe(process.env.LOG_LEVEL || 'info');
  });

  it('does not create a file transport in test mode', () => {
    const fileTransports = logger.transports.filter(
      t => t.constructor.name === 'File',
    );
    expect(fileTransports).toHaveLength(0);
  });

  it('has exactly one console transport', () => {
    const consoleTransports = logger.transports.filter(
      t => t.constructor.name === 'Console',
    );
    expect(consoleTransports).toHaveLength(1);
  });
});
