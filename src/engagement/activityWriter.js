'use strict';

/**
 * Persists a Marketo engagement activity to Dynamics as a record on the
 * custom activity-enabled entity `ubt_marketingengagementactivity`. This
 * replaces the previous task-based writer so the data lands on the dedicated
 * entity described in spec #3 "Marketo API for Campaign Engagement Data"
 * §5.1 rather than being collapsed into `subject` / `description` JSON on an
 * OOTB `task`.
 *
 * Dataverse conventions mirrored from src/writers/dynamics.js and
 * src/engine/relationships.js — OData headers, 429 backoff, axios error
 * unwrapping, logical name for the entity is read from config so a tenant
 * that chose a different schema name can rewire at runtime without code
 * changes.
 *
 * Record shape (per §5.1):
 *   ubt_engagementtype        OptionSet  — Marketo activity type
 *   ubt_engagementdate        DateTime   — activity.activityDate
 *   ubt_assetname             Text       — activity.primaryAttributeValue
 *   ubt_campaignname          Text       — from activity.attributes (Campaign Name)
 *   ubt_campaignstatus        Text       — from activity.attributes (New Status / Success)
 *   ubt_url                   Text       — from activity.attributes (Link / Webpage URL)
 *   ubt_sourcesystem          Text       — literal "Marketo"
 *   ubt_externalactivityid    Text       — Marketo activity id (source of truth)
 *   regardingobjectid_contact Lookup     — contact match resolved by runner
 *   subject                   Text       — OOTB, required; "[Marketo: <Label>] <asset>"
 */

const axios  = require('axios');
const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');

const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_429_RETRIES        = 3;

// Default Dataverse entity set for the custom Marketing Engagement Activity
// entity. Overridable at runtime via admin_config key
// DYNAMICS_ENGAGEMENT_ENTITY_SET so a tenant that picked a different schema
// prefix can retarget without a redeploy.
const DEFAULT_ENTITY_SET     = 'ubt_marketingengagementactivities';
const DEFAULT_ENTITY_LOGICAL = 'ubt_marketingengagementactivity';

const TYPE_LABELS = {
  1:  'Web Visit',
  2:  'Form Submit',
  7:  'Email Delivered',
  9:  'Email Click',
  10: 'Email Open',
  14: 'Campaign Response',
};

// Stable option-set values for `ubt_engagementtype`. 900000000+ is the UBT
// convention for custom option sets (mirrors the pattern seen in
// src/config/fieldmap.json); labels match the ten values listed in spec
// §5.1 so the CRM admin can pre-populate the OptionSet ahead of go-live even
// though we only emit the six values the runner currently ingests.
const TYPE_TO_OPTION = {
  1:  900000005, // Web Visit
  2:  900000004, // Form Submit
  7:  900000001, // Email Delivered
  9:  900000003, // Email Click
  10: 900000002, // Email Open
  14: 900000000, // Campaign Response
};

