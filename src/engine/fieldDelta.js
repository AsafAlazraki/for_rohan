'use strict';

const fieldmap = require('../config/fieldmap.json');
const { loadSnapshot } = require('../audit/db');
const { getConfig } = require('../config/loader');

// ASSUMPTIONS §8 — "Sync to Marketo" opt-in flag.
// When truthy, a CRM record only syncs if payload.ubt_synctomarketo === true.
// Default is effectively false (see ASSUMPTIONS.md).
function isTruthyFlag(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function normalize(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // For arrays / objects we compare the JSON form.
  try { return JSON.stringify(value); } catch { return String(value); }
}

function mappedSourceFields(entityType) {
  const mapping = fieldmap.crmToMarketo?.[entityType];
  if (!mapping) return [];
  const fields = new Set();
  for (const entry of Object.values(mapping)) {
    // `source` is the D365 attribute name. Derived entries point at '@derived'
    // and contribute no delta signal — skip them.
    if (entry.source && entry.source !== '@derived') fields.add(entry.source);
  }
  return Array.from(fields);
}

/**
 * Decide whether a Dynamics → Marketo job should propagate based on whether
 * any MAPPED field changed vs. the prior known state.
 *
 * Delta sources, in preference order:
 *   1. payload._pre + payload._post (D365 webhook PreImage/PostImage, if
 *      the plugin is configured to send them).
 *   2. last stored snapshot from `sync_snapshots` keyed by (source, id).
 *   3. no baseline → first sighting: treat as a change (bootstrap).
 *
 * @param {object} payload   The incoming Dynamics record (PostImage shape).
 * @param {'contact'|'lead'|'account'} entityType
 * @returns {Promise<{ changed: boolean, reason: string, baseline: 'preimage'|'snapshot'|'bootstrap' }>}
 */
async function hasMappedChange(payload, entityType) {
  // ASSUMPTIONS §8 opt-in gate. Short-circuits before any delta work.
  const flag = await getConfig('SYNC_TO_MARKETO_REQUIRED');
  if (isTruthyFlag(flag)) {
    const post = payload?._post || payload || {};
    if (post.ubt_synctomarketo !== true) {
      return {
        changed:  false,
        reason:   'sync-to-marketo-opt-in-required',
        baseline: 'opt-in-gate',
      };
    }
  }

  const fields = mappedSourceFields(entityType);
  if (fields.length === 0) {
    return { changed: true, reason: 'no-mapped-fields', baseline: 'bootstrap' };
  }

  // Tier 1: inline PreImage.
  const pre  = payload?._pre;
  const post = payload?._post || payload;
  if (pre && typeof pre === 'object') {
    for (const f of fields) {
      if (normalize(pre[f]) !== normalize(post[f])) {
        return { changed: true, reason: `field-changed:${f}`, baseline: 'preimage' };
      }
    }
    return { changed: false, reason: 'no-mapped-field-changed', baseline: 'preimage' };
  }

  // Tier 2: stored snapshot.
  const sourceId =
    payload.contactid || payload.leadid || payload.accountid || payload.id;
  if (!sourceId) {
    return { changed: true, reason: 'no-source-id', baseline: 'bootstrap' };
  }

  const snap = await loadSnapshot({ source_system: 'dynamics', source_id: sourceId });
  if (!snap || !snap.payload) {
    return { changed: true, reason: 'first-sighting', baseline: 'bootstrap' };
  }

  for (const f of fields) {
    if (normalize(snap.payload[f]) !== normalize(post[f])) {
      return { changed: true, reason: `field-changed:${f}`, baseline: 'snapshot' };
    }
  }
  return { changed: false, reason: 'no-mapped-field-changed', baseline: 'snapshot' };
}

module.exports = { hasMappedChange, _mappedSourceFields: mappedSourceFields };
