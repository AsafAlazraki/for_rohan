'use strict';

const { classifyMarketoIntent } = require('../../src/engine/marketoAuthority');
const { INTENT } = require('../../src/engine/intent');

// Matrix of 13 payload shapes drawn from the spec's §Operational Behaviour
// table (plus a couple of edge cases).
describe('classifyMarketoIntent — authority matrix', () => {
  const cases = [
    // ── GLOBAL_UNSUBSCRIBE ──
    {
      name:     'unsubscribed=true + crmContactId → global unsubscribe',
      payload:  { unsubscribed: true, crmContactId: 'C1', email: 'a@b.com' },
      intent:   INTENT.GLOBAL_UNSUBSCRIBE,
    },
    {
      name:     'unsubscribed=true + email only → global unsubscribe',
      payload:  { unsubscribed: true, email: 'a@b.com' },
      intent:   INTENT.GLOBAL_UNSUBSCRIBE,
    },
    {
      name:     'unsubscribed=true with isLead → still unsubscribe (takes precedence)',
      payload:  { unsubscribed: true, email: 'a@b.com', isLead: true },
      intent:   INTENT.GLOBAL_UNSUBSCRIBE,
    },
    {
      name:     'unsubscribed=true but no identifier → unauthorized',
      payload:  { unsubscribed: true },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'unsubscribe-without-identifier',
    },

    // ── NEW_LEAD ──
    {
      name:     'isLead=true, no IDs → new lead',
      payload:  { isLead: true, email: 'new@lead.com', firstName: 'J', lastName: 'D', company: 'Acme' },
      intent:   INTENT.NEW_LEAD,
    },
    {
      name:     'type=lead, no IDs → new lead (Marketo-native type field)',
      payload:  { type: 'lead', email: 'azure.portal@test.com', firstName: 'Azure', lastName: 'Portal' },
      intent:   INTENT.NEW_LEAD,
    },

    // ── UNAUTHORIZED: explicit ID present ──
    {
      name:     'crmLeadId set (even with isLead) → unauthorized-update-lead',
      payload:  { isLead: true, crmLeadId: 'L1', email: 'a@b.com' },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-cannot-update-existing-lead',
    },
    {
      name:     'crmContactId set (non-unsubscribe) → unauthorized-update-contact',
      payload:  { crmContactId: 'C1', email: 'a@b.com', firstName: 'Jane' },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-cannot-update-contact-nonconsent',
    },
    {
      name:     'isCustomer=true (resolves to contact) non-unsubscribe → unauthorized',
      payload:  { isCustomer: true, email: 'a@b.com' },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-cannot-update-contact-nonconsent',
    },

    // ── UNAUTHORIZED: misc ──
    {
      name:     'payload.type=account → unauthorized-account',
      payload:  { type: 'account', name: 'Acme Ltd' },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-cannot-write-account',
    },
    {
      name:     'empty payload → unauthorized-undetermined',
      payload:  {},
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-person-undetermined',
    },
    {
      name:     'undefined payload → unauthorized-undetermined',
      payload:  undefined,
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-person-undetermined',
    },
    {
      name:     'unsubscribed=false is treated the same as absent',
      payload:  { unsubscribed: false, isLead: true, email: 'a@b.com' },
      intent:   INTENT.NEW_LEAD,
    },
    {
      name:     'email-only anonymous payload → unauthorized-undetermined',
      payload:  { email: 'anon@nobody.com' },
      intent:   INTENT.UNAUTHORIZED,
      reason:   'marketo-person-undetermined',
    },
  ];

  it.each(cases)('$name', ({ payload, intent, reason }) => {
    const out = classifyMarketoIntent(payload);
    expect(out.intent).toBe(intent);
    if (reason) expect(out.reason).toBe(reason);
  });
});
