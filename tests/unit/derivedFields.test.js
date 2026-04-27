'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { resolveDerived, enrichDerived } = require('../../src/engine/derivedFields');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DYNAMICS_RESOURCE_URL = 'https://test.crm.dynamics.com';
  process.env.DYNAMICS_API_VERSION  = '9.2';
});

afterEach(() => {
  delete process.env.DYNAMICS_RESOURCE_URL;
  delete process.env.DYNAMICS_API_VERSION;
});

// ── parentAccountType ────────────────────────────────────────────────────────
describe('parentAccountType', () => {
  it('uses already-flattened parentcustomerid_account.ubt_accounttype', async () => {
    const record = {
      parentcustomerid_account: { ubt_accounttype: 'Reseller' },
    };

    const v = await resolveDerived({ derivation: 'parentAccountType', record, token: 'tok' });

    expect(v).toBe('Reseller');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('falls back to GET /accounts(id)?$select=ubt_accounttype', async () => {
    axios.get.mockResolvedValueOnce({ data: { ubt_accounttype: 'Distributor' } });

    const v = await resolveDerived({
      derivation: 'parentAccountType',
      record:     { _parentcustomerid_value: 'acc-guid' },
      token:      'tok',
    });

    expect(v).toBe('Distributor');
    expect(axios.get.mock.calls[0][0]).toContain('/accounts(acc-guid)');
    expect(axios.get.mock.calls[0][1].params.$select).toBe('ubt_accounttype');
  });

  it('returns null on 404', async () => {
    const err = new Error('nf'); err.response = { status: 404 };
    axios.get.mockRejectedValueOnce(err);

    const v = await resolveDerived({
      derivation: 'parentAccountType',
      record:     { _parentcustomerid_value: 'acc-stale' },
      token:      'tok',
    });

    expect(v).toBeNull();
  });

  it('returns null when no parentId AND no flattened value', async () => {
    const v = await resolveDerived({
      derivation: 'parentAccountType',
      record:     {},
      token:      'tok',
    });
    expect(v).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
});

// ── primaryContactFlag ───────────────────────────────────────────────────────
describe('primaryContactFlag', () => {
  it('returns true when contact IS the primary on its parent account', async () => {
    axios.get.mockResolvedValueOnce({ data: { _primarycontactid_value: 'contact-1' } });

    const v = await resolveDerived({
      derivation: 'primaryContactFlag',
      record:     { contactid: 'contact-1', _parentcustomerid_value: 'acc-1' },
      token:      'tok',
    });

    expect(v).toBe(true);
  });

  it('returns false when primary is someone else', async () => {
    axios.get.mockResolvedValueOnce({ data: { _primarycontactid_value: 'contact-2' } });

    const v = await resolveDerived({
      derivation: 'primaryContactFlag',
      record:     { contactid: 'contact-1', _parentcustomerid_value: 'acc-1' },
      token:      'tok',
    });

    expect(v).toBe(false);
  });

  it('returns false when no parentId', async () => {
    const v = await resolveDerived({
      derivation: 'primaryContactFlag',
      record:     { contactid: 'c1' },
      token:      'tok',
    });
    expect(v).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

// ── unknown derivation ───────────────────────────────────────────────────────
describe('resolveDerived — error handling', () => {
  it('throws on unknown derivation', async () => {
    await expect(resolveDerived({ derivation: 'nope', record: {}, token: 't' }))
      .rejects.toThrow('unknown derivation');
  });
});

// ── enrichDerived integration ────────────────────────────────────────────────
describe('enrichDerived — fieldMapper integration path', () => {
  it('layers derived entries onto a mapped Contact projection', async () => {
    // Contact has both `parentAccountType` and `primaryContactFlag` derived entries.
    // First call → parentAccountType (fetch account type); second → primaryContactFlag.
    axios.get.mockResolvedValueOnce({ data: { ubt_accounttype: 'Reseller' } });
    axios.get.mockResolvedValueOnce({ data: { _primarycontactid_value: 'contact-1' } });

    const mapped = { firstName: 'Jane' };
    const record = {
      contactid:                'contact-1',
      _parentcustomerid_value:  'acc-1',
    };

    const out = await enrichDerived(mapped, record, 'contact', 'tok');

    expect(out).toBe(mapped);           // mutates in place
    expect(out.contactAccountType).toBe('Reseller');
    expect(out).not.toHaveProperty('isPrimaryContact');
  });

  it('skips a failing resolver without crashing the enrichment', async () => {
    axios.get.mockRejectedValueOnce(new Error('boom'));
    axios.get.mockResolvedValueOnce({ data: { _primarycontactid_value: 'c1' } });

    const out = await enrichDerived(
      { firstName: 'J' },
      { contactid: 'c1', _parentcustomerid_value: 'a1' },
      'contact',
      'tok',
    );

    // parentAccountType failed → no key; primaryContactFlag mapping removed so not set
    expect(out).not.toHaveProperty('contactAccountType');
    expect(out).not.toHaveProperty('isPrimaryContact');
  });

  it('no-op on entities without derived entries (lead)', async () => {
    const mapped = { firstName: 'X' };
    await enrichDerived(mapped, {}, 'lead', 'tok');
    expect(axios.get).not.toHaveBeenCalled();
    expect(mapped).toEqual({ firstName: 'X' });
  });
});
