'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');

function oDataEscape(value) {
  return String(value).replace(/'/g, "''");
}

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[accountResolver] DYNAMICS_RESOURCE_URL not set');
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

async function fetchAccountById(base, id, token) {
  try {
    const { data } = await axios.get(`${base}/accounts(${id})`, {
      headers: headers(token),
      params:  { $select: 'accountid,statecode' },
    });
    if (data && data.accountid && data.statecode === 0) return data.accountid;
    return null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

async function findAccountByFilter(base, filter, token) {
  const { data } = await axios.get(`${base}/accounts`, {
    headers: headers(token),
    params:  {
      $filter: `${filter}`,
      $select: 'accountid',
      $top:    1,
    },
  });
  const rec = data?.value?.[0];
  return rec ? rec.accountid : null;
}

/**
 * Resolve a D365 Account by the spec's priority order:
 *   accountid → accountnumber → NetSuite ID → name
 *
 * Pure resolver — never creates records. Caller decides whether to create
 * on miss. (Marketo-sourced paths must never auto-create accounts.)
 *
 * The NetSuite field logical name is configurable via admin key
 * `ACCOUNT_NETSUITE_FIELD` (default: `cr_netsuiteid`). If the config
 * returns empty, that fallback step is skipped.
 *
 * @param {{ ids: { accountid?: string, accountnumber?: string,
 *                  netsuiteId?: string, name?: string },
 *           token: string }} args
 * @returns {Promise<{ targetId: string|null,
 *                     matchedBy: 'accountid'|'accountnumber'|'netsuite'|'name'|null }>}
 */
async function resolveAccount({ ids = {}, token }) {
  if (!token) throw new Error('[accountResolver] token is required');
  const base = await dynamicsBase();

  // Tier 1: accountid (GUID)
  if (ids.accountid) {
    const id = await fetchAccountById(base, ids.accountid, token);
    if (id) return { targetId: id, matchedBy: 'accountid' };
  }

  // Tier 2: accountnumber
  if (ids.accountnumber) {
    const id = await findAccountByFilter(
      base,
      `accountnumber eq '${oDataEscape(ids.accountnumber)}'`,
      token,
    );
    if (id) return { targetId: id, matchedBy: 'accountnumber' };
  }

  // Tier 3: NetSuite ID (configurable field, default cr_netsuiteid)
  if (ids.netsuiteId) {
    const netsuiteField = (await getConfig('ACCOUNT_NETSUITE_FIELD')) || 'cr_netsuiteid';
    if (netsuiteField) {
      const id = await findAccountByFilter(
        base,
        `${netsuiteField} eq '${oDataEscape(ids.netsuiteId)}'`,
        token,
      );
      if (id) return { targetId: id, matchedBy: 'netsuite' };
    }
  }

  // Tier 4: name (last-resort fuzzy-ish match; exact-equal only)
  if (ids.name) {
    const id = await findAccountByFilter(
      base,
      `name eq '${oDataEscape(ids.name)}'`,
      token,
    );
    if (id) return { targetId: id, matchedBy: 'name' };
  }

  return { targetId: null, matchedBy: null };
}

module.exports = { resolveAccount };
