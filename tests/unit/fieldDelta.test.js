'use strict';

jest.mock('../../src/audit/db', () => ({
  loadSnapshot: jest.fn(),
}));
jest.mock('../../src/config/loader', () => ({
  getConfig: jest.fn(async () => null),
}));

const { loadSnapshot } = require('../../src/audit/db');
const { getConfig }    = require('../../src/config/loader');
const { hasMappedChange, _mappedSourceFields } =
  require('../../src/engine/fieldDelta');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: flag off. Individual tests can override.
  getConfig.mockImplementation(async () => null);
});

describe('_mappedSourceFields', () => {
  it('lists every D365 attribute referenced by crmToMarketo.contact (excluding derived)', () => {
    const fields = _mappedSourceFields('contact');
    expect(fields).toEqual(expect.arrayContaining([
      'firstname', 'lastname', 'emailaddress1', 'jobtitle',
    ]));
    expect(fields).not.toContain('@derived');
  });

  it('returns [] for an unknown entity', () => {
    expect(_mappedSourceFields('opportunity')).toEqual([]);
  });
});

describe('hasMappedChange — inline PreImage (D365 webhook)', () => {
  it('returns changed=false when no mapped field differs', async () => {
    const pre  = { firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@a.com' };
    const post = { firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@a.com', description: 'edited' };

    const r = await hasMappedChange({ _pre: pre, _post: post }, 'contact');

    expect(r.changed).toBe(false);
    expect(r.baseline).toBe('preimage');
    // No DB call when PreImage is inline
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('returns changed=true when a mapped field differs', async () => {
    const pre  = { firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@a.com' };
    const post = { firstname: 'Janet', lastname: 'Doe', emailaddress1: 'j@a.com' };

    const r = await hasMappedChange({ _pre: pre, _post: post }, 'contact');

    expect(r.changed).toBe(true);
    expect(r.reason).toBe('field-changed:firstname');
    expect(r.baseline).toBe('preimage');
  });

  it('normalizes numeric / string differences across pre/post', async () => {
    const pre  = { leadscore: 10 };
    const post = { leadscore: '10' };

    const r = await hasMappedChange(
      { _pre: pre, _post: post, firstname: 'X', emailaddress1: 'y@z.com' },
      'lead',
    );

    // leadscore isn't in the lead mapping — so only firstname/email count.
    expect(r.changed).toBe(false);
  });
});

describe('hasMappedChange — snapshot fallback', () => {
  it('returns bootstrap + changed=true on first sighting (no snapshot)', async () => {
    loadSnapshot.mockResolvedValueOnce(null);

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Jane' },
      'contact',
    );

    expect(r.changed).toBe(true);
    expect(r.baseline).toBe('bootstrap');
    expect(r.reason).toBe('first-sighting');
    expect(loadSnapshot).toHaveBeenCalledWith({
      source_system: 'dynamics',
      source_id:     'c-guid',
    });
  });

  it('returns changed=false when snapshot has the same mapped fields', async () => {
    // Real-world snapshots are upserted from the source webhook payload, which
    // always includes the PK (contactid for contacts). The mock mirrors that.
    loadSnapshot.mockResolvedValueOnce({
      source_type: 'contact',
      payload:     { contactid: 'c-guid', firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@a.com' },
      updated_at:  new Date(),
    });

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@a.com' },
      'contact',
    );

    expect(r.changed).toBe(false);
    expect(r.baseline).toBe('snapshot');
  });

  it('returns changed=true when snapshot differs on a mapped field', async () => {
    loadSnapshot.mockResolvedValueOnce({
      source_type: 'contact',
      payload:     { firstname: 'Jane' },
      updated_at:  new Date(),
    });

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Janet' },
      'contact',
    );

    expect(r.changed).toBe(true);
    expect(r.baseline).toBe('snapshot');
    expect(r.reason).toBe('field-changed:firstname');
  });

  it('returns bootstrap when payload has no source_id (no contactid/leadid/accountid)', async () => {
    const r = await hasMappedChange({ firstname: 'Jane' }, 'contact');
    expect(r.changed).toBe(true);
    expect(r.baseline).toBe('bootstrap');
    expect(r.reason).toBe('no-source-id');
  });
});

describe('hasMappedChange — SYNC_TO_MARKETO_REQUIRED opt-in gate (ASSUMPTIONS §8)', () => {
  it('short-circuits with changed=false when flag is on and ubt_synctomarketo is not true', async () => {
    getConfig.mockImplementation(async (k) =>
      k === 'SYNC_TO_MARKETO_REQUIRED' ? 'true' : null,
    );

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Jane', ubt_synctomarketo: false },
      'contact',
    );

    expect(r.changed).toBe(false);
    expect(r.reason).toBe('sync-to-marketo-opt-in-required');
    expect(r.baseline).toBe('opt-in-gate');
    // No delta work performed — neither snapshot nor PreImage touched.
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('proceeds with normal delta when flag is on and ubt_synctomarketo === true', async () => {
    getConfig.mockImplementation(async (k) =>
      k === 'SYNC_TO_MARKETO_REQUIRED' ? '1' : null,
    );
    loadSnapshot.mockResolvedValueOnce(null);

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Jane', ubt_synctomarketo: true },
      'contact',
    );

    expect(r.changed).toBe(true);
    expect(r.baseline).toBe('bootstrap');
    expect(r.reason).toBe('first-sighting');
  });

  it('ignores the gate entirely when flag is off/unset (default behaviour)', async () => {
    // getConfig returns null by default via beforeEach.
    loadSnapshot.mockResolvedValueOnce(null);

    const r = await hasMappedChange(
      { contactid: 'c-guid', firstname: 'Jane' /* no ubt_synctomarketo */ },
      'contact',
    );

    expect(r.changed).toBe(true);
    expect(r.reason).not.toBe('sync-to-marketo-opt-in-required');
  });
});
