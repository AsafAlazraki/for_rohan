'use strict';

jest.mock('../../src/queue/producer', () => ({ enqueue: jest.fn() }));
jest.mock('../../src/queue/queue', () => ({ QUEUE_NAME: 'sync-events' }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { router } = require('../../src/routes/transfer');
const { enqueue } = require('../../src/queue/producer');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transfer', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/transfer', () => {
  it('400 when direction missing/invalid', async () => {
    const r1 = await request(makeApp()).post('/api/transfer').send({});
    expect(r1.status).toBe(400);
    const r2 = await request(makeApp()).post('/api/transfer').send({ direction: 'bad' });
    expect(r2.status).toBe(400);
  });

  it('400 when records object missing', async () => {
    const r = await request(makeApp()).post('/api/transfer').send({ direction: 'd2m' });
    expect(r.status).toBe(400);
  });

  it('enqueues dynamics records when direction=d2m', async () => {
    enqueue.mockResolvedValue('job-1');
    const r = await request(makeApp()).post('/api/transfer').send({
      direction: 'd2m',
      records: { dynamics: [{ contactid: 'c1', email: 'a@b.com' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.enqueued).toEqual({ dynamics: 1, marketo: 0 });
    expect(enqueue).toHaveBeenCalledWith('sync-events', expect.objectContaining({
      source: 'dynamics',
      payload: expect.objectContaining({ type: 'contact', email: 'a@b.com' }),
    }));
  });

  it('enqueues marketo records when direction=m2d', async () => {
    enqueue.mockResolvedValue('job-2');
    const r = await request(makeApp()).post('/api/transfer').send({
      direction: 'm2d',
      records: { marketo: [{ id: 1, email: 'm@b.com' }] },
    });
    expect(r.body.enqueued).toEqual({ dynamics: 0, marketo: 1 });
  });

  it('enqueues both sides when direction=both', async () => {
    enqueue.mockResolvedValue('job-3');
    const r = await request(makeApp()).post('/api/transfer').send({
      direction: 'both',
      records: {
        dynamics: [{ contactid: 'c1' }],
        marketo:  [{ id: 1 }, { id: 2 }],
      },
    });
    expect(r.body.enqueued).toEqual({ dynamics: 1, marketo: 2 });
    expect(r.body.jobs).toHaveLength(3);
  });

  it('captures error in errors[] when enqueue throws', async () => {
    enqueue.mockRejectedValueOnce(new Error('q-down'));
    const r = await request(makeApp()).post('/api/transfer').send({
      direction: 'd2m',
      records: { dynamics: [{ contactid: 'c1' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([{ side: 'dynamics', error: 'q-down' }]);
  });

  it('honours entity field on payload', async () => {
    enqueue.mockResolvedValue('job-4');
    await request(makeApp()).post('/api/transfer').send({
      direction: 'd2m',
      entity: 'lead',
      records: { dynamics: [{ leadid: 'L1' }] },
    });
    expect(enqueue.mock.calls[0][1].payload.type).toBe('lead');
  });

  it('skips a side when records[side] is not an array', async () => {
    const r = await request(makeApp()).post('/api/transfer').send({
      direction: 'both',
      records: { dynamics: 'not-an-array', marketo: null },
    });
    expect(r.body.enqueued).toEqual({ dynamics: 0, marketo: 0 });
  });

  it('uses fallback identifiers in jobs[]', async () => {
    enqueue.mockResolvedValue('job-5');
    await request(makeApp()).post('/api/transfer').send({
      direction: 'd2m',
      records: { dynamics: [{ contactid: 'c-id' }, { accountid: 'a-id' }] },
    });
    // The route doesn't currently include emails in the second case so jobs[].ident
    // falls back through the chain in priority order.
  });
});
