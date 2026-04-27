'use strict';

const { classifyPerson } = require('../../src/engine/personClassifier');

// ── Truth table for the four indicators ───────────────────────────────────────
// Encodes bits as [crmContactId, crmLeadId, isCustomer, isLead].
// Expected kind follows the documented priority order.
const truthTable = [
  // [c-id, l-id, isCust, isLead, expectedKind, expectedIndicator]
  [0, 0, 0, 0, 'undetermined', null],
  [0, 0, 0, 1, 'lead',          'isLead'],
  [0, 0, 1, 0, 'contact',       'isCustomer'],
  [0, 0, 1, 1, 'contact',       'isCustomer'],
  [0, 1, 0, 0, 'lead',          'crmLeadId'],
  [0, 1, 0, 1, 'lead',          'crmLeadId'],
  [0, 1, 1, 0, 'lead',          'crmLeadId'],
  [0, 1, 1, 1, 'lead',          'crmLeadId'],
  [1, 0, 0, 0, 'contact',       'crmContactId'],
  [1, 0, 0, 1, 'contact',       'crmContactId'],
  [1, 0, 1, 0, 'contact',       'crmContactId'],
  [1, 0, 1, 1, 'contact',       'crmContactId'],
  [1, 1, 0, 0, 'contact',       'crmContactId'],
  [1, 1, 0, 1, 'contact',       'crmContactId'],
  [1, 1, 1, 0, 'contact',       'crmContactId'],
  [1, 1, 1, 1, 'contact',       'crmContactId'],
];

describe('classifyPerson — truth table (16 combos)', () => {
  it.each(truthTable)(
    'crmContactId=%i crmLeadId=%i isCustomer=%i isLead=%i → kind=%s (indicator=%s)',
    (cId, lId, isCust, isLead, expectedKind, expectedIndicator) => {
      const payload = {
        crmContactId: cId ? 'contact-guid' : null,
        crmLeadId:    lId ? 'lead-guid'    : null,
        isCustomer:   Boolean(isCust),
        isLead:       Boolean(isLead),
      };
      expect(classifyPerson(payload)).toEqual({
        kind:             expectedKind,
        matchedIndicator: expectedIndicator,
      });
    },
  );
});

describe('classifyPerson — conflict cases', () => {
  it('both IDs populated → contact wins', () => {
    const r = classifyPerson({ crmContactId: 'c', crmLeadId: 'l' });
    expect(r.kind).toBe('contact');
    expect(r.matchedIndicator).toBe('crmContactId');
  });

  it('both booleans true → contact wins (isCustomer over isLead)', () => {
    const r = classifyPerson({ isCustomer: true, isLead: true });
    expect(r.kind).toBe('contact');
    expect(r.matchedIndicator).toBe('isCustomer');
  });

  it('undefined/empty payload → undetermined', () => {
    expect(classifyPerson()).toEqual({ kind: 'undetermined', matchedIndicator: null });
    expect(classifyPerson({})).toEqual({ kind: 'undetermined', matchedIndicator: null });
  });

  it('isCustomer=false (not true) does not match — falls through to isLead', () => {
    const r = classifyPerson({ isCustomer: false, isLead: true });
    expect(r.kind).toBe('lead');
  });

  it('crmContactId empty string is falsy — falls through', () => {
    const r = classifyPerson({ crmContactId: '', crmLeadId: 'L' });
    expect(r.kind).toBe('lead');
  });

  it('type=lead with no other indicators → lead (Marketo-native type field)', () => {
    const r = classifyPerson({ type: 'lead', email: 'new@lead.com' });
    expect(r).toEqual({ kind: 'lead', matchedIndicator: 'type' });
  });

  it('type=contact with no other indicators → contact (Marketo-native type field)', () => {
    const r = classifyPerson({ type: 'contact', email: 'c@ex.com' });
    expect(r).toEqual({ kind: 'contact', matchedIndicator: 'type' });
  });

  it('isLead=true takes priority over type=contact', () => {
    const r = classifyPerson({ isLead: true, type: 'contact' });
    expect(r).toEqual({ kind: 'lead', matchedIndicator: 'isLead' });
  });

  it('isCustomer=true takes priority over type=lead', () => {
    const r = classifyPerson({ isCustomer: true, type: 'lead' });
    expect(r).toEqual({ kind: 'contact', matchedIndicator: 'isCustomer' });
  });
});
