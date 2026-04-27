'use strict';

const { mapToMarketo, mapMarketoToCrm } = require('../../src/engine/fieldMapper');
const fieldmap                          = require('../../src/config/fieldmap.json');

// ── mapToMarketo (CRM → Marketo) ──────────────────────────────────────────────
describe('mapToMarketo()', () => {
  it('maps a contact record through crmToMarketo.contact', () => {
    const out = mapToMarketo({
      firstname:     'Alice',
      lastname:      'Smith',
      emailaddress1: 'alice@example.com',
      telephone1:    '555-1111',
      jobtitle:      'Engineer',
      address1_city: 'Auckland',
      donotbulkemail: true,
    }, 'contact');

    expect(out).toMatchObject({
      firstName: 'Alice',
      lastName:  'Smith',
      email:     'alice@example.com',
      phone:     '555-1111',
      title:     'Engineer',
      city:      'Auckland',
      unsubscribed: true,
    });
  });

  it('maps a lead record through crmToMarketo.lead', () => {
    const out = mapToMarketo({
      firstname:     'Lee',
      lastname:      'Jones',
      emailaddress1: 'lee@lead.com',
      subject:       'Demo request',
      description:   'Wants a demo',
      ubt_communitymember: 1,
      donotbulkemail: true,
    }, 'lead');

    expect(out).toMatchObject({
      firstName:   'Lee',
      lastName:    'Jones',
      email:       'lee@lead.com',
      subject:     'Demo request',
      description: 'Wants a demo',
      communityMember: 1,
      unsubscribed: true,
    });
  });

  it('maps an account record through crmToMarketo.account', () => {
    const out = mapToMarketo({
      name:                'Acme Ltd',
      accountnumber:       'AN-42',
      ubt_accounttype:     'Reseller',
      ubt_markettype:      'Enterprise',
    }, 'account');

    expect(out).toEqual({
      company:       'Acme Ltd',
      accountNumber: 'AN-42',
      accountType:   'Reseller',
      marketType:    'Enterprise',
    });
  });

  it('drops null / undefined / empty-string values', () => {
    const out = mapToMarketo({
      emailaddress1: 'a@b.com',
      firstname:     null,
      lastname:      undefined,
      telephone1:    '',
    }, 'contact');

    // crmEntityType is a literal — emitted regardless of source record contents.
    expect(out).toEqual({ email: 'a@b.com', crmEntityType: 'contact' });
  });

  it('skips derived entries (Task 11b handles those)', () => {
    const out = mapToMarketo({
      firstname: 'Jane',
      jobtitle:  'Manager',
    }, 'contact');

    expect(out).not.toHaveProperty('contactAccountType');
    expect(out).not.toHaveProperty('isPrimaryContact');
  });

  it('throws on unknown entityType', () => {
    expect(() => mapToMarketo({}, 'opportunity')).toThrow('Unknown mapping');
  });

  it('emits only literal fields when no source fields match', () => {
    // crmEntityType is literal so it always appears even on an empty record.
    expect(mapToMarketo({}, 'contact')).toEqual({ crmEntityType: 'contact' });
    expect(mapToMarketo({}, 'lead')).toEqual({ crmEntityType: 'lead' });
    // Account has no literal entries.
    expect(mapToMarketo({}, 'account')).toEqual({});
  });

  it('ignores source fields not declared in the mapping', () => {
    const out = mapToMarketo({
      emailaddress1: 'a@b.com',
      randomfield:   'should-not-appear',
    }, 'contact');
    expect(out).toEqual({ email: 'a@b.com', crmEntityType: 'contact' });
  });

  it('stamps crmEntityType + crmContactId on a contact projection', () => {
    const out = mapToMarketo({
      contactid:     '11111111-1111-1111-1111-111111111111',
      emailaddress1: 'alice@acme.com',
      firstname:     'Alice',
    }, 'contact');

    expect(out.crmEntityType).toBe('contact');
    expect(out.crmContactId).toBe('11111111-1111-1111-1111-111111111111');
    expect(out).not.toHaveProperty('crmLeadId');
  });

  it('stamps crmEntityType + crmLeadId on a lead projection', () => {
    const out = mapToMarketo({
      leadid:        '22222222-2222-2222-2222-222222222222',
      emailaddress1: 'bob@acme.com',
      firstname:     'Bob',
    }, 'lead');

    expect(out.crmEntityType).toBe('lead');
    expect(out.crmLeadId).toBe('22222222-2222-2222-2222-222222222222');
    expect(out).not.toHaveProperty('crmContactId');
  });

  it('omits crmContactId / crmLeadId when the source GUID is absent', () => {
    const contact = mapToMarketo({ emailaddress1: 'x@y.com' }, 'contact');
    expect(contact).not.toHaveProperty('crmContactId');
    expect(contact.crmEntityType).toBe('contact');

    const lead = mapToMarketo({ emailaddress1: 'x@y.com' }, 'lead');
    expect(lead).not.toHaveProperty('crmLeadId');
    expect(lead.crmEntityType).toBe('lead');
  });
});

