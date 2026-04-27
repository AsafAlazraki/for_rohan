'use strict';

// jest.mock is hoisted — applies to all requires below, including those inside
// dynamics.js and marketo.js at their module load time.
jest.mock('axios', () => ({
  post: jest.fn(),
  get:  jest.fn(),
}));

const axios = require('axios');
const { getDynamicsToken, _cache: dynamicsCache } = require('../../src/auth/dynamics');
const { getMarketoToken,  _cache: marketoCache  } = require('../../src/auth/marketo');

beforeEach(() => {
  jest.clearAllMocks();
  // Clear module-level caches so each test starts with no cached token
  dynamicsCache.clear();
  marketoCache.clear();

  process.env.DYNAMICS_TENANT_ID     = 'tenant-123';
  process.env.DYNAMICS_CLIENT_ID     = 'client-id';
  process.env.DYNAMICS_CLIENT_SECRET = 'client-secret';
  process.env.DYNAMICS_RESOURCE_URL  = 'https://test.crm.dynamics.com';

  process.env.MARKETO_BASE_URL      = 'https://test.mktorest.com';
  process.env.MARKETO_CLIENT_ID     = 'mkto-client';
  process.env.MARKETO_CLIENT_SECRET = 'mkto-secret';
});

afterEach(() => {
  delete process.env.DYNAMICS_TENANT_ID;
  delete process.env.DYNAMICS_CLIENT_ID;
  delete process.env.DYNAMICS_CLIENT_SECRET;
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.MARKETO_BASE_URL;
  delete process.env.MARKETO_CLIENT_ID;
  delete process.env.MARKETO_CLIENT_SECRET;
});

// ── getDynamicsToken ──────────────────────────────────────────────────────────
describe('getDynamicsToken()', () => {
  it('calls Azure AD token endpoint and returns access_token', async () => {
    axios.post.mockResolvedValueOnce({
      data: { access_token: 'dyn-token-abc', expires_in: 3600 },
    });

    const token = await getDynamicsToken();

    expect(token).toBe('dyn-token-abc');
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toMatch(/tenant-123.*oauth2.*token/);
  });

  it('returns the cached token on the second call without another HTTP request', async () => {
    axios.post.mockResolvedValueOnce({
      data: { access_token: 'dyn-token-abc', expires_in: 3600 },
    });

    await getDynamicsToken();
    const token = await getDynamicsToken();

    expect(token).toBe('dyn-token-abc');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the cache is cleared', async () => {
    axios.post
      .mockResolvedValueOnce({ data: { access_token: 'tok-v1', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { access_token: 'tok-v2', expires_in: 3600 } });

    await getDynamicsToken();
    dynamicsCache.clear();
    const token = await getDynamicsToken();

    expect(token).toBe('tok-v2');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error when DYNAMICS_TENANT_ID is missing', async () => {
    delete process.env.DYNAMICS_TENANT_ID;
    await expect(getDynamicsToken()).rejects.toThrow('DYNAMICS_TENANT_ID');
  });

  it('throws when the response contains no access_token', async () => {
    axios.post.mockResolvedValueOnce({ data: { error: 'invalid_client' } });
    await expect(getDynamicsToken()).rejects.toThrow('No access_token');
  });

  it('propagates axios network errors', async () => {
    axios.post.mockRejectedValueOnce(new Error('Network Error'));
    await expect(getDynamicsToken()).rejects.toThrow('Network Error');
  });
});

// ── getMarketoToken ───────────────────────────────────────────────────────────
describe('getMarketoToken()', () => {
  it('calls the Marketo identity endpoint and returns access_token', async () => {
    axios.get.mockResolvedValueOnce({
      data: { access_token: 'mkto-token-xyz', expires_in: 3600 },
    });

    const token = await getMarketoToken();

    expect(token).toBe('mkto-token-xyz');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain('/identity/oauth/token');
  });

  it('returns the cached token on the second call', async () => {
    axios.get.mockResolvedValueOnce({
      data: { access_token: 'mkto-token-xyz', expires_in: 3600 },
    });

    await getMarketoToken();
    const token = await getMarketoToken();

    expect(token).toBe('mkto-token-xyz');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('throws when the response contains an error field', async () => {
    axios.get.mockResolvedValueOnce({
      data: { error: 'invalid_client', error_description: 'Bad credentials' },
    });
    await expect(getMarketoToken()).rejects.toThrow('Bad credentials');
  });

  it('throws a descriptive error when MARKETO_BASE_URL is missing', async () => {
    delete process.env.MARKETO_BASE_URL;
    await expect(getMarketoToken()).rejects.toThrow('MARKETO_BASE_URL');
  });

  it('throws when the response contains no access_token', async () => {
    axios.get.mockResolvedValueOnce({ data: {} });
    await expect(getMarketoToken()).rejects.toThrow('No access_token');
  });

  it('propagates axios network errors', async () => {
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(getMarketoToken()).rejects.toThrow('connect ECONNREFUSED');
  });
});
