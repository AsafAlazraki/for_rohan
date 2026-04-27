'use strict';

const { bus, emitSync } = require('../../src/events/bus');

describe('events/bus', () => {
  afterEach(() => bus.removeAllListeners('sync'));

  test('emits a sync event with field diff for dynamics→marketo', (done) => {
    bus.once('sync', (evt) => {
      expect(evt.source).toBe('dynamics');
      expect(evt.target).toBe('marketo');
      expect(evt.status).toBe('success');
      expect(evt.sourceFields).toMatchObject({
        emailaddress1: 'alice@example.com',
        firstname: 'Alice',
      });
      expect(evt.targetFields).toMatchObject({
        email: 'alice@example.com',
        firstName: 'Alice',
      });
      expect(evt.ts).toEqual(expect.any(String));
      done();
    });

    emitSync({
      id: 'job-1',
      source: 'dynamics',
      target: 'marketo',
      status: 'success',
      payload: { emailaddress1: 'alice@example.com', firstname: 'Alice', lastname: 'A' },
      email: 'alice@example.com',
    });
  });

  test('passes reason through on skipped events', (done) => {
    bus.once('sync', (evt) => {
      expect(evt.status).toBe('skipped');
      expect(evt.reason).toMatch(/loop/i);
      done();
    });
    emitSync({
      id: 'job-2',
      source: 'marketo',
      target: 'dynamics',
      status: 'skipped',
      payload: { email: 'x@y.com', syncSource: 'dynamics' },
      reason: 'Loop guard: skipped',
    });
  });

  test('passes error through on failed events', (done) => {
    bus.once('sync', (evt) => {
      expect(evt.status).toBe('failed');
      expect(evt.error).toBe('Timeout');
      done();
    });
    emitSync({
      id: 'job-3',
      source: 'dynamics',
      target: 'marketo',
      status: 'failed',
      payload: { emailaddress1: 'z@z.com' },
      error: 'Timeout',
    });
  });
});
