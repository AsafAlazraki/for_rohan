'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');

function oDataEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[personResolver] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  return `${resourceUrl}/api/data/v${apiVersion}`;
}

function headers(token) {
  return {
    Authorization:      `Bearer ${token}`,
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
  };
}

// Fetch a single contact/lead by GUID, returning null on 404 or inactive.
async function fetchById(base, entitySet, idField, id, token) {
  try {
    const url = `${base}/${entitySet}(${id})`;
    const { data } = await axios.get(url, {
      headers: headers(token),
      params:  { $select: `${idField},statecode` },
    });
    if (data && data[idField] && data.statecode === 0) return data[idField];
    return null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

async function matchByMarketoId(base, entitySet, idField, marketoId, token) {
  const url = `${base}/${entitySet}`;
  const { data } = await axios.get(url, {
    headers: headers(token),
    params:  {
      $filter: `ubt_marketoid eq '${oDataEscape(marketoId)}'`,
      $select: idField,
      $top:    1,
    },
  });
  const rec = data?.value?.[0];
  return rec ? rec[idField] : null;
}

async function matchByEmail(base, entitySet, idField, emailField, email, token) {
  const url = `${base}/${entitySet}`;
  const { data } = await axios.get(url, {
    headers: headers(token),
    params:  {
      $filter: `${emailField} eq '${oDataEscape(email)}'`,
      $select: idField,
      $top:    1,
    },
  });
  const rec = data?.value?.[0];
  return rec ? rec[idField] : null;
}

/**
 * Resolve a Marketo Person to a Dynamics record (Contact or Lead).
 *
 * Lookup order:
 *   (1) ids.crmContactId → GET /contacts({id})?$select=contactid,statecode
 *       active → contact hit
 *   (2) ids.crmLeadId → same for /leads
 *   (3) ubt_marketoid on payload → search contacts then leads by ubt_marketoid
 *   (4) email → search contacts then leads by email
 *
 * Stale/deleted/inactive IDs fall through to the next tier.
 *
 * @param {{ ids?: { crmContactId?: string, crmLeadId?: string },
 *           email?: string,
 *           marketoId?: string|number,
 *           entityHint?: 'contact'|'lead',
 *           token: string,
 *           targetSystem?: 'dynamics' }} args
 * @returns {Promise<{ action: 'create'|'update',
 *                     entity: 'contact'|'lead'|null,
 *                     targetId: string|null,
 *                     matchedBy: 'id'|'marketoId'|'email'|null }>}
 */
async function resolvePerson({ ids = {}, email, marketoId, entityHint, token, targetSystem = 'dynamics' }) {
  if (!token) throw new Error('[personResolver] token is required');
  if (targetSystem !== 'dynamics') {
    throw new Error(`[personResolver] unsupported targetSystem "${targetSystem}"`);
  }

  const base = await dynamicsBase();

  // Tier 1: crmContactId
  if (ids.crmContactId) {
    const id = await fetchById(base, 'contacts', 'contactid', ids.crmContactId, token);
    if (id) return { action: 'update', entity: 'contact', targetId: id, matchedBy: 'id' };
  }

  // Tier 2: crmLeadId
  if (ids.crmLeadId) {
    const id = await fetchById(base, 'leads', 'leadid', ids.crmLeadId, token);
    if (id) return { action: 'update', entity: 'lead', targetId: id, matchedBy: 'id' };
  }

  // Tier 3: ubt_marketoid (Contact first, then Lead). entityHint can skip one side.
  if (marketoId != null && marketoId !== '') {
    const mId = String(marketoId);
    if (entityHint !== 'lead') {
      const cid = await matchByMarketoId(base, 'contacts', 'contactid', mId, token);
      if (cid) return { action: 'update', entity: 'contact', targetId: cid, matchedBy: 'marketoId' };
    }
    if (entityHint !== 'contact') {
      const lid = await matchByMarketoId(base, 'leads', 'leadid', mId, token);
      if (lid) return { action: 'update', entity: 'lead', targetId: lid, matchedBy: 'marketoId' };
    }
  }

  // Tier 4: email (Contact first, then Lead)
  if (email) {
    if (entityHint !== 'lead') {
      const cid = await matchByEmail(base, 'contacts', 'contactid', 'emailaddress1', email, token);
      if (cid) return { action: 'update', entity: 'contact', targetId: cid, matchedBy: 'email' };
    }
    if (entityHint !== 'contact') {
      const lid = await matchByEmail(base, 'leads', 'leadid', 'emailaddress1', email, token);
      if (lid) return { action: 'update', entity: 'lead', targetId: lid, matchedBy: 'email' };
    }
  }

  return { action: 'create', entity: null, targetId: null, matchedBy: null };
}

module.exports = { resolvePerson };
