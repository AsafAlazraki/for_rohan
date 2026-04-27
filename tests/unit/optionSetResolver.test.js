'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { resolveOption, resolveLabel, _resetCache } =
  require('../../src/engine/optionSetResolver');

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

function metadataResponse() {
  return {
    data: {
      OptionSet: {
        Options: [
          {
            Value: 100000000,
            Label: { UserLocalizedLabel: { Label: 'Reseller' } },
          },
          {
            Value: 100000001,
            Label: { UserLocalizedLabel: { Label: 'Distributor' } },
          },
          {
            Value: 100000002,
            Label: { LocalizedLabels: [{ Label: 'End User' }] },
          },
        ],
      },
    },
  };
}

describe('resolveOption', () => {
  it('returns the integer value for a known label', async () => {
    axios.get.mockResolvedValueOnce(metadataResponse());

    const v = await resolveOption('account', 'ubt_accounttype', 'Reseller', 'tok');

    expect(v).toBe(100000000);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const url = axios.get.mock.calls[0][0];
    expect(url).toContain("EntityDefinitions(LogicalName='account')");
    expect(url).toContain("Attributes(LogicalName='ubt_accounttype')");
    expect(url).toContain('PicklistAttributeMetadata');
  });

  it('falls back to LocalizedLabels[0] when UserLocalizedLabel is absent', async () => {
    axios.get.mockResolvedValueOnce(metadataResponse());
    const v = await resolveOption('account', 'ubt_accounttype', 'End User', 'tok');
    expect(v).toBe(100000002);
  });

  it('returns null for an unknown label', async () => {
    axios.get.mockResolvedValueOnce(metadataResponse());
    const v = await resolveOption('account', 'ubt_accounttype', 'Unknown', 'tok');
    expect(v).toBeNull();
  });

  it('returns null for null / empty label without fetching', async () => {
    expect(await resolveOption('account', 'ubt_accounttype', null, 'tok')).toBeNull();
    expect(await resolveOption('account', 'ubt_accounttype', '',   'tok')).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('passes numeric input through unchanged (already an option value)', async () => {
    const v = await resolveOption('account', 'ubt_accounttype', 100000000, 'tok');
    expect(v).toBe(100000000);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('caches the metadata fetch across calls (TTL-bound)', async () => {
    axios.get.mockResolvedValue(metadataResponse());

    await resolveOption('account', 'ubt_accounttype', 'Reseller',    'tok');
    await resolveOption('account', 'ubt_accounttype', 'Distributor', 'tok');
    await resolveOption('account', 'ubt_accounttype', 'End User',    'tok');

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('returns null (not throw) on metadata fetch failure', async () => {
    axios.get.mockRejectedValueOnce(new Error('timeout'));
    const v = await resolveOption('account', 'ubt_accounttype', 'Reseller', 'tok');
    expect(v).toBeNull();
  });
});

describe('resolveLabel (reverse lookup)', () => {
  it('returns the label for a known integer value', async () => {
    axios.get.mockResolvedValueOnce(metadataResponse());
    const l = await resolveLabel('lead', 'statuscode', 100000001, 'tok');
    expect(l).toBe('Distributor');
  });

  it('returns null for null value without fetching', async () => {
    expect(await resolveLabel('lead', 'statuscode', null, 'tok')).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
