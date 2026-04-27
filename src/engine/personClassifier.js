'use strict';

/**
 * Classify a Marketo Person payload as Contact vs Lead per spec §Operational
 * Behaviour. Priority order (highest wins):
 *   1. crmContactId truthy   → contact
 *   2. crmLeadId truthy      → lead
 *   3. isCustomer === true   → contact
 *   4. isLead === true       → lead
 *   5. type === 'lead'       → lead    (Marketo-native type field, lowest priority)
 *   6. type === 'contact'    → contact (Marketo-native type field, lowest priority)
 *   7. else                  → undetermined
 *
 * When both sides of a level fire (e.g. crmContactId AND crmLeadId), the
 * higher priority wins: contact wins over lead.
 *
 * @param {object} payload
 * @returns {{ kind: 'contact'|'lead'|'undetermined', matchedIndicator: string|null }}
 */
function classifyPerson(payload = {}) {
  if (payload.crmContactId) {
    return { kind: 'contact', matchedIndicator: 'crmContactId' };
  }
  if (payload.crmLeadId) {
    return { kind: 'lead', matchedIndicator: 'crmLeadId' };
  }
  if (payload.isCustomer === true) {
    return { kind: 'contact', matchedIndicator: 'isCustomer' };
  }
  if (payload.isLead === true) {
    return { kind: 'lead', matchedIndicator: 'isLead' };
  }
  if (payload.type === 'lead') {
    return { kind: 'lead', matchedIndicator: 'type' };
  }
  if (payload.type === 'contact') {
    return { kind: 'contact', matchedIndicator: 'type' };
  }
  return { kind: 'undetermined', matchedIndicator: null };
}

module.exports = { classifyPerson };
