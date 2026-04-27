'use strict';

const request = require('supertest');
const crypto  = require('crypto');

// ── Mock dependencies before requiring the module under test ──────────────────
jest.mock('../../src/listeners/validate', () => ({
  validateDynamicsSignature: jest.fn(),
  validateMarketoSignature:  jest.fn(),
}));

jest.mock('../../src/queue/producer', () => ({
  enqueue: jest.fn().mockResolvedValue('mock-job-id'),
}));

const { validateDynamicsSignature, validateMarketoSignature } =
  require('../../src/listeners/validate');
const { enqueue } = require('../../src/queue/producer');
const { createApp } = require('../../src/listeners/server');

// Flush the setImmediate queue so enqueue calls are observable synchronously
const flushImmediate = () => new Promise(resolve => setImmediate(resolve));

describe('Webhook server', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
  });

  // ── /webhook/dynamics ──────────────────────────────────────────────────────
  describe('POST /webhook/dynamics', () => {
    it('returns 200 when signature is valid', async () => {
      validateDynamicsSignature.mockReturnValue(true);
      const res = await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .set('x-dynamics-signature', 'valid-sig')
        .send(JSON.stringify({ id: '001', type: 'contact' }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'SUCCESS', jobId: 'mock-job-id' });
    });

    it('returns 401 when signature is invalid', async () => {
      validateDynamicsSignature.mockReturnValue(false);
      const res = await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: '001' }));

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/signature/i);
    });

    it('enqueues the payload with source=dynamics after responding', async () => {
      validateDynamicsSignature.mockReturnValue(true);
      const body = JSON.stringify({ id: '001', type: 'contact' });

      await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .set('x-dynamics-signature', 'valid-sig')
        .send(body);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const [queueName, jobData] = enqueue.mock.calls[0];
      expect(typeof queueName).toBe('string');
      expect(jobData.source).toBe('dynamics');
      expect(jobData.payload).toEqual({ id: '001', type: 'contact' });
      expect(typeof jobData.receivedAt).toBe('string');
    });

    it('does NOT enqueue when signature is invalid', async () => {
      validateDynamicsSignature.mockReturnValue(false);
      await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: '001' }));

      await flushImmediate();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns 500 when validate throws', async () => {
      validateDynamicsSignature.mockImplementation(() => {
        throw new Error('DYNAMICS_WEBHOOK_SECRET is not set');
      });
      const res = await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .set('x-dynamics-signature', 'any-sig')
        .send(JSON.stringify({ id: '001' }));

      expect(res.status).toBe(500);
    });
  });

  // ── /webhook/marketo ───────────────────────────────────────────────────────
  describe('POST /webhook/marketo', () => {
    it('returns 200 when signature is valid', async () => {
      validateMarketoSignature.mockReturnValue(true);
      const res = await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .set('x-marketo-signature', 'valid-sig')
        .send(JSON.stringify({ leadId: 42, email: 'alice@example.com' }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'SUCCESS', jobId: 'mock-job-id' });
    });

    it('returns 401 when signature is invalid', async () => {
      validateMarketoSignature.mockReturnValue(false);
      const res = await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ leadId: 42 }));

      expect(res.status).toBe(401);
    });

    it('enqueues the payload with source=marketo after responding', async () => {
      validateMarketoSignature.mockReturnValue(true);
      const body = JSON.stringify({ leadId: 42, email: 'alice@example.com' });

      await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .set('x-marketo-signature', 'valid-sig')
        .send(body);

      expect(enqueue).toHaveBeenCalledTimes(1);
      const [, jobData] = enqueue.mock.calls[0];
      expect(jobData.source).toBe('marketo');
      expect(jobData.payload).toEqual({ leadId: 42, email: 'alice@example.com' });
    });

    it('401 when no signature header', async () => {
      const res = await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: 1 }));
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing/);
    });

    it('500 when validate throws', async () => {
      validateMarketoSignature.mockImplementation(() => { throw new Error('boom'); });
      const res = await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .set('x-marketo-signature', 'sig')
        .send(JSON.stringify({ id: 1 }));
      expect(res.status).toBe(500);
    });

    it('500 when enqueue throws', async () => {
      validateMarketoSignature.mockReturnValue(true);
      enqueue.mockRejectedValueOnce(new Error('q-down'));
      const res = await request(app)
        .post('/webhook/marketo')
        .set('Content-Type', 'application/json')
        .set('x-marketo-signature', 'sig')
        .send(JSON.stringify({ leadId: 1 }));
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('q-down');
    });
  });

  describe('Health & discovery routes', () => {
    it('GET /health returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /ready returns ready:true', async () => {
      const res = await request(app).get('/ready');
      expect(res.body.ready).toBe(true);
    });

    it('GET /dapr/subscribe returns subscription list', async () => {
      const res = await request(app).get('/dapr/subscribe');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ route: '/webhook/dynamics' }),
        expect.objectContaining({ route: '/webhook/marketo' }),
      ]);
    });

    it('GET /api/fieldmap returns the fieldmap config', async () => {
      const res = await request(app).get('/api/fieldmap');
      expect(res.status).toBe(200);
      expect(res.body.crmToMarketo).toBeDefined();
    });
  });

  describe('Webhook envelope (Dapr) and unverified mode', () => {
    it('extracts data from Dapr envelope and enqueues', async () => {
      validateDynamicsSignature.mockReturnValue(true);
      const envelope = { data: { contactid: 'c1' }, metadata: {}, topic: 'dynamics-contacts' };
      await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .set('x-dynamics-signature', 'sig')
        .send(JSON.stringify(envelope));
      expect(enqueue).toHaveBeenCalledWith('sync-events', expect.objectContaining({
        source: 'dynamics',
        meta: expect.objectContaining({ dapr: true, daprTopic: 'dynamics-contacts' }),
      }));
    });

    it('skips signature when ALLOW_UNVERIFIED_DAPR=true', async () => {
      process.env.ALLOW_UNVERIFIED_DAPR = 'true';
      try {
        const newApp = createApp();
        const res = await request(newApp)
          .post('/webhook/dynamics')
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ id: 'x' }));
        expect(res.status).toBe(200);
        expect(validateDynamicsSignature).not.toHaveBeenCalled();
      } finally {
        delete process.env.ALLOW_UNVERIFIED_DAPR;
      }
    });

    it('500 when enqueue fails (dynamics)', async () => {
      validateDynamicsSignature.mockReturnValue(true);
      enqueue.mockRejectedValueOnce(new Error('q-down'));
      const res = await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .set('x-dynamics-signature', 'sig')
        .send(JSON.stringify({ id: '1' }));
      expect(res.status).toBe(500);
    });

    it('401 when signature missing on dynamics', async () => {
      const res = await request(app)
        .post('/webhook/dynamics')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ id: '1' }));
      expect(res.status).toBe(401);
    });
  });

  describe('CORS layer', () => {
    it('honours ALLOWED_ORIGINS for matching origin and short-circuits OPTIONS', async () => {
      process.env.ALLOWED_ORIGINS = 'https://a.example,https://b.example';
      try {
        const newApp = createApp();
        const r1 = await request(newApp).get('/health').set('Origin', 'https://a.example');
        expect(r1.headers['access-control-allow-origin']).toBe('https://a.example');

        const r2 = await request(newApp).options('/health').set('Origin', 'https://a.example');
        expect(r2.status).toBe(204);

        const r3 = await request(newApp).get('/health').set('Origin', 'https://other');
        expect(r3.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        delete process.env.ALLOWED_ORIGINS;
      }
    });
  });

  describe('SPA static fallback', () => {
    it('serves API routes normally even when SPA dir absent', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });
  });
});
