'use strict';

// ── Mock all external boundaries before requiring the module under test ─────
jest.mock('../../src/readers/dynamics', () => ({
  readDynamicsById: jest.fn(),
}));
jest.mock('../../src/engine/accountResolver', () => ({
  resolveAccount: jest.fn(),
}));
jest.mock('../../src/writers/marketo', () => ({
  writeToMarketo:      jest.fn(),
  writeMarketoCompany: jest.fn(),
}));
jest.mock('../../src/audit/db', () => ({
  logEvent: jest.fn().mockResolvedValue({ id: 'audit-uuid' }),
  logSkip:  jest.fn().mockResolvedValue({ id: 'audit-skip-uuid' }),
}));
jest.mock('../../src/events/bus', () => ({
  emitSync: jest.fn(),
}));
jest.mock('../../src/audit/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/engine/derivedFields', () => ({
  // pass-through: leave the projected body untouched.
  enrichDerived: jest.fn((mapped) => Promise.resolve(mapped)),
}));

const { readDynamicsById }                = require('../../src/readers/dynamics');
const { resolveAccount }                  = require('../../src/engine/accountResolver');
const { writeToMarketo, writeMarketoCompany } = require('../../src/writers/marketo');
const { logEvent, logSkip }               = require('../../src/audit/db');
const { emitSync }                        = require('../../src/events/bus');
const {
  previewBundle,
  runBundle,
  resolveAssociatedCompany,
  REASON_CRITERION,
  VALID_ENTITIES,
} = require('../../src/engine/bundleSync');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── resolveAssociatedCompany ────────────────────────────────────────────────
describe('resolveAssociatedCompany', () => {
  it('contact with no parentcustomerid → person-only', async () => {
    const r = await resolveAssociatedCompany({
      record:     { contactid: 'c1', emailaddress1: 'a@b.com' },
      entityType: 'contact',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('person-only');
    expect(readDynamicsById).not.toHaveBeenCalled();
  });

  it('contact with resolvable parentcustomerid → with-company', async () => {
    readDynamicsById.mockResolvedValueOnce({ accountid: 'a1', name: 'Acme' });
    const r = await resolveAssociatedCompany({
      record:     { contactid: 'c1', _parentcustomerid_value: 'a1' },
      entityType: 'contact',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('with-company');
    expect(r.accountId).toBe('a1');
    expect(r.matchedBy).toBe('parentcustomerid');
  });

  it('contact with parentcustomerid that 404s → person-only with unresolved-account', async () => {
    // We previously skipped the row; now we downgrade to person-only and let
    // the Person carry its `company` field so Marketo can dedup the Company.
    readDynamicsById.mockResolvedValueOnce(null);
    const r = await resolveAssociatedCompany({
      record:     { contactid: 'c1', _parentcustomerid_value: 'gone' },
      entityType: 'contact',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('person-only');
    expect(r.skipReason).toBe('unresolved-account');
  });

  it('lead with no companyname / accountnumber → person-only', async () => {
    const r = await resolveAssociatedCompany({
      record:     { leadid: 'l1' },
      entityType: 'lead',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('person-only');
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it('lead with companyname that resolves → with-company', async () => {
    resolveAccount.mockResolvedValueOnce({ targetId: 'a-acme', matchedBy: 'name' });
    readDynamicsById.mockResolvedValueOnce({ accountid: 'a-acme', name: 'Acme' });
    const r = await resolveAssociatedCompany({
      record:     { leadid: 'l1', companyname: 'Acme' },
      entityType: 'lead',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('with-company');
    expect(r.accountId).toBe('a-acme');
    expect(r.matchedBy).toBe('name');
    expect(resolveAccount).toHaveBeenCalledWith({
      ids:   { accountnumber: undefined, name: 'Acme' },
      token: 'tok',
    });
  });

  it('lead with companyname that does NOT resolve → person-only with unresolved-account', async () => {
    // Downgraded — Lead push proceeds carrying its `company` field so Marketo
    // dedups the Company on its side. CRM Account creation is left to the operator.
    resolveAccount.mockResolvedValueOnce({ targetId: null, matchedBy: null });
    const r = await resolveAssociatedCompany({
      record:     { leadid: 'l1', companyname: 'No Such Co' },
      entityType: 'lead',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('person-only');
    expect(r.skipReason).toBe('unresolved-account');
  });

  it('lead with companyname that resolves but the Account read 404s → person-only', async () => {
    resolveAccount.mockResolvedValueOnce({ targetId: 'orphan', matchedBy: 'name' });
    readDynamicsById.mockResolvedValueOnce(null);
    const r = await resolveAssociatedCompany({
      record:     { leadid: 'l1', companyname: 'Acme' },
      entityType: 'lead',
      dynToken:   'tok',
    });
    expect(r.plan).toBe('person-only');
    expect(r.skipReason).toBe('unresolved-account');
  });
});

// ── previewBundle (read-only) ───────────────────────────────────────────────
describe('previewBundle', () => {
  it('throws on invalid entity', async () => {
    await expect(previewBundle({
      entity: 'opportunity', sourceIds: ['x'], dynToken: 't', mktToken: 't',
    })).rejects.toThrow(/entity must be one of/);
  });

  it('throws on empty sourceIds', async () => {
    await expect(previewBundle({
      entity: 'contact', sourceIds: [], dynToken: 't', mktToken: 't',
    })).rejects.toThrow(/non-empty array/);
  });

  it('produces aggregate summary across mixed plans', async () => {
    // Row 1: contact with company
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com', firstname: 'A', _parentcustomerid_value: 'acc1' })
      .mockResolvedValueOnce({ accountid: 'acc1', name: 'Acme' });
    // Row 2: contact, person-only (no parent at all)
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c2', emailaddress1: 'b@b.com', firstname: 'B' });
    // Row 3: contact, parent FK doesn't resolve → downgraded to person-only
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c3', emailaddress1: 'c@b.com', _parentcustomerid_value: 'gone' })
      .mockResolvedValueOnce(null);
    // Row 4: source not found → still skipped (only true skip case left)
    readDynamicsById
      .mockResolvedValueOnce(null);

    const r = await previewBundle({
      entity: 'contact',
      sourceIds: ['c1', 'c2', 'c3', 'c4'],
      dynToken: 'd', mktToken: 'm',
    });

    expect(r.summary).toEqual({
      total:       4,
      withCompany: 1,
      personOnly:  2, // c2 (no parent) + c3 (parent FK 404 — downgraded)
      willSkip:    1, // c4 source-not-found
      errors:      0,
    });
    expect(r.rows[0]).toMatchObject({ sourceId: 'c1', plan: 'with-company', accountId: 'acc1' });
    expect(r.rows[0].personBody.crmEntityType).toBe('contact');
    expect(r.rows[0].personBody.crmContactId).toBe('c1');
    // The Account fields get merged onto the Person body so the Marketo Lead
    // carries the company name even before the Companies API call lands.
    expect(r.rows[0].personBody.company).toBe('Acme');
    expect(r.rows[0].accountBody).toMatchObject({ company: 'Acme' });
    expect(r.rows[1]).toMatchObject({ sourceId: 'c2', plan: 'person-only', skipReason: null });
    expect(r.rows[2]).toMatchObject({ sourceId: 'c3', plan: 'person-only', skipReason: 'unresolved-account' });
    expect(r.rows[3]).toMatchObject({ sourceId: 'c4', plan: 'skip', skipReason: 'source-record-not-found' });
  });

  it('captures per-row errors without aborting the batch', async () => {
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com' }) // ok
      .mockRejectedValueOnce(new Error('boom'))                              // throws
      .mockResolvedValueOnce({ contactid: 'c3', emailaddress1: 'c@b.com' }); // ok

    const r = await previewBundle({
      entity: 'contact',
      sourceIds: ['c1', 'c2', 'c3'],
      dynToken: 'd', mktToken: 'm',
    });

    expect(r.summary.total).toBe(3);
    expect(r.summary.errors).toBe(1);
    expect(r.rows[1]).toMatchObject({ sourceId: 'c2', plan: 'error', error: 'boom' });
  });
});

// ── runBundle (live) ────────────────────────────────────────────────────────
describe('runBundle', () => {
  it('throws on invalid entity', async () => {
    await expect(runBundle({
      entity: 'account', sourceIds: ['x'], dynToken: 't', mktToken: 't',
    })).rejects.toThrow(/entity must be one of/);
  });

  it('with-company row: writes Account then Person and audits both', async () => {
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com', firstname: 'A', _parentcustomerid_value: 'acc1' })
      .mockResolvedValueOnce({ accountid: 'acc1', name: 'Acme' });
    writeMarketoCompany.mockResolvedValueOnce({ targetId: 'mkto-co-1', status: 'created' });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-lead-1', status: 'created' });

    const r = await runBundle({
      entity: 'contact', sourceIds: ['c1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.summary).toMatchObject({
      total: 1, personsSynced: 1, accountsSynced: 1, skipped: 0, failed: 0,
    });
    expect(r.results[0]).toMatchObject({
      sourceId: 'c1', plan: 'with-company',
      accountSynced: true, accountTargetId: 'mkto-co-1',
      personSynced:  true, personTargetId:  'mkto-lead-1',
    });

    // Two audit rows: account + person, both tagged manual
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source_type: 'account', target_id: 'mkto-co-1', status: 'success',
      reason_category: 'manual', reason_criterion: REASON_CRITERION,
    }));
    expect(logEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source_type: 'contact', target_id: 'mkto-lead-1', status: 'success',
      reason_category: 'manual', reason_criterion: REASON_CRITERION,
    }));
  });

  it('account write fails but person still pushed (Marketo dedups Company on the fly)', async () => {
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com', _parentcustomerid_value: 'acc1' })
      .mockResolvedValueOnce({ accountid: 'acc1', name: 'Acme' });
    writeMarketoCompany.mockRejectedValueOnce(new Error('co-down'));
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-lead-1', status: 'created' });

    const r = await runBundle({
      entity: 'contact', sourceIds: ['c1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.results[0].accountSynced).toBe(false);
    expect(r.results[0].personSynced).toBe(true);
    expect(r.results[0].error).toMatch(/account-write-failed: co-down/);
    expect(r.summary).toMatchObject({ accountsSynced: 0, personsSynced: 1, failed: 0 });

    // Audit: account=failed, person=success
    expect(logEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source_type: 'account', status: 'failed', error_message: 'co-down',
    }));
    expect(logEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source_type: 'contact', status: 'success', target_id: 'mkto-lead-1',
    }));
  });

  it('skip row (source-record-not-found) produces a logSkip and no writes', async () => {
    // Truly missing source — readDynamicsById returns null. This is the only
    // case that still skips entirely; unresolved-account downgrades to
    // person-only and proceeds.
    readDynamicsById.mockResolvedValueOnce(null);

    const r = await runBundle({
      entity: 'lead', sourceIds: ['l1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.results[0]).toMatchObject({
      plan: 'skip', skipReason: 'source-record-not-found',
      personSynced: false, accountSynced: false,
    });
    expect(writeMarketoCompany).not.toHaveBeenCalled();
    expect(writeToMarketo).not.toHaveBeenCalled();
    expect(logSkip).toHaveBeenCalledWith(expect.objectContaining({
      source: 'dynamics', target: 'marketo',
      sourceType: 'lead', sourceId: 'l1',
      category: 'manual',
      criterion: `${REASON_CRITERION}:source-record-not-found`,
    }));
  });

  it('lead with unresolvable company → person-only push, NO logSkip, NO company write', async () => {
    readDynamicsById.mockResolvedValueOnce({ leadid: 'l1', emailaddress1: 'a@b.com', companyname: 'Unknown Co' });
    resolveAccount.mockResolvedValueOnce({ targetId: null });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-l1' });

    const r = await runBundle({
      entity: 'lead', sourceIds: ['l1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.results[0]).toMatchObject({
      plan: 'person-only',
      skipReason: 'unresolved-account',
      personSynced: true,
      accountSynced: false,
    });
    expect(writeMarketoCompany).not.toHaveBeenCalled();
    expect(writeToMarketo).toHaveBeenCalledTimes(1);
  });

  it('person-only row writes Person without touching Account', async () => {
    readDynamicsById
      .mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com' });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-lead-1' });

    const r = await runBundle({
      entity: 'contact', sourceIds: ['c1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.results[0]).toMatchObject({
      plan: 'person-only', personSynced: true, accountSynced: false,
    });
    expect(writeMarketoCompany).not.toHaveBeenCalled();
    expect(writeToMarketo).toHaveBeenCalledTimes(1);
  });

  it('mid-batch person failure is captured; remaining rows still run', async () => {
    // Row 1 — succeeds
    readDynamicsById.mockResolvedValueOnce({ contactid: 'c1', emailaddress1: 'a@b.com' });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-1' });
    // Row 2 — person write blows up
    readDynamicsById.mockResolvedValueOnce({ contactid: 'c2', emailaddress1: 'b@b.com' });
    writeToMarketo.mockRejectedValueOnce(new Error('429-no-good'));
    // Row 3 — succeeds
    readDynamicsById.mockResolvedValueOnce({ contactid: 'c3', emailaddress1: 'c@b.com' });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-3' });

    const r = await runBundle({
      entity: 'contact', sourceIds: ['c1', 'c2', 'c3'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'test',
    });

    expect(r.summary).toMatchObject({ total: 3, personsSynced: 2, failed: 1 });
    expect(r.results[1].error).toMatch(/person-write-failed: 429-no-good/);
    expect(r.results[2].personSynced).toBe(true);
  });
});

describe('company info propagates onto Person body', () => {
  // These tests prove the user-visible fix: when a Contact / Lead is
  // bundle-synced, the Marketo Lead record actually carries the company
  // name + billing address + industry etc. — even when the standalone
  // Companies endpoint isn't called.

  it('with-company contact: company + billingCity + industry land on the Person body in preview', async () => {
    readDynamicsById
      .mockResolvedValueOnce({
        contactid:                 'c1',
        emailaddress1:             'alice@acme.com',
        firstname:                 'Alice',
        _parentcustomerid_value:   'acc1',
      })
      .mockResolvedValueOnce({
        accountid:        'acc1',
        name:             'Acme Ltd',
        accountnumber:    'AN-7',
        address1_city:    'Auckland',
        address1_country: 'New Zealand',
        websiteurl:       'https://acme.example',
        telephone1:       '555-9000',
        numberofemployees: 250,
      });

    const r = await previewBundle({
      entity: 'contact', sourceIds: ['c1'],
      dynToken: 'd', mktToken: 'm',
    });

    expect(r.rows[0].plan).toBe('with-company');
    // Person body now carries company + Account-level enrichment fields.
    expect(r.rows[0].personBody).toMatchObject({
      email:             'alice@acme.com',
      firstName:         'Alice',
      crmEntityType:     'contact',
      crmContactId:      'c1',
      company:           'Acme Ltd',
      accountNumber:     'AN-7',
      billingCity:       'Auckland',
      billingCountry:    'New Zealand',
      website:           'https://acme.example',
      mainPhone:         '555-9000',
      numberOfEmployees: 250,
    });
    // Account body still produced separately for the Companies-API write.
    expect(r.rows[0].accountBody).toMatchObject({
      company:        'Acme Ltd',
      billingCity:    'Auckland',
      billingCountry: 'New Zealand',
    });
  });

  it('with-company contact: same merge happens on the live runBundle path before writeToMarketo', async () => {
    readDynamicsById
      .mockResolvedValueOnce({
        contactid:               'c1',
        emailaddress1:           'alice@acme.com',
        _parentcustomerid_value: 'acc1',
      })
      .mockResolvedValueOnce({
        accountid:     'acc1',
        name:          'Acme Ltd',
        address1_city: 'Auckland',
      });
    writeMarketoCompany.mockResolvedValueOnce({ targetId: 'mkto-co-1', status: 'created' });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-lead-1', status: 'created' });

    await runBundle({
      entity: 'contact', sourceIds: ['c1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'merge-test',
    });

    // The Person body sent to Marketo should include the merged company info.
    expect(writeToMarketo).toHaveBeenCalledTimes(1);
    const personBody = writeToMarketo.mock.calls[0][0];
    expect(personBody).toMatchObject({
      email:         'alice@acme.com',
      crmEntityType: 'contact',
      crmContactId:  'c1',
      company:       'Acme Ltd',
      billingCity:   'Auckland',
    });
  });

  it('Lead with companyname carries `company` to Marketo even when no CRM Account exists', async () => {
    // The "we used to skip" case — now downgrades to person-only with the
    // companyname forwarded so Marketo can still create / link the Company.
    readDynamicsById.mockResolvedValueOnce({
      leadid:        'l1',
      emailaddress1: 'b@c.com',
      firstname:     'Bob',
      companyname:   'Untracked Co',
    });
    resolveAccount.mockResolvedValueOnce({ targetId: null });
    writeToMarketo.mockResolvedValueOnce({ targetId: 'mkto-lead', status: 'created' });

    const r = await runBundle({
      entity: 'lead', sourceIds: ['l1'],
      dynToken: 'd', mktToken: 'm', jobIdPrefix: 'lead-no-account',
    });

    expect(r.results[0].plan).toBe('person-only');
    expect(r.results[0].personSynced).toBe(true);
    expect(writeMarketoCompany).not.toHaveBeenCalled();

    const personBody = writeToMarketo.mock.calls[0][0];
    // Even without a CRM Account, the lead's companyname is mapped to
    // Marketo's `company` field — so Marketo can dedup the Company itself.
    expect(personBody.company).toBe('Untracked Co');
    expect(personBody.crmEntityType).toBe('lead');
    expect(personBody.crmLeadId).toBe('l1');
  });
});

describe('VALID_ENTITIES', () => {
  it('only allows contact and lead', () => {
    expect(VALID_ENTITIES).toEqual(['contact', 'lead']);
  });
});
