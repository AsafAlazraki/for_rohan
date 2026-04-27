'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');
const { getDynamicsToken } = require('../auth/dynamics');
const logger = require('../audit/logger');

const ENTITY_SETS = {
  contact: 'contacts',
  lead:    'leads',
  account: 'accounts',
};

const SELECT_FIELDS = {
  contact: [
    'contactid','emailaddress1','firstname','lastname','telephone1',
    'jobtitle','_parentcustomerid_value','address1_city',
    'address1_stateorprovince','address1_country','address1_postalcode',
    'leadsourcecode',
  ],
  lead: [
    'leadid','emailaddress1','firstname','lastname','telephone1',
    'jobtitle','companyname','address1_city','address1_stateorprovince',
    'address1_country','address1_postalcode',
    'leadsourcecode',
  ],
  account: [
    'accountid','name','accountnumber','websiteurl','telephone1','industrycode',
    'numberofemployees','revenue','address1_line1','address1_city',
    'address1_stateorprovince','address1_country','address1_postalcode',
    // Custom ubt_* fields read by the bundle-sync mapper. Listed explicitly so
    // OData $select includes them; missing ones are silently null on the wire.
    'ubt_eprofile','ubt_accounttype','ubt_markettype','ubt_tradingmodel',
    '_ubt_keyaccountmanager_value','_ubt_industryclassification_value',
  ],
};

const FORMATTED_VALUE_ANNOTATION = '@OData.Community.Display.V1.FormattedValue';

// Contact has no native 'companyname' in Dataverse — the employer is the
// related account reached via parentcustomerid. We $expand it and flatten
// the account name into a synthetic 'company' field so downstream code
// (field mapper, dashboard) treats a contact the same as a lead.
const EXPAND = {
  contact: 'parentcustomerid_account($select=name)',
};

/**
 * Read a page of records from Dynamics via OData.
 * Uses $top + $skiptoken for paging; if no cursor is given, starts at the beginning.
 *
 * @param {object} opts
 * @param {'contact'|'lead'|'account'} opts.entity
 * @param {number} [opts.limit=10]
 * @param {string|null} [opts.cursor] - opaque $skiptoken passed back from a prior call
 * @returns {Promise<{ rows: object[], nextCursor: string|null }>}
 */
async function readDynamics({ entity, limit = 10, cursor = null }) {
  const set = ENTITY_SETS[entity];
  if (!set) throw new Error(`[readers/dynamics] unknown entity: ${entity}`);

  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('DYNAMICS_RESOURCE_URL not configured');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  const token = await getDynamicsToken();

  const select = SELECT_FIELDS[entity].join(',');
  // Restrict to active records (statecode = 0) so Pull mirrors the default
  // Sales Hub views, which hide deactivated rows.
  // Do not set $top here; rely on the Prefer header's odata.maxpagesize
  // so Dataverse may include an '@odata.nextLink' for server-driven paging.
  const params = {
    '$select': select,
    '$filter': 'statecode eq 0',
  };
  if (EXPAND[entity]) params['$expand'] = EXPAND[entity];
  if (cursor) params['$skiptoken'] = cursor;

  const url = `${resourceUrl}/api/data/v${apiVersion}/${set}`;
  let res;
  const preferHeader = `odata.maxpagesize=${limit}, odata.include-annotations="OData.Community.Display.V1.FormattedValue"`;
  try {
    res = await axios.get(url, {
      params,
      headers: {
        Authorization:      `Bearer ${token}`,
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Accept:             'application/json',
        // Two preferences in one header — Dataverse honours both.
        // include-annotations gives us '<field>@OData.Community.Display.V1.FormattedValue'
        // siblings on each row, which the picklist-flatten step below turns
        // into stable '<field>_label' fields downstream code can map.
        Prefer:             preferHeader,
      },
    });
  } catch (e) {
    const status = e.response?.status;
    const odataMsg = e.response?.data?.error?.message;
    const body = e.response?.data;
    logger.error({ url, params, status, odataMsg, body }, '[readers/dynamics] request failed');
    if (odataMsg) throw new Error(`Dynamics ${status}: ${odataMsg}`);
    throw e;
  }

  const data = res.data;
  const rawRows = Array.isArray(data?.value) ? data.value : [];
  const rows = rawRows
    .map(flattenFormattedValues)
    .map(entity === 'contact' ? flattenContactCompany : (r => r));
  const nextLink = data?.['@odata.nextLink'] || null;
  let nextCursor = null;
  if (nextLink) {
    const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/);
    if (match) nextCursor = decodeURIComponent(match[1]);
  }

  logger.info(
    {
      url,
      params,
      preferHeader,
      status: res.status,
      rowCount: rows.length,
      hasValueArray: Array.isArray(data?.value),
      bodyKeys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
      hasNextLink: Boolean(nextLink),
    },
    '[readers/dynamics] request succeeded',
  );

  const out = { rows, nextCursor };
  if (rows.length === 0 && !cursor) {
    // HTTP 200 + empty page is almost always "no matching records". Auth /
    // permission failures surface as 401/403 and wouldn't reach this branch.
    // Present the empty result as informational; keep the admin troubleshooting
    // hints off the happy path.
    out.note = `No ${entity}s found in this Dynamics environment.`;
    out.troubleshooting = [
      `If you expected results, verify:`,
      `• Records actually exist in the target environment (try opening one in Dynamics UI).`,
      `• DYNAMICS_RESOURCE_URL points at the right environment.`,
      `• The Azure AD app user has a Dataverse security role with row-level read access.`,
    ].join('\n');
  }
  return out;
}

