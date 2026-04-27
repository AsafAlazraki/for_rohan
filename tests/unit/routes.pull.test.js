'use strict';

jest.mock('../../src/readers/dynamics', () => ({ readDynamics: jest.fn() }));
jest.mock('../../src/readers/marketo',  () => ({ readMarketo:  jest.fn() }));

const express = require('express');
const request = require('supertest');
const { router } = require('../../src/routes/pull');
const { readDynamics } = require('../../src/readers/dynamics');
const { readMarketo }  = require('../../src/readers/marketo');

function makeApp() {
  const app = express();
  app.use('/api/pull', router);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/pull', () => {
  it('reads from Dynamics when side=dynamics', async () => {
    readDynamics.mockResolvedValueOnce({ rows: [{ contactid: 'c1' }], nextCursor: null });
    const res = await request(makeApp()).get('/api/pull?side=dynamics&entity=contact&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ contactid: 'c1' }]);
    expect(readDynamics).toHaveBeenCalledWith({ entity: 'contact', limit: 5, cursor: undefined });
  });

  it('reads from Marketo when side=marketo with cursor', async () => {
    readMarketo.mockResolvedValueOnce({ rows: [], nextCursor: 'tok-2' });
    const res = await request(makeApp()).get('/api/pull?side=marketo&entity=lead&cursor=tok-1&limit=20');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe('tok-2');
    expect(readMarketo).toHaveBeenCalledWith({ entity: 'lead', limit: 20, cursor: 'tok-1' });
  });

  it('400 when side is missing or invalid', async () => {
    const res1 = await request(makeApp()).get('/api/pull');
    expect(res1.status).toBe(400);
    const res2 = await request(makeApp()).get('/api/pull?side=invalid');
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/side/);
  });

  it('500 when reader throws', async () => {
    readDynamics.mockRejectedValueOnce(new Error('upstream-fail'));
    const res = await request(makeApp()).get('/api/pull?side=dynamics');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('upstream-fail');
  });

  it('uses default entity=contact and limit=10 when omitted', async () => {
    readDynamics.mockResolvedValueOnce({ rows: [], nextCursor: null });
    await request(makeApp()).get('/api/pull?side=dynamics');
    expect(readDynamics).toHaveBeenCalledWith({ entity: 'contact', limit: 10, cursor: undefined });
  });
});
