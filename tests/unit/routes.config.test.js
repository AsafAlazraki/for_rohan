'use strict';

jest.mock('../../src/config/loader', () => ({
  listConfig: jest.fn(),
  setConfig:  jest.fn(),
  maskSecret: (v) => '••••' + (v || '').slice(-4),
}));

const express = require('express');
const request = require('supertest');
const { listConfig, setConfig } = require('../../src/config/loader');
const { router, KNOWN_KEYS } = require('../../src/routes/config');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', router);
  return app;
}

const ENV_KEYS_TO_CLEAN = KNOWN_KEYS.map(k => k.key);

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS_TO_CLEAN) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_CLEAN) delete process.env[k];
});

describe('GET /api/config', () => {
  it('returns merged schema with DB values when env not set', async () => {
    listConfig.mockResolvedValueOnce([
      { key: 'DYNAMICS_RESOURCE_URL', value: 'https://crm', is_secret: false, updated_at: '2026-01-01' },
    ]);

    const res = await request(makeApp()).get('/api/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const url = res.body.find(r => r.key === 'DYNAMICS_RESOURCE_URL');
    expect(url).toMatchObject({ value: 'https://crm', set: true, source: 'db' });

    const tenant = res.body.find(r => r.key === 'DYNAMICS_TENANT_ID');
    expect(tenant).toMatchObject({ set: false, source: null, value: '' });
  });

  it('prefers env values over DB values', async () => {
    listConfig.mockResolvedValueOnce([
      { key: 'DYNAMICS_RESOURCE_URL', value: 'db-url', is_secret: false, updated_at: '2026-01-01' },
    ]);
    process.env.DYNAMICS_RESOURCE_URL = 'env-url';

    const res = await request(makeApp()).get('/api/config');
    expect(res.status).toBe(200);
    const url = res.body.find(r => r.key === 'DYNAMICS_RESOURCE_URL');
    expect(url).toMatchObject({ value: 'env-url', set: true, source: 'env' });
  });

  it('masks secret env values', async () => {
    listConfig.mockResolvedValueOnce([]);
    process.env.DYNAMICS_CLIENT_SECRET = 'super-secret-1234';

    const res = await request(makeApp()).get('/api/config');
    const r = res.body.find(r => r.key === 'DYNAMICS_CLIENT_SECRET');
    expect(r.value).toBe('••••1234');
  });

  it('returns 500 when listConfig throws', async () => {
    listConfig.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp()).get('/api/config');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db down');
  });
});

describe('POST /api/config', () => {
  it('upserts a known key', async () => {
    setConfig.mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/config')
      .send({ key: 'DYNAMICS_RESOURCE_URL', value: 'https://x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(setConfig).toHaveBeenCalledWith('DYNAMICS_RESOURCE_URL', 'https://x', false);
  });

  it('400 when key missing', async () => {
    const res = await request(makeApp()).post('/api/config').send({ value: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/);
  });

  it('400 when value not a string', async () => {
    const res = await request(makeApp())
      .post('/api/config')
      .send({ key: 'DYNAMICS_RESOURCE_URL', value: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value/);
  });

  it('400 on unknown key', async () => {
    const res = await request(makeApp())
      .post('/api/config')
      .send({ key: 'UNKNOWN', value: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown/);
  });

  it('500 when setConfig throws', async () => {
    setConfig.mockRejectedValueOnce(new Error('write fail'));
    const res = await request(makeApp())
      .post('/api/config')
      .send({ key: 'DYNAMICS_RESOURCE_URL', value: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('write fail');
  });

  it('400 when body missing entirely', async () => {
    const res = await request(makeApp()).post('/api/config').send();
    expect(res.status).toBe(400);
  });
});