/**
 * Flatten the expanded parent account on a contact row into a top-level
 * `company` field. Leaves `parentcustomerid_account` in place so callers
 * that want the raw GUID still have it, but drops the nested object to
 * keep payloads JSON-small when logged.
 */
function flattenContactCompany(row) {
  if (!row || typeof row !== 'object') return row;
  const expanded = row.parentcustomerid_account;
  const out = { ...row };
  if (expanded && typeof expanded === 'object') {
    if (expanded.name) out.company = expanded.name;
    delete out.parentcustomerid_account;
  }
  return out;
}

/**
 * For every key on the row that ends in
 * '@OData.Community.Display.V1.FormattedValue', synthesise a sibling
 * '<field>_label' carrying the human-readable string. Removes the noisy
 * annotation key after copying so logged payloads stay tidy.
 *
 * Picklists, money fields, and lookup-display-names all surface this way.
 * Downstream mappers can treat the '_label' as a plain string field.
 */
function flattenFormattedValues(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of Object.keys(row)) {
    if (key.endsWith(FORMATTED_VALUE_ANNOTATION)) {
      const baseField = key.slice(0, -FORMATTED_VALUE_ANNOTATION.length);
      if (baseField) out[`${baseField}_label`] = row[key];
      delete out[key];
    }
  }
  return out;
}

/**
 * Read a single Dynamics record by id, with the same flattening as the list
 * reader. Returns null on 404. Used by the bundle-sync flow which fetches a
 * specific Contact/Lead/Account by GUID.
 *
 * @param {{ entity: 'contact'|'lead'|'account', id: string }} opts
 * @returns {Promise<object|null>}
 */
async function readDynamicsById({ entity, id }) {
  const set = ENTITY_SETS[entity];
  if (!set) throw new Error(`[readers/dynamics] unknown entity: ${entity}`);
  if (!id) throw new Error('[readers/dynamics] readDynamicsById: id required');

  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('DYNAMICS_RESOURCE_URL not configured');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  const token = await getDynamicsToken();

  const select = SELECT_FIELDS[entity].join(',');
  const params = { '$select': select };
  if (EXPAND[entity]) params['$expand'] = EXPAND[entity];

  const url = `${resourceUrl}/api/data/v${apiVersion}/${set}(${encodeURIComponent(id)})`;
  let res;
  try {
    res = await axios.get(url, {
      params,
      headers: {
        Authorization:      `Bearer ${token}`,
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Accept:             'application/json',
        Prefer:             'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
      },
    });
  } catch (e) {
    if (e.response?.status === 404) return null;
    const status = e.response?.status;
    const odataMsg = e.response?.data?.error?.message;
    logger.error({ url, status, odataMsg }, '[readers/dynamics.byId] request failed');
    if (odataMsg) throw new Error(`Dynamics ${status}: ${odataMsg}`);
    throw e;
  }

  let row = res.data || null;
  if (row) {
    row = flattenFormattedValues(row);
    if (entity === 'contact') row = flattenContactCompany(row);
  }
  return row;
}

module.exports = { readDynamics, readDynamicsById, flattenContactCompany, flattenFormattedValues };
