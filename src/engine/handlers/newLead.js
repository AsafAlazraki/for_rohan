'use strict';

const axios = require('axios');
const { resolvePerson } = require('../personResolver');
const { evaluateEligibility } = require('../leadEligibility');
const { mapMarketoToCrm } = require('../fieldMapper');
const { getConfig } = require('../../config/loader');
const logger = require('../../audit/logger');

/**
 * Handle a Marketo-sourced new-lead event.
 *
 * Steps:
 *   1. Existing-Contact pre-check (ASSUMPTIONS §6): if the Person already
 *      resolves to an active Contact, skip — the integration never creates a
 *      Contact or an adjacent Lead in that case.
 *   2. Run full Lead eligibility evaluation. If any criterion fails, skip
 *      with a composite reason listing every failure.
 *   3. Build the Lead body from LEAD_FIELD_MAP, add
 *      `parentaccountid@odata.bind` using the resolved account, and stamp
 *      `ubt_marketoid` from `payload.id` if present.
 *   4. POST /leads.
 *
 * @param {{ payload: object, token: string, job?: object }} args
 * @returns {Promise<{ status: 'success'|'skipped', reason?: string, targetId?: string }>}
 */
async function handleNewLead({ payload, token, job }) {
  if (!token) throw new Error('[newLead] token required');

  // Step 1: existing-Contact pre-check. Only Contact matches matter here —
  // Lead resolution is handled by the authority guard upstream (a
  // crmLeadId-bearing payload never reaches NEW_LEAD), so we narrow the
  // resolver to contacts to avoid unnecessary Lead-table scans.
  const preCheck = await resolvePerson({
    ids:        { crmContactId: payload.crmContactId },
    email:      payload.email,
    marketoId:  payload.id,
    entityHint: 'contact',
    token,
    targetSystem: 'dynamics',
  });
  if (preCheck.entity === 'contact' && preCheck.targetId) {
    logger.info(
      { jobId: job?.id, contactId: preCheck.targetId, matchedBy: preCheck.matchedBy },
      '[newLead] person resolves to existing Contact — skipping Lead creation',
    );
    return { status: 'skipped', reason: 'person-resolves-to-existing-contact' };
  }

  // Step 2: eligibility.
  const eligibility = await evaluateEligibility(payload, { token });
  if (!eligibility.ok) {
    const reason = 'ineligible:' + eligibility.failures.map(f => f.criterion).join(',');
    logger.info(
      { jobId: job?.id, failures: eligibility.failures },
      '[newLead] payload not eligible',
    );
    return { status: 'skipped', reason };
  }

  // Step 3: body via scoped mapper (Task 11).
  const body = mapMarketoToCrm(payload, 'lead');
  if (eligibility.resolvedAccountId) {
    body['parentaccountid@odata.bind'] = `/accounts(${eligibility.resolvedAccountId})`;
  }


  // Step 4: POST /leads.
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[newLead] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  const url = `${resourceUrl}/api/data/v${apiVersion}/leads`;

  logger.info({ jobId: job?.id, body }, '[newLead] posting lead to Dynamics');

  let data, respHeaders;
  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization:      `Bearer ${token}`,
        'Content-Type':     'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Accept:             'application/json',
        Prefer:             'return=representation',
      },
    });
    data = resp.data;
    respHeaders = resp.headers;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    logger.error(
      { jobId: job?.id, status: err.response?.status, detail, body },
      '[newLead] Dynamics POST /leads failed',
    );
    throw err;
  }

  const entityIdHeader = respHeaders?.['odata-entityid'] || respHeaders?.['OData-EntityId'];
  const match = entityIdHeader?.match(/\(([^)]+)\)$/);
  const newLeadId = data?.leadid || (match ? match[1] : null);

  logger.info({ jobId: job?.id, leadId: newLeadId }, '[newLead] lead created');
  return { status: 'success', targetId: newLeadId };
}

module.exports = { handleNewLead };
