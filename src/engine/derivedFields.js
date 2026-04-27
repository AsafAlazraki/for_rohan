'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');
const fieldmap = require('../config/fieldmap.json');
const logger = require('../audit/logger');

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[derivedFields] DYNAMICS_RESOURCE_URL not set');
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

// ── Built-in derivations ─────────────────────────────────────────────────────

/**
 * Contact → Account → ubt_accounttype.
 * If readers/dynamics has already $expand=parentcustomerid_account on the
 * record, the flattened value wins. Otherwise GET /accounts({id})?$select=ubt_accounttype
 * using record._parentcustomerid_value.
 */
async function parentAccountType({ record, token }) {
  const flat = record?.parentcustomerid_account?.ubt_accounttype
            ?? record?.['parentcustomerid_account.ubt_accounttype'];
  if (flat != null && flat !== '') return flat;

  const parentId = record?._parentcustomerid_value;
  if (!parentId || !token) return null;

  const base = await dynamicsBase();
  try {
    const { data } = await axios.get(`${base}/accounts(${parentId})`, {
      headers: headers(token),
      params:  { $select: 'ubt_accounttype' },
    });
    return data?.ubt_accounttype ?? null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Return `true` when the current contact is the Primary Contact on its parent
 * account. Compares `record.contactid` with `parentAccount.primarycontactid`.
 */
async function primaryContactFlag({ record, token }) {
  const parentId   = record?._parentcustomerid_value;
  const contactId  = record?.contactid;
  if (!parentId || !contactId || !token) return false;

  const base = await dynamicsBase();
  try {
    const { data } = await axios.get(`${base}/accounts(${parentId})`, {
      headers: headers(token),
      params:  { $select: '_primarycontactid_value' },
    });
    return data?._primarycontactid_value === contactId;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

/**
 * Resolve the parent Account's `name` for a Contact record so the projected
 * Marketo Lead carries a `company` value. Tries fastest path first:
 *   1. `record.company`         — set by readers/dynamics flatten step
 *   2. `record.parentcustomerid_account.name` — raw $expand shape
 *   3. fetch /accounts({id})?$select=name using `_parentcustomerid_value`
 *
 * Returns null if no parent is referenced. Used by the contact entity's
 * `company` field mapping.
 */
async function parentAccountName({ record, token }) {
  if (record?.company && typeof record.company === 'string') return record.company;
  const flat = record?.parentcustomerid_account?.name;
  if (flat) return flat;

  const parentId = record?._parentcustomerid_value;
  if (!parentId || !token) return null;

  const base = await dynamicsBase();
  try {
    const { data } = await axios.get(`${base}/accounts(${parentId})`, {
      headers: headers(token),
      params:  { $select: 'name' },
    });
    return data?.name ?? null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

const RESOLVERS = Object.freeze({
  parentAccountType,
  primaryContactFlag,
  parentAccountName,
});

/**
 * Execute a single derivation.
 *
 * @param {{ derivation: string, record: object, token?: string }} args
 * @returns {Promise<any>}
 */
async function resolveDerived({ derivation, record, token }) {
  const fn = RESOLVERS[derivation];
  if (!fn) throw new Error(`[derivedFields] unknown derivation: "${derivation}"`);
  return fn({ record, token });
}

/**
 * Enrich a mapped projection with every derived field declared on the given
 * entity's `crmToMarketo` entry. Mutates and returns `mapped`. Never throws
 * for a single resolver failure — logs + continues.
 *
 * @param {object} mapped    Existing Marketo-projection object.
 * @param {object} record    Source Dynamics record.
 * @param {'contact'|'lead'|'account'} entityType
 * @param {string} [token]
 * @returns {Promise<object>} The same `mapped` object.
 */
async function enrichDerived(mapped, record, entityType, token) {
  const mapping = fieldmap?.crmToMarketo?.[entityType];
  if (!mapping) return mapped;

  for (const [targetField, entry] of Object.entries(mapping)) {
    if (entry.type !== 'derived') continue;
    // Some derivations are only meaningful for specific entity types. The
    // primaryContactFlag derives whether a Contact is the Account's primary
    // contact — skip it for non-Contact entity syncs to avoid emitting the
    // field for Leads (which do not have this concept).
    if (entry.derivation === 'primaryContactFlag' && entityType !== 'contact') continue;
    try {
      const value = await resolveDerived({
        derivation: entry.derivation,
        record,
        token,
      });
      if (value !== null && value !== undefined && value !== '') {
        mapped[targetField] = value;
      }
    } catch (err) {
      logger.warn(
        { derivation: entry.derivation, entityType, err: err.message },
        '[derivedFields] resolver failed — skipping field',
      );
    }
  }
  return mapped;
}

module.exports = { resolveDerived, enrichDerived, _RESOLVERS: RESOLVERS };
