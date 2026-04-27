'use strict';

const axios = require('axios');
const { getConfig } = require('../config/loader');
const logger = require('../audit/logger');

const TTL_MS = 60 * 60 * 1000; // 1 hour
// Map<entity|field, { at: number, labelToValue: Map<string,number>, valueToLabel: Map<number,string> }>
const _cache = new Map();

async function dynamicsBase() {
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[optionSetResolver] DYNAMICS_RESOURCE_URL not set');
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

function cacheKey(entity, field) {
  return `${entity}|${field}`;
}

async function fetchOptions(entity, field, token) {
  const base = await dynamicsBase();
  const url  = `${base}/EntityDefinitions(LogicalName='${entity}')`
             + `/Attributes(LogicalName='${field}')`
             + `/Microsoft.Dynamics.CRM.PicklistAttributeMetadata`;
  const { data } = await axios.get(url, {
    headers: headers(token),
    params:  { $expand: 'OptionSet' },
  });

  const opts = data?.OptionSet?.Options || [];
  const labelToValue = new Map();
  const valueToLabel = new Map();
  for (const opt of opts) {
    const label = opt?.Label?.UserLocalizedLabel?.Label
               ?? opt?.Label?.LocalizedLabels?.[0]?.Label
               ?? null;
    const value = typeof opt.Value === 'number' ? opt.Value : null;
    if (label == null || value == null) continue;
    labelToValue.set(label, value);
    valueToLabel.set(value, label);
  }
  return { labelToValue, valueToLabel };
}

async function getMaps(entity, field, token) {
  const key = cacheKey(entity, field);
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit;
  const fresh = await fetchOptions(entity, field, token);
  const entry = { at: Date.now(), ...fresh };
  _cache.set(key, entry);
  return entry;
}

/**
 * Resolve a choice label → integer value for the given entity+field.
 *
 * @param {string} entity   Entity logical name (e.g. 'contact', 'account', 'lead')
 * @param {string} field    Attribute logical name (e.g. 'ubt_accounttype')
 * @param {string} label    Human label from the source record
 * @param {string} token    Bearer token for Dataverse
 * @returns {Promise<number|null>} null when the label is not in the option set
 */
async function resolveOption(entity, field, label, token) {
  if (label == null || label === '') return null;
  if (typeof label === 'number') return label; // already an option value
  try {
    const { labelToValue } = await getMaps(entity, field, token);
    const v = labelToValue.get(label);
    return v != null ? v : null;
  } catch (err) {
    logger.warn(
      { entity, field, err: err.message },
      '[optionSetResolver] failed to fetch option metadata',
    );
    return null;
  }
}

/** Reverse lookup (value → label). Used by Lead state/status projection. */
async function resolveLabel(entity, field, value, token) {
  if (value == null) return null;
  try {
    const { valueToLabel } = await getMaps(entity, field, token);
    return valueToLabel.get(Number(value)) || null;
  } catch {
    return null;
  }
}

/** Test helper. */
function _resetCache() { _cache.clear(); }

module.exports = { resolveOption, resolveLabel, _resetCache };
