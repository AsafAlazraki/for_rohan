'use strict';

/**
 * Sync intent constants for the Marketo-authority guard.
 *
 * Per spec §Operational Behaviour, Marketo is only authorized to write to CRM
 * in two narrow cases: a global unsubscribe on an existing Contact, and a new
 * Lead creation. Everything else from a Marketo source is UNAUTHORIZED.
 */
const INTENT = Object.freeze({
  GLOBAL_UNSUBSCRIBE: 'global_unsubscribe',
  NEW_LEAD:           'new_lead',
  CRM_TO_MARKETO:     'crm_to_marketo',
  UNAUTHORIZED:       'unauthorized',
});

module.exports = { INTENT };
