'use strict';

// Mock external boundaries — the route should orchestrate, not do the work.
jest.mock('../../src/engine/bundleSync', () => ({
  previewBundle:  jest.fn(),
  runBundle:      jest.fn(),
  VALID_ENTITIES: ['contact', 'lead'],
}));
jest.mock('../../src/auth/dynamics', () => ({ getDynamicsToken: jest.fn() }));
jest.mock('../../src/auth/marketo',  () => ({ getMarketoToken:  jest.fn() }));
jest.mock('../../src/queue/producer', () => ({ enqueue: jest.fn() }));
jest.mock('../../src/queue/queue', () => ({ QUEUE_NAME: 'sync-events' }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { router } = require('../../src/routes/transfer');
const { previewBundle, runBundle } = require('../../src/engine/bundleSync');
const { getDynamicsToken } = require('../../src/auth/dynamics');
const { getMarketoToken }  = require('../../src/auth/marketo');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/transfer', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getDynamicsToken.mockResolvedValue('dyn-tok');
  getMarketoToken.mockResolvedValue('mkt-tok');
});

describe('POST /api/transfer/with-company/preview — validation', () => {
  it('400 when entity missing', async () => {
    const r = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ sourceIds: ['c1'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/entity must be one of/);
    expect(previewBundle).not.toHaveBeenCalled();
  });

  it('400 when entity not contact|lead', async () => {
    const r = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'account', sourceIds: ['x'] });
    expect(r.status).toBe(400);
    expect(previewBundle).not.toHaveBeenCalled();
  });

  it('400 when sourceIds missing or empty', async () => {
    const r1 = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'contact' });
    expect(r1.status).toBe(400);
    const r2 = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'contact', sourceIds: [] });
    expect(r2.status).toBe(400);
  });

  it('400 when sourceIds exceeds MAX_BUNDLE_ROWS', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `c${i}`);
    const r = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'contact', sourceIds: tooMany });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Too many rows/);
  });
});

describe('POST /api/transfer/with-company/preview — happy path', () => {
  it('returns the previewBundle result verbatim', async () => {
    const fakePreview = {
      summary: { total: 2, withCompany: 1, personOnly: 1, willSkip: 0, errors: 0 },
      rows: [
        { sourceId: 'c1', plan: 'with-company', personBody: { email: 'a@b.com' }, accountBody: { company: 'Acme' } },
        { sourceId: 'c2', plan: 'person-only',  personBody: { email: 'b@b.com' } },
      ],
    };
    previewBundle.mockResolvedValueOnce(fakePreview);

    const r = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'contact', sourceIds: ['c1', 'c2'] });

    expect(r.status).toBe(200);
    expect(r.body).toEqual(fakePreview);
    expect(previewBundle).toHaveBeenCalledWith({
      entity:    'contact',
      sourceIds: ['c1', 'c2'],
      dynToken:  'dyn-tok',
      mktToken:  'mkt-tok',
    });
  });

  it('coerces sourceIds to strings before passing to the helper', async () => {
    previewBundle.mockResolvedValueOnce({ summary: { total: 1, withCompany: 0, personOnly: 1, willSkip: 0, errors: 0 }, rows: [] });
    await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'lead', sourceIds: [42, 'l-2'] });
    expect(previewBundle.mock.calls[0][0].sourceIds).toEqual(['42', 'l-2']);
  });

  it('500 when the helper throws', async () => {
    previewBundle.mockRejectedValueOnce(new Error('boom'));
    const r = await request(makeApp())
      .post('/api/transfer/with-company/preview')
      .send({ entity: 'contact', sourceIds: ['c1'] });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('boom');
  });
});

describe('POST /api/transfer/with-company — happy path', () => {
  it('returns the runBundle result verbatim', async () => {
    const fakeResult = {
      summary: { total: 2, personsSynced: 2, accountsSynced: 1, skipped: 0, failed: 0 },
      results: [
        { sourceId: 'c1', plan: 'with-company', personSynced: true, accountSynced: true },
        { sourceId: 'c2', plan: 'person-only',  personSynced: true, accountSynced: false },
      ],
      jobIdPrefix: 'bundle-x',
    };
    runBundle.mockResolvedValueOnce(fakeResult);

    const r = await request(makeApp())
      .post('/api/transfer/with-company')
      .send({ entity: 'contact', sourceIds: ['c1', 'c2'] });

    expect(r.status).toBe(200);
    expect(r.body).toEqual(fakeResult);
    expect(runBundle).toHaveBeenCalledWith({
      entity:    'contact',
      sourceIds: ['c1', 'c2'],
      dynToken:  'dyn-tok',
      mktToken:  'mkt-tok',
    });
  });

  it('500 on helper failure', async () => {
    runBundle.mockRejectedValueOnce(new Error('blew up'));
    const r = await request(makeApp())
      .post('/api/transfer/with-company')
      .send({ entity: 'contact', sourceIds: ['c1'] });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('blew up');
  });

  it('400 still validates the body before any token / helper call', async () => {
    const r = await request(makeApp())
      .post('/api/transfer/with-company')
      .send({});
    expect(r.status).toBe(400);
    expect(getDynamicsToken).not.toHaveBeenCalled();
    expect(getMarketoToken).not.toHaveBeenCalled();
    expect(runBundle).not.toHaveBeenCalled();
  });
});
