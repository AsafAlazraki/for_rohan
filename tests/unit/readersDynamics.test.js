'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../src/auth/dynamics', () => ({
  getDynamicsToken: jest.fn().mockResolvedValue('dyn-tok'),
}));

const axios = require('axios');
const {
  readDynamics,
  flattenContactCompany,
  flattenFormattedValues,
} = require('../../src/readers/dynamics');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

describe('readDynamics() — contact expands parent account', () => {
  it('issues an $expand for parentcustomerid_account on contact reads', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] }, status: 200 });

    await readDynamics({ entity: 'contact', limit: 5 });

    const params = axios.get.mock.calls[0][1].params;
    expect(params.$expand).toBe('parentcustomerid_account($select=name)');
    expect(params.$select).toContain('_parentcustomerid_value');
  });

  it('does NOT add $expand for lead or account entities', async () => {
    axios.get.mockResolvedValue({ data: { value: [] }, status: 200 });

    await readDynamics({ entity: 'lead', limit: 1 });
    expect(axios.get.mock.calls[0][1].params.$expand).toBeUndefined();

    await readDynamics({ entity: 'account', limit: 1 });
    expect(axios.get.mock.calls[1][1].params.$expand).toBeUndefined();
  });

  it('flattens parentcustomerid_account.name into a synthetic `company` field on contact rows', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        value: [
          {
            contactid: 'c1',
            emailaddress1: 'a@b.com',
            parentcustomerid_account: { name: 'Acme Corp', accountid: 'acc1' },
          },
        ],
      },
      status: 200,
    });

    const { rows } = await readDynamics({ entity: 'contact', limit: 1 });

    expect(rows[0]).toMatchObject({
      contactid: 'c1',
      emailaddress1: 'a@b.com',
      company: 'Acme Corp',
    });
    // Nested expand object removed to keep audit payloads flat
    expect(rows[0]).not.toHaveProperty('parentcustomerid_account');
  });

  it('leaves company unset when a contact has no parent account', async () => {
    axios.get.mockResolvedValueOnce({
      data: { value: [{ contactid: 'c2', emailaddress1: 'solo@x.com' }] },
      status: 200,
    });

    const { rows } = await readDynamics({ entity: 'contact', limit: 1 });
    expect(rows[0]).not.toHaveProperty('company');
  });
});

describe('Prefer header includes FormattedValue annotation', () => {
  it('asks Dataverse for human-readable picklist labels', async () => {
    axios.get.mockResolvedValueOnce({ data: { value: [] }, status: 200 });
    await readDynamics({ entity: 'lead', limit: 1 });
    const headers = axios.get.mock.calls[0][1].headers;
    expect(headers.Prefer).toContain('odata.include-annotations="OData.Community.Display.V1.FormattedValue"');
  });

  it('flattens leadsourcecode FormattedValue into leadsourcecode_label on read', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        value: [{
          leadid: 'l1',
          emailaddress1: 'a@b.com',
          leadsourcecode: 1,
          'leadsourcecode@OData.Community.Display.V1.FormattedValue': 'Web',
        }],
      },
      status: 200,
    });
    const { rows } = await readDynamics({ entity: 'lead', limit: 1 });
    expect(rows[0].leadsourcecode).toBe(1);                       // numeric kept
    expect(rows[0].leadsourcecode_label).toBe('Web');             // label synthesised
    expect(rows[0]['leadsourcecode@OData.Community.Display.V1.FormattedValue']).toBeUndefined();
  });
});

describe('flattenFormattedValues()', () => {
  it('synthesises *_label siblings for every annotated field', () => {
    const out = flattenFormattedValues({
      leadsourcecode: 2,
      'leadsourcecode@OData.Community.Display.V1.FormattedValue': 'Trade Show',
      revenue: 5000000,
      'revenue@OData.Community.Display.V1.FormattedValue': '$5,000,000.00',
      plain: 'unchanged',
    });
    expect(out).toEqual({
      leadsourcecode: 2,
      leadsourcecode_label: 'Trade Show',
      revenue: 5000000,
      revenue_label: '$5,000,000.00',
      plain: 'unchanged',
    });
  });

  it('passes through new picklist labels verbatim — no whitelist', () => {
    const out = flattenFormattedValues({
      leadsourcecode: 99,
      'leadsourcecode@OData.Community.Display.V1.FormattedValue': 'Brand-New Source',
    });
    expect(out.leadsourcecode_label).toBe('Brand-New Source');
  });

  it('is safe on null / non-object input', () => {
    expect(flattenFormattedValues(null)).toBeNull();
    expect(flattenFormattedValues(undefined)).toBeUndefined();
  });
});

describe('flattenContactCompany()', () => {
  it('is safe on null / non-object input', () => {
    expect(flattenContactCompany(null)).toBeNull();
    expect(flattenContactCompany(undefined)).toBeUndefined();
  });

  it('strips the expand object even when name is missing', () => {
    const out = flattenContactCompany({
      contactid: 'c',
      parentcustomerid_account: { accountid: 'a' },
    });
    expect(out).not.toHaveProperty('parentcustomerid_account');
    expect(out).not.toHaveProperty('company');
  });
});