// Extended label catalogue — everything the spec lists so the CRM admin can
// seed the option set with all ten values. Exported for docs + boot-check
// scripts; the runner only emits the six ingested types above.
const EXTENDED_OPTION_CATALOGUE = [
  { value: 900000000, label: 'Campaign Response' },
  { value: 900000001, label: 'Email Delivered' },
  { value: 900000002, label: 'Email Open' },
  { value: 900000003, label: 'Email Click' },
  { value: 900000004, label: 'Form Submit' },
  { value: 900000005, label: 'Web Visit' },
  { value: 900000006, label: 'Send Email' },
  { value: 900000007, label: 'Email Bounced' },
  { value: 900000008, label: 'Unsubscribed' },
  { value: 900000009, label: 'Email Reply' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryAfter(header) {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = parseInt(header, 10);
  return isNaN(secs) ? DEFAULT_RETRY_AFTER_MS : secs * 1000;
}

function extractIdFromODataEntityId(odataId) {
  if (!odataId) return null;
  const m = odataId.match(/\(([^)]+)\)$/);
  return m ? m[1] : null;
}

function unwrapAxiosError(err, prefix) {
  if (!err || !err.response) return err;
  const { status, data } = err.response;
  let detail;
  if (data && typeof data === 'object') {
    if (data.error?.message) detail = data.error.message;
    else if (Array.isArray(data.errors) && data.errors.length) {
      detail = data.errors.map(e => `${e.code || '?'}:${e.message || JSON.stringify(e)}`).join('; ');
    } else if (data.message) detail = data.message;
    else { try { detail = JSON.stringify(data); } catch { detail = String(data); } }
  } else if (typeof data === 'string' && data.trim()) {
    detail = data.trim().slice(0, 500);
  }
  const msg = detail
    ? `${prefix} HTTP ${status}: ${detail}`
    : `${prefix} HTTP ${status}`;
  const wrapped = new Error(msg);
  wrapped.response = err.response;
  wrapped.original = err;
  return wrapped;
}

/**
 * Pull a named attribute off a Marketo activity, searching each candidate
 * name in order. Returns null when no match. Mirrors the dotted logic the
 * runner uses for url + status so fields are sourced from the same
 * attribute vocabulary.
 */
function pickAttr(activity, names) {
  const attrs = Array.isArray(activity?.attributes) ? activity.attributes : [];
  for (const n of names) {
    const hit = attrs.find(a => a?.name === n);
    if (hit && hit.value != null && hit.value !== '') return hit.value;
  }
  return null;
}

function buildEngagementBody({ activity, contactId }) {
  const typeId = activity.activityTypeId;
  const label  = TYPE_LABELS[typeId] || `Type ${typeId}`;
  const asset  = activity.primaryAttributeValue || '(no asset)';

  const body = {
    // OOTB required on activity-enabled entities. Human-readable — surfaces
    // nicely on the contact timeline even before the custom fields are
    // styled.
    subject:                                   `[Marketo: ${label}] ${asset}`,

    // Spec-defined dedicated columns.
    ubt_engagementtype:                        TYPE_TO_OPTION[typeId] ?? null,
    ubt_engagementdate:                        activity.activityDate || null,
    ubt_assetname:                             activity.primaryAttributeValue || null,
    ubt_campaignname:                          pickAttr(activity, ['Campaign Name', 'Program Name']),
    ubt_campaignstatus:                        pickAttr(activity, ['New Status', 'Success', 'Reason']),
    ubt_url:                                   pickAttr(activity, ['Link', 'Webpage URL']),
    ubt_sourcesystem:                          'Marketo',
    ubt_externalactivityid:                    activity.id != null ? String(activity.id) : null,

    // N:1 to Contact — auto-generated on activity-enabled entities.
    'regardingobjectid_contact@odata.bind':    `/contacts(${contactId})`,
  };

  return body;
}

async function resolveEntitySet() {
  const configured = await getConfig('DYNAMICS_ENGAGEMENT_ENTITY_SET');
  return (configured && String(configured).trim()) || DEFAULT_ENTITY_SET;
}

async function resolveEntityLogical() {
  const configured = await getConfig('DYNAMICS_ENGAGEMENT_ENTITY_LOGICAL');
  return (configured && String(configured).trim()) || DEFAULT_ENTITY_LOGICAL;
}

/**
 * Write the activity as a record on the custom Marketing Engagement
 * Activity entity.
 *
 * @param {object} params
 * @param {object} params.activity   - raw Marketo activity
 * @param {string} params.contactId  - Dynamics contactid (UUID)
 * @param {string} params.token      - Dynamics bearer token
 * @returns {Promise<{ activityId: string|null }>}
 */
async function writeEngagementActivity({ activity, contactId, token }, _attempt = 0) {
  if (!activity)  throw new Error('[engagement/activityWriter] activity is required');
  if (!contactId) throw new Error('[engagement/activityWriter] contactId is required');
  if (!token)     throw new Error('[engagement/activityWriter] token is required');

  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) throw new Error('[engagement/activityWriter] DYNAMICS_RESOURCE_URL not set');
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  const entitySet  = await resolveEntitySet();

  const body = buildEngagementBody({ activity, contactId });

  const headers = {
    Authorization:      `Bearer ${token}`,
    'Content-Type':     'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    Accept:             'application/json',
    Prefer:             'return=representation',
  };
  const url = `${resourceUrl}/api/data/v${apiVersion}/${entitySet}`;

  try {
    const { data, headers: respHeaders } = await axios.post(url, body, { headers });
    const activityId = data?.activityid
      || data?.[`${DEFAULT_ENTITY_LOGICAL}id`]
      || extractIdFromODataEntityId(respHeaders?.['odata-entityid'])
      || extractIdFromODataEntityId(respHeaders?.['OData-EntityId'])
      || null;
    return { activityId };
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn(
        { attempt: _attempt + 1, waitMs, contactId },
        '[engagement/activityWriter] 429 — backing off',
      );
      await sleep(waitMs);
      return writeEngagementActivity({ activity, contactId, token }, _attempt + 1);
    }
    throw unwrapAxiosError(err, '[engagement/activityWriter] writeEngagementActivity');
  }
}

