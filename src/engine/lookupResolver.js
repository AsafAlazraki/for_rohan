'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');
const logger = require('../audit/logger');

const TTL_MS = 15 * 60 * 1000; // 15 min
const _cache = new Map(); // Map<entitySet|naturalKey|value, { at, id }>

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[lookupResolver] DYNAMICS_RESOURCE_URL not set');
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

function oDataEscape(v) {
  return String(v).replace(/'/g, "''");
}

// Map entitySet → (idField, naturalKey) defaults. Extend as needed.
const ENTITY_DEFAULTS = Object.freeze({
  ubt_countries:              { idField: 'ubt_countryid',            naturalKey: 'ubt_name' },
  ubt_industryclassifications: { idField: 'ubt_industryclassificationid', naturalKey: 'ubt_name' },
  systemusers:                { idField: 'systemuserid',             naturalKey: 'fullname' },
  businessunits:              { idField: 'businessunitid',           naturalKey: 'name' },
});

function normalize(entitySet, entry) {
  const defaults = ENTITY_DEFAULTS[entitySet] || {};
  return {
    entitySet,
    idField:    entry.idField    || defaults.idField,
    naturalKey: entry.naturalKey || defaults.naturalKey,
  };
}

/**
 * Resolve a natural-key value to a GUID for the given entitySet, caching the
 * result for 15 minutes.
 *
 * @param {{ entitySet: string, idField?: string, naturalKey?: string,
 *           value: string, token: string }} args
 * @returns {Promise<string|null>}
 */
async function resolveLookup({ entitySet, idField, naturalKey, value, token }) {
  if (value == null || value === '') return null;
  if (!entitySet) throw new Error('[lookupResolver] entitySet required');

  const n = normalize(entitySet, { idField, naturalKey });
  if (!n.idField || !n.naturalKey) {
    throw new Error(`[lookupResolver] idField + naturalKey required for entitySet "${entitySet}"`);
  }

  const key = `${entitySet}|${n.naturalKey}|${value}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.id;

  try {
    const base = await dynamicsBase();
    const { data } = await axios.get(`${base}/${entitySet}`, {
      headers: headers(token),
      params:  {
        $filter: `${n.naturalKey} eq '${oDataEscape(value)}'`,
        $select: n.idField,
        $top:    1,
      },
    });
    const rec = data?.value?.[0];
    const id  = rec ? rec[n.idField] : null;
    _cache.set(key, { at: Date.now(), id });
    return id;
  } catch (err) {
    logger.warn(
      { entitySet, naturalKey: n.naturalKey, value, err: err.message },
      '[lookupResolver] query failed',
    );
    return null;
  }
}

function _resetCache() { _cache.clear(); }

module.exports = { resolveLookup, _resetCache, ENTITY_DEFAULTS };
