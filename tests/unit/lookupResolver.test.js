'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { resolveLookup, _resetCache } = require('../../src/engine/lookupResolver');

beforeEach(() => {
  jest.clearAllMocks();
  _resetCache();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

describe('resolveLookup', () => {
  it('fetches and caches the GUID for a natural-key value', async () => {
    axios.get.mockResolvedValue({ data: { value: [{ ubt_countryid: 'nz-guid' }] } });

    const id1 = await resolveLookup({
      entitySet: 'ubt_countries',
      value:     'New Zealand',
      token:     'tok',
    });
    const id2 = await resolveLookup({
      entitySet: 'ubt_countries',
      value:     'New Zealand',
      token:     'tok',
    });

    expect(id1).toBe('nz-guid');
    expect(id2).toBe('nz-guid');
    expect(axios.get).toHaveBeenCalledTimes(1);
    const params = axios.get.mock.calls[0][1].params;
    expect(params.$filter).toContain("ubt_name eq 'New Zealand'");
    expect(params.$select).toBe('ubt_countryid');
  });

  it('uses the businessunits defaults (idField+naturalKey)', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [{ businessunitid: 'bu-1' }] } });

    const id = await resolveLookup({
      entitySet: 'businessunits',
      value:     'New Zealand Sales',
      token:     'tok',
    });

    expect(id).toBe('bu-1');
    expect(axios.get.mock.calls[0][1].params.$filter).toContain("name eq 'New Zealand Sales'");
  });

  it('returns null on empty list', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    const id = await resolveLookup({
      entitySet: 'ubt_countries',
      value:     'Nowhere',
      token:     'tok',
    });
    expect(id).toBeNull();
  });

  it('returns null on blank input without querying', async () => {
    expect(await resolveLookup({ entitySet: 'ubt_countries', value: '', token: 't' })).toBeNull();
    expect(await resolveLookup({ entitySet: 'ubt_countries', value: null, token: 't' })).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('throws when entitySet lacks defaults and caller omits idField/naturalKey', async () => {
    await expect(resolveLookup({
      entitySet: 'unknown_entity_set',
      value:     'X',
      token:     'tok',
    })).rejects.toThrow('idField + naturalKey required');
  });

  it('escapes single-quotes in the value', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [{ systemuserid: 'u1' }] } });

    await resolveLookup({
      entitySet: 'systemusers',
      value:     "O'Reilly",
      token:     'tok',
    });

    expect(axios.get.mock.calls[0][1].params.$filter).toContain("fullname eq 'O''Reilly'");
  });

  it('returns null (not throw) on HTTP error', async () => {
    axios.get.mockRejectedValueOnce(new Error('network'));
    const id = await resolveLookup({
      entitySet: 'ubt_countries',
      value:     'Anywhere',
      token:     'tok',
    });
    expect(id).toBeNull();
  });
});
