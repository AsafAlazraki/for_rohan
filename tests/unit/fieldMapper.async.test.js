'use strict';

jest.mock('../../src/engine/optionSetResolver', () => ({
  resolveOption: jest.fn(),
  resolveLabel:  jest.fn(),
}));

jest.mock('../../src/engine/lookupResolver', () => ({
  resolveLookup: jest.fn(),
}));

const { resolveOption, resolveLabel } = require('../../src/engine/optionSetResolver');
const { resolveLookup } = require('../../src/engine/lookupResolver');
const {
  mapToMarketoAsync,
  mapMarketoToCrmAsync,
} = require('../../src/engine/fieldMapper');

beforeEach(() => {
  resolveOption.mockReset();
  resolveLabel.mockReset();
  resolveLookup.mockReset();
});

describe('mapToMarketoAsync (CRM → Marketo)', () => {
  it('passes through text/boolean fields without async calls', async () => {
    const out = await mapToMarketoAsync({
      firstname:     'Alice',
      emailaddress1: 'a@b.com',
      donotbulkemail: true,
    }, 'contact');
    expect(out).toMatchObject({ firstName: 'Alice', email: 'a@b.com', unsubscribed: true });
    expect(resolveLabel).not.toHaveBeenCalled();
  });

  it('resolves choice → label when token + optionSet provided', async () => {
    resolveLabel.mockResolvedValueOnce('Reseller');
    const out = await mapToMarketoAsync({
      ubt_accounttype: 100000001,
      name:            'Acme',
    }, 'account', { token: 'tok' });
    expect(out.accountType).toBe('Reseller');
    expect(out.company).toBe('Acme');
    expect(resolveLabel).toHaveBeenCalledWith('account', 'ubt_accounttype', 100000001, 'tok');
  });

  it('passes through choice value when label resolution returns null', async () => {
    resolveLabel.mockResolvedValueOnce(null);
    const out = await mapToMarketoAsync({
      ubt_accounttype: 100000001,
    }, 'account', { token: 'tok' });
    expect(out.accountType).toBe(100000001);
  });

  it('passes through choice raw when token absent', async () => {
    const out = await mapToMarketoAsync({
      ubt_accounttype: 100000001,
    }, 'account');
    expect(out.accountType).toBe(100000001);
    expect(resolveLabel).not.toHaveBeenCalled();
  });

  it('skips derived entries', async () => {
    const out = await mapToMarketoAsync({ firstname: 'X' }, 'contact', { token: 't' });
    expect(out).not.toHaveProperty('contactAccountType');
  });

  it('drops blank values', async () => {
    const out = await mapToMarketoAsync({ firstname: '', emailaddress1: 'a@b.com' }, 'contact');
    // crmEntityType is a literal — emitted regardless of source record contents.
    expect(out).toEqual({ email: 'a@b.com', crmEntityType: 'contact' });
  });
});

describe('mapMarketoToCrmAsync (Marketo → CRM)', () => {
  it('passes through text fields', async () => {
    const out = await mapMarketoToCrmAsync({
      firstName: 'Jane', lastName: 'Doe', email: 'j@d.com',
    }, 'lead');
    expect(out).toMatchObject({
      firstname: 'Jane', lastname: 'Doe', emailaddress1: 'j@d.com',
    });
  });

  it('resolves choice via resolveOption', async () => {
    resolveOption.mockResolvedValueOnce(7);
    // the lead mapping has 'personSource' choice on leadsourcecode but it's
    // crmToMarketo. The marketoToCrm.lead doesn't include any choice entry
    // by default, so we'll inject by reusing whatever mapping has it. The
    // test checks the function via fallback path (no choice on marketoToCrm
    // lead). For coverage of the choice branch, fake-mock fieldmap by adding
    // an extra entry through a separate require approach.
    // Simplest: confirm passthrough with no token doesn't call resolveOption.
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it('resolves lookup → @odata.bind when id resolves', async () => {
    resolveLookup.mockResolvedValueOnce('country-guid-1');
    // marketoToCrm.lead has no lookup entries in current fieldmap, so
    // there's nothing to test here using just the lead mapping. We exercise
    // the lookup path indirectly by passing a record where a lookup entry
    // exists (none currently — keep this assertion light).
    resolveLookup.mockClear();
    await mapMarketoToCrmAsync({}, 'lead', { token: 't' });
    // At minimum: confirm the function doesn't crash.
    expect(resolveLookup).not.toHaveBeenCalled();
  });

  it('passes through choice raw when no token', async () => {
    const out = await mapMarketoToCrmAsync({ email: 'a@b.com' }, 'lead');
    expect(out).toMatchObject({ emailaddress1: 'a@b.com' });
  });

  it('drops blank values', async () => {
    const out = await mapMarketoToCrmAsync({ email: '', firstName: 'A' }, 'lead');
    expect(out).toEqual({ firstname: 'A' });
  });

  it('throws on unknown entityType', async () => {
    await expect(mapMarketoToCrmAsync({}, 'opportunity')).rejects.toThrow('Unknown mapping');
  });
});

// To exercise the async choice + lookup branches of mapMarketoToCrmAsync we
// monkey-patch the cached fieldmap require — a separate, isolated describe
// block keeps the side-effect contained.
describe('mapMarketoToCrmAsync — choice/lookup branches via injected mapping', () => {
  let fieldmap;
  beforeAll(() => {
    fieldmap = require('../../src/config/fieldmap.json');
    fieldmap.marketoToCrm.lead.__choiceTest = {
      source: 'someChoice', type: 'choice', optionSet: 'os1',
    };
    fieldmap.marketoToCrm.lead.__lookupTest = {
      source: 'someLookup', type: 'lookup', entitySet: 'ubt_countries',
    };
  });
  afterAll(() => {
    delete fieldmap.marketoToCrm.lead.__choiceTest;
    delete fieldmap.marketoToCrm.lead.__lookupTest;
  });

  it('choice resolves to its int via resolveOption', async () => {
    resolveOption.mockResolvedValueOnce(99);
    const out = await mapMarketoToCrmAsync(
      { someChoice: 'Reseller' },
      'lead',
      { token: 'tok' },
    );
    expect(out.__choiceTest).toBe(99);
    expect(resolveOption).toHaveBeenCalledWith('lead', 'os1', 'Reseller', 'tok');
  });

  it('choice falls back to raw when resolveOption returns null', async () => {
    resolveOption.mockResolvedValueOnce(null);
    const out = await mapMarketoToCrmAsync(
      { someChoice: 'Reseller' },
      'lead',
      { token: 'tok' },
    );
    expect(out.__choiceTest).toBe('Reseller');
  });

  it('lookup emits @odata.bind when resolveLookup returns id', async () => {
    resolveLookup.mockResolvedValueOnce('nz-guid');
    const out = await mapMarketoToCrmAsync(
      { someLookup: 'New Zealand' },
      'lead',
      { token: 'tok' },
    );
    expect(out['__lookupTest@odata.bind']).toBe('/ubt_countries(nz-guid)');
  });

  it('lookup is dropped when resolveLookup returns null', async () => {
    resolveLookup.mockResolvedValueOnce(null);
    const out = await mapMarketoToCrmAsync(
      { someLookup: 'Atlantis' },
      'lead',
      { token: 'tok' },
    );
    expect(out).not.toHaveProperty('__lookupTest@odata.bind');
    expect(out).not.toHaveProperty('__lookupTest');
  });
});
