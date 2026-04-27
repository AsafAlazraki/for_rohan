'use strict';

const axios  = require('axios');
const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');

const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_429_RETRIES        = 3;
const UUID_RE                = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(header) {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = parseInt(header, 10);
  return isNaN(secs) ? DEFAULT_RETRY_AFTER_MS : secs * 1000;
}

function extractIdFromODataEntityId(odataId) {
  if (!odataId) return null;
  const match = odataId.match(/\(([^)]+)\)$/);
  return match ? match[1] : null;
}

/**
 * Write a contact to Dynamics CRM using the Dataverse API.
 * - action=create → POST /contacts
 * - action=update → PATCH /contacts({id})
 * Handles 429 with Retry-After back-off.
 *
 * @param {object} data        - Fields to write, plus `action` and `targetId`
 * @param {string} token       - Bearer access token
 * @param {number} [_attempt]  - Internal retry counter (do not pass manually)
 * @returns {Promise<{ targetId: string|null, action: string }>}
 */
async function writeToDynamics(data, token, _attempt = 0) {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[writers/dynamics] DYNAMICS_RESOURCE_URL not set');
  const API_VERSION = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';

  const { action, targetId, ...fields } = data;

  const baseHeaders = {
    Authorization:      `Bearer ${token}`,
    'Content-Type':     'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
  };

  const contactsUrl = `${resourceUrl}/api/data/v${API_VERSION}/contacts`;

  try {
    if (!targetId || action === 'create') {
      // ── Create ─────────────────────────────────────────────────────────────
      const { data: respBody, headers: respHeaders } = await axios.post(
        contactsUrl,
        fields,
        { headers: { ...baseHeaders, Prefer: 'return=representation' } },
      );

      const newId =
        respBody?.contactid ||
        extractIdFromODataEntityId(respHeaders?.['odata-entityid']) ||
        extractIdFromODataEntityId(respHeaders?.['OData-EntityId']);

      return { targetId: newId, action: 'create' };
    } else {
      // ── Update ─────────────────────────────────────────────────────────────
      if (!UUID_RE.test(targetId)) {
        throw new Error(`[writers/dynamics] Invalid targetId format: expected UUID`);
      }
      await axios.patch(`${contactsUrl}(${targetId})`, fields, { headers: baseHeaders });
      return { targetId, action: 'update' };
    }
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn(
        { attempt: _attempt + 1, waitMs },
        '[writers/dynamics] 429 rate-limited — backing off',
      );
      await sleep(waitMs);
      return writeToDynamics(data, token, _attempt + 1);
    }
    throw err;
  }
}

/**
 * Write an account to Dynamics CRM.
 * Mirrors writeToDynamics but targets the /accounts entity set.
 *
 * @param {object} data   - Mapped account fields + `action` + `targetId`
 * @param {string} token  - Bearer token
 * @param {number} [_attempt]
 * @returns {Promise<{ targetId: string|null, action: string }>}
 */
async function writeDynamicsAccount(data, token, _attempt = 0) {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[writers/dynamics] DYNAMICS_RESOURCE_URL not set');
  const API_VERSION = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';

  const { action, targetId, ...fields } = data;
  const baseHeaders = {
    Authorization:      `Bearer ${token}`,
    'Content-Type':     'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
  };
  const accountsUrl = `${resourceUrl}/api/data/v${API_VERSION}/accounts`;

  try {
    if (!targetId || action === 'create') {
      const { data: respBody, headers: respHeaders } = await axios.post(
        accountsUrl,
        fields,
        { headers: { ...baseHeaders, Prefer: 'return=representation' } },
      );
      const newId =
        respBody?.accountid ||
        extractIdFromODataEntityId(respHeaders?.['odata-entityid']) ||
        extractIdFromODataEntityId(respHeaders?.['OData-EntityId']);
      return { targetId: newId, action: 'create' };
    } else {
      if (!UUID_RE.test(targetId)) {
        throw new Error('[writers/dynamics] Invalid account targetId format: expected UUID');
      }
      await axios.patch(`${accountsUrl}(${targetId})`, fields, { headers: baseHeaders });
      return { targetId, action: 'update' };
    }
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn(
        { attempt: _attempt + 1, waitMs },
        '[writers/dynamics] 429 rate-limited (account) — backing off',
      );
      await sleep(waitMs);
      return writeDynamicsAccount(data, token, _attempt + 1);
    }
    throw err;
  }
}

/**
 * Patch a single field onto a Dynamics Contact. Used by the Marketo-id
 * round-trip correlation (Task 14) to stamp `ubt_marketoid` on a Contact
 * after a successful CRM→Marketo write.
 *
 * @param {{ contactId: string, marketoId: string, token: string }} args
 * @returns {Promise<void>}
 */
async function stampMarketoIdOnContact({ contactId, marketoId, token }) {
  if (!contactId || !UUID_RE.test(contactId)) {
    throw new Error('[writers/dynamics] stampMarketoIdOnContact: contactId must be a GUID');
  }
  if (!marketoId) return; // nothing to stamp

  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[writers/dynamics] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';

  const url = `${resourceUrl}/api/data/v${apiVersion}/contacts(${contactId})`;
  await axios.patch(url, { ubt_marketoid: String(marketoId) }, {
    headers: {
      Authorization:      `Bearer ${token}`,
      'Content-Type':     'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version':    '4.0',
      Accept:             'application/json',
    },
  });
}

module.exports = { writeToDynamics, writeDynamicsAccount, stampMarketoIdOnContact };
