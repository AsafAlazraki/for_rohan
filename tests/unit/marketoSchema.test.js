'use strict';

/**
 * Unit-level proof of src/auth/marketoSchema.js — schema-status check
 * + custom-field creation helper. The most important assertion is that
 * Marketo error 603 ("Access denied") returned inside an HTTP-200 response
 * is correctly classified as `accessDenied: true` so the route can return
 * a useful manual-setup hint instead of three generic "603" lines.
 */

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../src/auth/marketo', () => ({
  getMarketoToken: jest.fn().mockResolvedValue('mkto-tok'),
}));

const axios = require('axios');
const {
  REQUIRED_LEAD_FIELDS,
  fetchLeadSchemaFields,
  getSchemaStatus,
  createCustomFields,
} = require('../../src/auth/marketoSchema');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MARKETO_BASE_URL = 'https://test.mktorest.com';
});
afterEach(() => {
  delete process.env.MARKETO_BASE_URL;
});

// ── REQUIRED_LEAD_FIELDS contract ──────────────────────────────────────────
it('REQUIRED_LEAD_FIELDS exposes the three Contact-vs-Lead signal fields', () => {
  expect(REQUIRED_LEAD_FIELDS.map(f => f.name)).toEqual([
    'crmEntityType',
    'crmContactId',
    'crmLeadId',
  ]);
  for (const f of REQUIRED_LEAD_FIELDS) {
    expect(f.dataType).toBe('string');
    expect(typeof f.displayName).toBe('string');
    expect(typeof f.description).toBe('string');
  }
});

// ── fetchLeadSchemaFields ──────────────────────────────────────────────────
it('fetchLeadSchemaFields returns a Set of REST-API names', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      success: true,
      result: [
        { rest: { name: 'email' } },
        { rest: { name: 'firstName' } },
        { rest: { name: 'crmEntityType' } },
      ],
    },
  });

  const set = await fetchLeadSchemaFields();
  expect(set).toBeInstanceOf(Set);
  expect([...set].sort()).toEqual(['crmEntityType', 'email', 'firstName']);
});

it('fetchLeadSchemaFields returns null on success:false', async () => {
  axios.get.mockResolvedValueOnce({ data: { success: false, errors: [{ code: '601' }] } });
  expect(await fetchLeadSchemaFields()).toBeNull();
});

it('fetchLeadSchemaFields returns null on HTTP error', async () => {
  axios.get.mockRejectedValueOnce(new Error('connection refused'));
  expect(await fetchLeadSchemaFields()).toBeNull();
});

// ── getSchemaStatus ────────────────────────────────────────────────────────
it('getSchemaStatus reports ready=true when all required fields are present', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      success: true,
      result: ['email','crmEntityType','crmContactId','crmLeadId']
        .map(name => ({ rest: { name } })),
    },
  });

  const s = await getSchemaStatus();
  expect(s.ready).toBe(true);
  expect(s.missing).toEqual([]);
  expect(s.present).toEqual(['crmEntityType', 'crmContactId', 'crmLeadId']);
  expect(s.schemaAccessible).toBe(true);
});

it('getSchemaStatus reports the exact missing field names', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      success: true,
      result: ['email', 'crmContactId'].map(name => ({ rest: { name } })),
    },
  });

  const s = await getSchemaStatus();
  expect(s.ready).toBe(false);
  expect(s.missing).toEqual(['crmEntityType', 'crmLeadId']);
  expect(s.present).toEqual(['crmContactId']);
});

it('getSchemaStatus reports schemaAccessible=false when the schema fetch fails', async () => {
  axios.get.mockRejectedValueOnce(new Error('boom'));
  const s = await getSchemaStatus();
  expect(s.ready).toBe(false);
  expect(s.schemaAccessible).toBe(false);
  expect(s.missing).toEqual(['crmEntityType', 'crmContactId', 'crmLeadId']);
});

// ── createCustomFields — access-denied detection ───────────────────────────
it('createCustomFields detects Marketo error 603 (Access denied) and bails after the first denial', async () => {
  // First call: success:false with code 603. Bail immediately.
  axios.post.mockResolvedValueOnce({
    data: { success: false, errors: [{ code: '603', message: 'Access denied' }] },
  });

  const result = await createCustomFields();
  expect(result.failed).toBe(3);
  expect(result.created).toBe(0);
  expect(result.alreadyExisted).toBe(0);

  // First field hit the API; remaining two were synthetically denied.
  const firstResult  = result.results[0];
  expect(firstResult.status).toBe('failed');
  expect(firstResult.accessDenied).toBe(true);
  expect(firstResult.httpStatus).toBe(403);

  for (const r of result.results.slice(1)) {
    expect(r.status).toBe('failed');
    expect(r.accessDenied).toBe(true);
    expect(r.error).toMatch(/603.*Access denied/);
  }

  // We only made ONE HTTP call (then bailed). Critical — without the bail
  // we'd fire the same denied request three times.
  expect(axios.post).toHaveBeenCalledTimes(1);
});

it('createCustomFields treats Marketo code 1009 (already exists) as success', async () => {
  for (let i = 0; i < 3; i++) {
    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        result: [{ status: 'skipped', reasons: [{ code: '1009', message: 'Field already exists' }] }],
      },
    });
  }

  const result = await createCustomFields();
  expect(result.alreadyExisted).toBe(3);
  expect(result.created).toBe(0);
  expect(result.failed).toBe(0);
  expect(result.results.every(r => r.status === 'already-exists')).toBe(true);
});

it('createCustomFields reports created when Marketo creates a new field', async () => {
  for (let i = 0; i < 3; i++) {
    axios.post.mockResolvedValueOnce({
      data: { success: true, result: [{ status: 'created' }] },
    });
  }

  const result = await createCustomFields();
  expect(result.created).toBe(3);
  expect(result.results.every(r => r.status === 'created')).toBe(true);
});

it('createCustomFields HTTP 401/403 is also marked accessDenied + bails', async () => {
  const e403 = Object.assign(new Error('forbidden'), {
    response: { status: 403, data: { errors: [{ code: '603' }] } },
  });
  axios.post.mockRejectedValueOnce(e403);

  const result = await createCustomFields();
  expect(result.failed).toBe(3);
  expect(result.results[0].httpStatus).toBe(403);
  expect(axios.post).toHaveBeenCalledTimes(1);
});

it('createCustomFields handles a mix of created + skipped across the three calls', async () => {
  axios.post
    .mockResolvedValueOnce({ data: { success: true, result: [{ status: 'created' }] } })
    .mockResolvedValueOnce({
      data: {
        success: true,
        result: [{ status: 'skipped', reasons: [{ code: '1009' }] }],
      },
    })
    .mockResolvedValueOnce({ data: { success: true, result: [{ status: 'created' }] } });

  const result = await createCustomFields();
  expect(result.created).toBe(2);
  expect(result.alreadyExisted).toBe(1);
  expect(result.failed).toBe(0);
});
