'use strict';

/**
 * Marketo Lead-schema helpers.
 *
 * Used by:
 *   - `src/writers/marketo.js` for the auto-filter that drops unknown fields
 *     from a Lead push (so a tenant without `crmEntityType` etc. doesn't
 *     reject the whole record with error 1006).
 *   - `src/routes/marketoSetup.js` for the Admin → Set up Marketo fields
 *     button in the SPA.
 *   - `scripts/marketo-create-custom-fields.js` for the same op via CLI.
 */

const axios = require('axios');
const { getConfig } = require('../config/loader');
const { getMarketoToken } = require('./marketo');

/**
 * The custom Lead fields the integration depends on for the Contact-vs-Lead
 * differentiator. Stable contract — adding more later is fine, but don't
 * remove without a migration plan.
 */
const REQUIRED_LEAD_FIELDS = Object.freeze([
  {
    name:        'crmEntityType',
    displayName: 'CRM Entity Type',
    dataType:    'string',
    description: 'Source CRM entity classification — "contact" or "lead".',
  },
  {
    name:        'crmContactId',
    displayName: 'CRM Contact ID',
    dataType:    'string',
    description: 'Dynamics CRM contactid GUID (set when source entity is a Contact).',
  },
  {
    name:        'crmLeadId',
    displayName: 'CRM Lead ID',
    dataType:    'string',
    description: 'Dynamics CRM leadid GUID (set when source entity is a Lead).',
  },
]);

/**
 * Fetch the Marketo Lead schema and return a Set of REST-API field names.
 * Returns null on any failure (the caller decides what to do — typically
 * "no schema, no filter").
 */
async function fetchLeadSchemaFields({ baseUrl, token } = {}) {
  if (!baseUrl) baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!token)   token   = await getMarketoToken();
  if (!baseUrl || !token) return null;

  try {
    const { data } = await axios.get(
      `${baseUrl}/rest/v1/leads/describe.json`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!data || !data.success) return null;
    const names = new Set();
    for (const f of (data.result || [])) {
      const n = f && f.rest && f.rest.name;
      if (n) names.add(n);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Compare the live schema against REQUIRED_LEAD_FIELDS. Returns
 * `{ ready, missing, present }` where `missing` is the list of required
 * field names not yet in the schema.
 */
async function getSchemaStatus({ baseUrl, token } = {}) {
  const schema = await fetchLeadSchemaFields({ baseUrl, token });
  if (!schema) {
    return {
      ready:   false,
      missing: REQUIRED_LEAD_FIELDS.map(f => f.name),
      present: [],
      schemaAccessible: false,
    };
  }
  const missing = [];
  const present = [];
  for (const f of REQUIRED_LEAD_FIELDS) {
    if (schema.has(f.name)) present.push(f.name);
    else                    missing.push(f.name);
  }
  return { ready: missing.length === 0, missing, present, schemaAccessible: true };
}

/**
 * Create one or more custom Lead fields. Idempotent via Marketo's
 * `1009: Field already exists` per-record skip — we treat that as success
 * with status 'already-exists'.
 *
 * Requires the Marketo API user to hold the
 * "Read-Write Schema Custom Fields" permission. 401/403 surface verbatim.
 *
 * @param {{ fields?: Array, baseUrl?: string, token?: string }} args
 * @returns {Promise<{ created:number, alreadyExisted:number, failed:number,
 *                     results: Array<{ name, status, error? }> }>}
 */
async function createCustomFields({ fields, baseUrl, token } = {}) {
  if (!fields) fields = REQUIRED_LEAD_FIELDS;
  if (!baseUrl) baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!token)   token   = await getMarketoToken();
  if (!baseUrl) throw new Error('[marketoSchema] MARKETO_BASE_URL not set');
  if (!token)   throw new Error('[marketoSchema] could not obtain Marketo token');

  let created = 0;
  let alreadyExisted = 0;
  let failed = 0;
  const results = [];

  let bailedOnPermission = false;
  for (const field of fields) {
    if (bailedOnPermission) {
      // Once we know the API user can't write schema, skip remaining
      // fields rather than firing the same denial three times.
      failed += 1;
      results.push({
        name:         field.name,
        status:       'failed',
        error:        '603: Access denied (schema-write permission missing)',
        accessDenied: true,
      });
      continue;
    }
    try {
      const { data } = await axios.post(
        `${baseUrl}/rest/v1/leads/schema/fields.json`,
        { input: [field] },
        {
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!data.success) {
        const errors = data.errors || [];
        // Marketo error code 603 = "Access denied" — typically the API user
        // is missing the "Read-Write Schema Custom Fields" role permission.
        // Marketo returns HTTP 200 with success:false, so we surface this
        // ourselves rather than relying on the HTTP layer.
        const permDenied = errors.some(e => String(e.code) === '603');
        failed += 1;
        results.push({
          name:         field.name,
          status:       'failed',
          error:        errors.map(e => `${e.code}:${e.message}`).join('; ') || JSON.stringify(errors),
          accessDenied: permDenied || undefined,
          httpStatus:   permDenied ? 403 : undefined,
        });
        if (permDenied) bailedOnPermission = true;
        continue;
      }

      const hit = data.result?.[0];
      if (!hit) {
        failed += 1;
        results.push({ name: field.name, status: 'failed', error: 'empty result' });
        continue;
      }

      const reasons = Array.isArray(hit.reasons) ? hit.reasons : [];
      const alreadyExists = reasons.some(
        r => String(r.code) === '1009' || /already exists/i.test(r.message || ''),
      );

      if (hit.status === 'created') {
        created += 1;
        results.push({ name: field.name, status: 'created' });
      } else if (alreadyExists || hit.status === 'skipped') {
        alreadyExisted += 1;
        results.push({ name: field.name, status: 'already-exists' });
      } else {
        failed += 1;
        const msg = reasons.map(r => `${r.code}:${r.message}`).join('; ') || hit.status;
        results.push({ name: field.name, status: 'failed', error: msg });
      }
    } catch (err) {
      failed += 1;
      const status = err.response?.status;
      const detail = err.response?.data?.errors
        ? JSON.stringify(err.response.data.errors)
        : err.message;
      results.push({
        name: field.name,
        status: 'failed',
        error: status ? `HTTP ${status}: ${detail}` : detail,
        httpStatus: status,
      });
      // 401/403 typically means schema-write permission is missing; bail
      // since every subsequent field will fail the same way.
      if (status === 401 || status === 403) break;
    }
  }

  return { created, alreadyExisted, failed, results };
}

module.exports = {
  REQUIRED_LEAD_FIELDS,
  fetchLeadSchemaFields,
  getSchemaStatus,
  createCustomFields,
};