// ── mapMarketoToCrm (Marketo → CRM) ──────────────────────────────────────────
describe('mapMarketoToCrm()', () => {
  it('contact scope emits only donotbulkemail (consent-only write path)', () => {
    const out = mapMarketoToCrm({
      unsubscribed: true,
      firstName:    'Bob',
      email:        'a@b.com',
    }, 'contact');

    expect(out).toEqual({ donotbulkemail: true });
    expect(out).not.toHaveProperty('firstname');
  });

  it('lead scope projects the new-lead whitelist', () => {
    const out = mapMarketoToCrm({
      id:          'MKTO-1',
      firstName:   'Jane',
      lastName:    'Doe',
      email:       'jane@acme.com',
      title:       'VP',
      phone:       '555',
      mobilePhone: '555-MOB',
      company:     'Acme',
      city:        'Auckland',
      postalCode:  '1010',
    }, 'lead');

    expect(out).toMatchObject({
      firstname:           'Jane',
      lastname:            'Doe',
      emailaddress1:       'jane@acme.com',
      jobtitle:            'VP',
      telephone1:          '555',
      mobilephone:         '555-MOB',
      companyname:         'Acme',
      address1_city:       'Auckland',
      address1_postalcode: '1010',
    });
  });

  it('drops null / empty source values', () => {
    const out = mapMarketoToCrm({
      email:     'a@b.com',
      firstName: null,
      lastName:  '',
    }, 'lead');
    expect(out).toEqual({ emailaddress1: 'a@b.com' });
  });

  it('account mapping is not defined in marketoToCrm — Marketo cannot write accounts', () => {
    expect(() => mapMarketoToCrm({}, 'account')).toThrow('Unknown mapping');
  });
});

// ── Scope isolation & shape invariants (Task 11 DoD) ─────────────────────────
describe('scope isolation', () => {
  it('marketoToCrm.contact keys ⊆ { donotbulkemail }', () => {
    expect(Object.keys(fieldmap.marketoToCrm.contact)).toEqual(['donotbulkemail']);
  });

  it('marketoToCrm has no account scope', () => {
    expect(fieldmap.marketoToCrm.account).toBeUndefined();
  });

  it('crmToMarketo.lead includes statuscode/statecode projections (Lead qualification sync)', () => {
    expect(fieldmap.crmToMarketo.lead).toHaveProperty('crmLeadStatus');
    expect(fieldmap.crmToMarketo.lead).toHaveProperty('crmLeadState');
  });

  it('every entry declares a valid source + type', () => {
    const allowedTypes = new Set(['text', 'choice', 'lookup', 'boolean', 'guid', 'derived', 'literal']);
    for (const scope of ['crmToMarketo', 'marketoToCrm']) {
      for (const entity of Object.keys(fieldmap[scope])) {
        for (const [key, entry] of Object.entries(fieldmap[scope][entity])) {
          expect(entry).toHaveProperty('source');
          expect(entry).toHaveProperty('type');
          expect(allowedTypes.has(entry.type)).toBe(true);
        }
      }
    }
  });

  it('literal entries declare a value', () => {
    for (const scope of ['crmToMarketo', 'marketoToCrm']) {
      for (const entity of Object.keys(fieldmap[scope])) {
        for (const [, entry] of Object.entries(fieldmap[scope][entity])) {
          if (entry.type === 'literal') {
            expect(entry).toHaveProperty('value');
            expect(typeof entry.value === 'string' || typeof entry.value === 'number' || typeof entry.value === 'boolean').toBe(true);
          }
        }
      }
    }
  });

  it('crmToMarketo.contact and crmToMarketo.lead carry a crmEntityType literal', () => {
    expect(fieldmap.crmToMarketo.contact.crmEntityType).toMatchObject({ type: 'literal', value: 'contact' });
    expect(fieldmap.crmToMarketo.lead.crmEntityType).toMatchObject({ type: 'literal', value: 'lead' });
  });

  it('lookup entries declare an entitySet', () => {
    for (const scope of ['crmToMarketo', 'marketoToCrm']) {
      for (const entity of Object.keys(fieldmap[scope])) {
        for (const [, entry] of Object.entries(fieldmap[scope][entity])) {
          if (entry.type === 'lookup') {
            expect(entry).toHaveProperty('entitySet');
          }
        }
      }
    }
  });

  it('choice entries declare an optionSet', () => {
    for (const scope of ['crmToMarketo', 'marketoToCrm']) {
      for (const entity of Object.keys(fieldmap[scope])) {
        for (const [, entry] of Object.entries(fieldmap[scope][entity])) {
          if (entry.type === 'choice') {
            expect(entry).toHaveProperty('optionSet');
          }
        }
      }
    }
  });

  it('derived entries declare a derivation name', () => {
    for (const scope of ['crmToMarketo', 'marketoToCrm']) {
      for (const entity of Object.keys(fieldmap[scope])) {
        for (const [, entry] of Object.entries(fieldmap[scope][entity])) {
          if (entry.type === 'derived') {
            expect(entry).toHaveProperty('derivation');
          }
        }
      }
    }
  });
});
