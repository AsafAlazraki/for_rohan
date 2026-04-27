'use strict';

/**
 * Thin façade over queue.js.
 * Kept as a separate module so server.js (and its existing tests) continue
 * to import from this path without changes; jest.mock('../queue/producer')
 * in server tests still intercepts cleanly.
 */
const { enqueue: _enqueue } = require('./queue');

async function enqueue(queueName, data) {
  return _enqueue(queueName, data);
}

module.exports = { enqueue };
