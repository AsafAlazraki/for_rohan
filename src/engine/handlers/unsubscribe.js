'use strict';

const axios = require('axios');
const { resolvePerson } = require('../personResolver');
const { getConfig } = require('../../config/loader');
const logger = require('../../audit/logger');

/**
 * Handle a Marketo-sourced global unsubscribe event.
 *
 * Steps (per spec §Operational Behaviour + ASSUMPTIONS §Q2):
 *   1. Resolve the Person (crmContactId primary, email fallback).
 *   2. If no active Contact is found → skip with reason 'contact-not-resolvable'.
 *      A payload that only matches a Lead is intentionally skipped — Marketo
 *      cannot update Lead consent.
 *   3. PATCH the Contact with a body containing exactly one field:
 *      `donotbulkemail: true`. No mapper involvement.
 *
 * @param {{ payload: object, token: string, job?: object }} args
 * @returns {Promise<{ status: 'success'|'skipped', reason?: string, targetId?: string }>}
 */
async function handleGlobalUnsubscribe({ payload, token, job }) {
  if (!token) throw new Error('[unsubscribe] token required');

  const resolved = await resolvePerson({
    ids:          { crmContactId: payload.crmContactId },
    email:        payload.email,
    marketoId:    payload.id,
    entityHint:   'contact',
    token,
    targetSystem: 'dynamics',
  });

  if (!resolved.targetId || resolved.entity !== 'contact') {
    logger.info({ jobId: job?.id, email: payload.email }, '[unsubscribe] contact not resolvable — skipping');
    return { status: 'skipped', reason: 'contact-not-resolvable' };
  }

  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[unsubscribe] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';

  const url = `${resourceUrl}/api/data/v${apiVersion}/contacts(${resolved.targetId})`;
  const body = { donotbulkemail: true };

  await axios.patch(url, body, {
    headers: {
      Authorization:      `Bearer ${token}`,
      'Content-Type':     'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version':    '4.0',
      Accept:             'application/json',
    },
  });

  logger.info(
    { jobId: job?.id, contactId: resolved.targetId, matchedBy: resolved.matchedBy },
    '[unsubscribe] donotbulkemail=true applied',
  );
  return { status: 'success', targetId: resolved.targetId };
}

module.exports = { handleGlobalUnsubscribe };
