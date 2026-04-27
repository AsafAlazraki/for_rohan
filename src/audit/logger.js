'use strict';

const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

const isTest = process.env.NODE_ENV === 'test';

const transports = [
  new winston.transports.Console({
    silent: isTest,
  }),
];

// Only add file transport outside of test runs to avoid creating artefacts
if (!isTest) {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'sync.log'),
      maxsize:  10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports,
});

module.exports = logger;
