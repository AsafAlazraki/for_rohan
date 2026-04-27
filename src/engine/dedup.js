'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');

// Escape single-quotes for OData $filter strings to prevent injection
function oDataEscape(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Search Marketo for a lead by email.
 * @param {string} email
 * @param {string} token  - Bearer token
 * @returns {Promise<{ action: 'create'|'update', targetId: string|null }>}
 */
async function resolveMarketo(email, token) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[dedup] MARKETO_BASE_URL not set');

  const { data } = await axios.get(`${baseUrl}/rest/v1/leads.json`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      filterType:   'email',
      filterValues: email,
      fields:       'id,email',
    },
  });

  if (!data.success) {
    throw new Error(`[dedup] Marketo search failed: ${JSON.stringify(data.errors)}`);
  }

  const hit = data.result && data.result.length > 0 ? data.result[0] : null;
  return {
    action:   hit ? 'update' : 'create',
    targetId: hit ? String(hit.id) : null,
  };
}

/**
 * Search Dynamics for a contact by email.
 * @param {string} email
 * @param {string} token  - Bearer token
 * @returns {Promise<{ action: 'create'|'update', targetId: string|null }>}
 */
async function resolveDynamics(email, token) {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[dedup] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';

  const { data } = await axios.get(
    `${resourceUrl}/api/data/v${apiVersion}/contacts`,
    {
      headers: {
        Authorization:   `Bearer ${token}`,
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Accept:             'application/json',
      },
      params: {
        $filter: `emailaddress1 eq '${oDataEscape(email)}'`,
        $select: 'contactid,emailaddress1',
        $top:    1,
      },
    },
  );

  const records = data.value || [];
  const hit     = records.length > 0 ? records[0] : null;
  return {
    action:   hit ? 'update' : 'create',
    targetId: hit ? hit.contactid : null,
  };
}

/**
 * Determine whether to create or update a record in the target system
 * by searching for an existing record with the same email address.
 *
 * @param {string}                   email
 * @param {'marketo'|'dynamics'}     targetSystem
 * @param {string}                   token
 * @returns {Promise<{ action: 'create'|'update', targetId: string|null }>}
 */
async function resolveAction(email, targetSystem, token) {
  if (!email)        throw new Error('[dedup] resolveAction: email is required');
  if (!token)        throw new Error('[dedup] resolveAction: token is required');
  if (!targetSystem) throw new Error('[dedup] resolveAction: targetSystem is required');

  if (targetSystem === 'marketo')  return resolveMarketo(email, token);
  if (targetSystem === 'dynamics') return resolveDynamics(email, token);

  throw new Error(`[dedup] resolveAction: unknown targetSystem "${targetSystem}"`);
}

/**
 * Resolve create-vs-update for an account by name (Dynamics) or
 * company (Marketo).
 *
 * @param {string} name
 * @param {'dynamics'|'marketo'} targetSystem
 * @param {string} token
 * @returns {Promise<{ action: 'create'|'update', targetId: string|null }>}
 */
async function resolveAccountAction(name, targetSystem, token) {
  if (!name) throw new Error('[dedup] resolveAccountAction: name is required');
  if (!token) throw new Error('[dedup] resolveAccountAction: token is required');

  if (targetSystem === 'marketo') {
    const baseUrl = await getConfig('MARKETO_BASE_URL');
    if (!baseUrl) throw new Error('[dedup] MARKETO_BASE_URL not set');
    const { data } = await axios.get(`${baseUrl}/rest/v1/companies.json`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { filterType: 'company', filterValues: name, fields: 'id,company' },
    });
    if (!data.success) {
      // Marketo returns success:false for "no results" in some accounts — treat as create
      return { action: 'create', targetId: null };
    }
    const hit = data.result?.[0] || null;
    return {
      action:   hit ? 'update' : 'create',
      targetId: hit ? String(hit.id) : null,
    };
  }

  if (targetSystem === 'dynamics') {
    const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
    if (!resourceUrl) throw new Error('[dedup] DYNAMICS_RESOURCE_URL not set');
    const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
    const { data } = await axios.get(
      `${resourceUrl}/api/data/v${apiVersion}/accounts`,
      {
        headers: {
          Authorization:      `Bearer ${token}`,
          'OData-MaxVersion': '4.0',
          'OData-Version':    '4.0',
          Accept:             'application/json',
        },
        params: {
          $filter: `name eq '${oDataEscape(name)}'`,
          $select: 'accountid,name',
          $top:    1,
        },
      },
    );
    const records = data.value || [];
    const hit     = records.length > 0 ? records[0] : null;
    return {
      action:   hit ? 'update' : 'create',
      targetId: hit ? hit.accountid : null,
    };
  }

  throw new Error(`[dedup] resolveAccountAction: unknown targetSystem "${targetSystem}"`);
}

module.exports = { resolveAction, resolveAccountAction };
