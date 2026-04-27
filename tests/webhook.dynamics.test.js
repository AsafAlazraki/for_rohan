const request = require('supertest');
const express = require('express');
jest.mock('../src/queue/producer', () => ({ enqueue: jest.fn() }));
const { enqueue } = require('../src/queue/producer');
jest.mock('../src/listeners/validate', () => ({
  validateDynamicsSignature: jest.fn(),
}));
const { validateDynamicsSignature } = require('../src/listeners/validate');
const serverModule = require('../src/listeners/server');

// Mock logger to avoid noisy output
jest.mock('../src/audit/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

describe('/webhook/dynamics', () => {
  let app;
  beforeEach(() => {
    app = serverModule.createApp();
    enqueue.mockClear();
  });

  const secret = 'testsecret';
  process.env.DYNAMICS_WEBHOOK_SECRET = secret;

  it('accepts direct raw webhook with valid signature', async () => {
    const payload = { foo: 'bar' };
    const payloadStr = JSON.stringify(payload);
    const sig = 'sha256=' + require('crypto').createHmac('sha256', secret).update(Buffer.from(payloadStr, 'utf8')).digest('hex');
    validateDynamicsSignature.mockReturnValue(true);

    const res = await request(app)
      .post('/webhook/dynamics')
      .set('x-dynamics-signature', sig)
      .send(payloadStr);
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: 'dynamics', payload }));
  });

  it('accepts Dapr envelope with valid signature', async () => {
    const payload = { foo: 'bar' };
    const payloadStr = JSON.stringify(payload);
    const sig = 'sha256=' + require('crypto').createHmac('sha256', secret).update(Buffer.from(payloadStr, 'utf8')).digest('hex');
    validateDynamicsSignature.mockReturnValue(true);
    const envelope = {
      id: 'id1',
      data: payload,
      topic: 'dynamics-contacts',
      metadata: { 'x-dynamics-signature': sig }
    };
    const res = await request(app)
      .post('/webhook/dynamics')
      .send(JSON.stringify(envelope));
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: 'dynamics', payload, meta: expect.objectContaining({ dapr: true }) }));
  });

  it('rejects missing signature when ALLOW_UNVERIFIED_DAPR=false', async () => {
    process.env.ALLOW_UNVERIFIED_DAPR = 'false';
    validateDynamicsSignature.mockReturnValue(false);
    const envelope = { id: 'id2', data: { foo: 'bar' }, topic: 'dynamics-contacts', metadata: {} };
    const res = await request(app)
      .post('/webhook/dynamics')
      .send(JSON.stringify(envelope));
    expect(res.status).toBe(401);
  });

  it('accepts missing signature when ALLOW_UNVERIFIED_DAPR=true', async () => {
    process.env.ALLOW_UNVERIFIED_DAPR = 'true';
    const envelope = { id: 'id3', data: { foo: 'bar' }, topic: 'dynamics-contacts', metadata: {} };
    const res = await request(app)
      .post('/webhook/dynamics')
      .send(JSON.stringify(envelope));
    expect(res.status).toBe(200);
  });
});
