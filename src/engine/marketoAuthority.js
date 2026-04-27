'use strict';

const { INTENT } = require('./intent');
const { classifyPerson } = require('./personClassifier');

/**
 * Gate Marketo-sourced payloads against the spec's authority model.
 *
 * Per spec §Operational Behaviour, Marketo is authorized to write to CRM only
 * for:
 *   - Global unsubscribe on an existing Contact (source field: `unsubscribed`,
 *     see ASSUMPTIONS §10).
 *   - New Lead creation when the Person is an unresolved Lead (no IDs, isLead
 *     indicator present).
 *
 * Anything else (Account writes, Contact non-consent field updates, Lead
 * updates, etc.) is UNAUTHORIZED and must be skipped with a reason.
 *
 * @param {object} payload
 * @returns {{ intent: string, reason: string }}
 */
function classifyMarketoIntent(payload = {}) {
  // Explicit Account shape (via payload.type) is not a Marketo authority.
  if (payload.type === 'account') {
    return {
      intent: INTENT.UNAUTHORIZED,
      reason: 'marketo-cannot-write-account',
    };
  }

  // Rule 1: global unsubscribe.
  // Requires unsubscribed === true AND at least one way to locate the contact
  // (crmContactId or email).
  if (payload.unsubscribed === true) {
    if (payload.crmContactId || payload.email) {
      return { intent: INTENT.GLOBAL_UNSUBSCRIBE, reason: 'unsubscribed-flag' };
    }
    return {
      intent: INTENT.UNAUTHORIZED,
      reason: 'unsubscribe-without-identifier',
    };
  }

  // Rule 2: new Lead. Classifier must say 'lead' AND no crmLeadId AND no
  // crmContactId — i.e. isLead indicator with no existing IDs.
  const { kind } = classifyPerson(payload);
  if (kind === 'lead' && !payload.crmLeadId && !payload.crmContactId) {
    return { intent: INTENT.NEW_LEAD, reason: 'isLead-indicator-no-ids' };
  }

  // Anything else is unauthorized — assemble a specific reason.
  if (payload.crmLeadId)    return { intent: INTENT.UNAUTHORIZED, reason: 'marketo-cannot-update-existing-lead' };
  if (payload.crmContactId) return { intent: INTENT.UNAUTHORIZED, reason: 'marketo-cannot-update-contact-nonconsent' };
  if (kind === 'contact')   return { intent: INTENT.UNAUTHORIZED, reason: 'marketo-cannot-update-contact-nonconsent' };
  return { intent: INTENT.UNAUTHORIZED, reason: 'marketo-person-undetermined' };
}

module.exports = { classifyMarketoIntent };