/**
 * Boot-time sanity check — pings the EntityDefinitions endpoint for the
 * custom entity and WARNs when it 404s so operators see a clear signal
 * that the entity still needs to be created in Dataverse before ingest
 * can succeed. Never throws — returns a small status object.
 *
 * @param {string} token  Dynamics bearer token
 * @returns {Promise<{ ok: boolean, reason?: string, logicalName?: string }>}
 */
async function checkEngagementEntity(token) {
  if (!token) {
    logger.info('[engagement/activityWriter] no Dynamics token available — skipping engagement-entity boot check');
    return { ok: false, reason: 'no-token' };
  }
  const resourceUrl = await getConfig('DYNAMICS_RESOURCE_URL');
  if (!resourceUrl) {
    logger.info('[engagement/activityWriter] DYNAMICS_RESOURCE_URL not set — skipping engagement-entity boot check');
    return { ok: false, reason: 'no-resource-url' };
  }
  const apiVersion = (await getConfig('DYNAMICS_API_VERSION')) || '9.2';
  const logical    = await resolveEntityLogical();
  const url = `${resourceUrl}/api/data/v${apiVersion}/EntityDefinitions(LogicalName='${logical}')?$select=LogicalName`;
  try {
    await axios.get(url, {
      headers: {
        Authorization:      `Bearer ${token}`,
        'OData-MaxVersion': '4.0',
        'OData-Version':    '4.0',
        Accept:             'application/json',
      },
    });
    return { ok: true, logicalName: logical };
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      logger.warn(
        { logicalName: logical },
        '[engagement/activityWriter] custom entity missing in Dataverse — create it per docs/D365_ENGAGEMENT_ENTITY_SETUP.md before engagement ingest can succeed',
      );
      return { ok: false, reason: 'entity-missing', logicalName: logical };
    }
    // Any other error (auth, network, 5xx) we log as warn and move on —
    // we don't want boot-check problems to take the service down.
    logger.warn(
      { logicalName: logical, status, err: err.message },
      '[engagement/activityWriter] engagement-entity boot check failed — continuing',
    );
    return { ok: false, reason: 'check-failed', logicalName: logical };
  }
}

module.exports = {
  writeEngagementActivity,
  checkEngagementEntity,
  TYPE_LABELS,
  TYPE_TO_OPTION,
  EXTENDED_OPTION_CATALOGUE,
  DEFAULT_ENTITY_SET,
  DEFAULT_ENTITY_LOGICAL,
  _buildEngagementBody: buildEngagementBody,
};
