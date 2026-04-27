'use strict';

jest.mock('axios', () => ({ patch: jest.fn() }));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const axios = require('axios');
const { stampMarketoIdOnContact } = require('../../src/writers/dynamics');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

describe('stampMarketoIdOnContact', () => {
  const GUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('PATCHes /contacts(id) with ubt_marketoid only', async () => {
    axios.patch.mockResolvedValueOnce({ status: 204 });

    await stampMarketoIdOnContact({
      contactId: GUID,
      marketoId: '42',
      token:     'tok',
    });

    expect(axios.patch).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = axios.patch.mock.calls[0];
    expect(url).toContain(`/contacts(${GUID})`);
    expect(body).toEqual({ ubt_marketoid: '42' });
    expect(cfg.headers.Authorization).toBe('Bearer tok');
  });

  it('coerces numeric marketoId to string', async () => {
    axios.patch.mockResolvedValueOnce({ status: 204 });
    await stampMarketoIdOnContact({ contactId: GUID, marketoId: 1234, token: 'tok' });
    expect(axios.patch.mock.calls[0][1]).toEqual({ ubt_marketoid: '1234' });
  });

  it('skips silently when marketoId is falsy', async () => {
    await stampMarketoIdOnContact({ contactId: GUID, marketoId: null, token: 'tok' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('throws on non-GUID contactId', async () => {
    await expect(stampMarketoIdOnContact({
      contactId: 'not-a-guid',
      marketoId: '1',
      token:     'tok',
    })).rejects.toThrow('contactId must be a GUID');
  });
});
