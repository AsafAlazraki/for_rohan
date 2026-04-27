'use strict';

const fieldmap = require('../config/fieldmap.json');
const { resolveOption, resolveLabel } = require('./optionSetResolver');
const { resolveLookup }                = require('./lookupResolver');

/**
 * Scoped mapper (Task 11 + 11b + 12 + 13).
 *
 * Two scopes:
 *   - crmToMarketo  : D365 → Marketo (read from the Dynamics record)
 *   - marketoToCrm  : Marketo → D365 (read from the Marketo payload)
 *
 * Entry shape: { source, type, entitySet?, optionSet?, derivation?, value? }
 *   text      — direct copy
 *   boolean   — direct copy (no coercion)
 *   guid      — direct copy
 *   choice    — resolved via optionSetResolver when token provided, else
 *               passthrough as text
 *   lookup    — passthrough text unless lookupResolver is attached (Task 13
 *               emits @odata.bind in mapMarketoToCrm). In crmToMarketo, the
 *               source is the `_<field>_value` shape and the resolver returns
 *               the label (crmToMarketo Choice-of-Lookup treatment).
 *   derived   — SKIPPED here; handled by derivedFields.enrichDerived (11b)
 *   literal   — emits a fixed `entry.value` regardless of the source record;
 *               source is conventionally '@literal' (mirrors derived's
 *               '@derived' marker). Used for static signals like
 *               crmEntityType.
 */

function isBlank(v) { return v == null || v === ''; }

function projectScope(scope, entityType) {
  const mapping = fieldmap[scope]?.[entityType];
  if (!mapping) throw new Error(`[fieldMapper] Unknown mapping: ${scope}.${entityType}`);
  return mapping;
}

/**
 * Synchronous flat projection: text / boolean / guid / choice (passthrough)
 * / lookup (passthrough). Derived entries are skipped. Used by the event
 * bus diff where async I/O is not available.
 */
function mapToMarketo(record, entityType = 'contact') {
  const mapping = projectScope('crmToMarketo', entityType);
  const out = {};
  for (const [targetField, entry] of Object.entries(mapping)) {
    if (entry.type === 'derived') continue;
    if (entry.type === 'literal') {
      if (!isBlank(entry.value)) out[targetField] = entry.value;
      continue;
    }
    const val = record[entry.source];
    if (!isBlank(val)) out[targetField] = val;
  }
  return out;
}

/**
 * Async projection for CRM → Marketo. Choice entries are resolved to labels
 * via optionSetResolver.resolveLabel when a token is supplied; otherwise
 * they pass through raw.
 *
 * Lookup entries source the `_<field>_value` GUID; we keep that GUID verbatim
 * here — Marketo's side wants the label, which requires a follow-up call
 * to read the lookup target's name column. That's deferred to Task 13's
 * lookupResolver (not wired here to keep this layer focused).
 */
async function mapToMarketoAsync(record, entityType, { token } = {}) {
  const mapping = projectScope('crmToMarketo', entityType);
  const out = {};
  for (const [targetField, entry] of Object.entries(mapping)) {
    if (entry.type === 'derived') continue;
    if (entry.type === 'literal') {
      if (!isBlank(entry.value)) out[targetField] = entry.value;
      continue;
    }
    const raw = record[entry.source];
    if (isBlank(raw)) continue;

    if (entry.type === 'choice' && token && entry.optionSet) {
      // D365 → Marketo: translate int → label.
      const label = await resolveLabel(entityType, entry.optionSet, raw, token);
      out[targetField] = label != null ? label : raw;
    } else {
      out[targetField] = raw;
    }
  }
  return out;
}

/**
 * Sync projection for Marketo → CRM. Only Contact (consent-only) and Lead
 * (new-lead creation) are defined. Choice + lookup entries remain raw until
 * Task 12/13 wire resolution; the async version below does that.
 */
function mapMarketoToCrm(record, entityType = 'lead') {
  const mapping = projectScope('marketoToCrm', entityType);
  const out = {};
  for (const [targetField, entry] of Object.entries(mapping)) {
    const val = record[entry.source];
    if (!isBlank(val)) out[targetField] = val;
  }
  return out;
}

/**
 * Async Marketo → CRM. Resolves choice labels via resolveOption. Lookup
 * @odata.bind wiring is Task 13.
 */
async function mapMarketoToCrmAsync(record, entityType, { token } = {}) {
  const mapping = projectScope('marketoToCrm', entityType);
  const out = {};
  for (const [targetField, entry] of Object.entries(mapping)) {
    const raw = record[entry.source];
    if (isBlank(raw)) continue;

    if (entry.type === 'choice' && token && entry.optionSet) {
      const v = await resolveOption(entityType, entry.optionSet, raw, token);
      out[targetField] = v != null ? v : raw;
    } else if (entry.type === 'lookup' && token && entry.entitySet) {
      const id = await resolveLookup({
        entitySet:  entry.entitySet,
        naturalKey: entry.naturalKey,
        idField:    entry.idField,
        value:      raw,
        token,
      });
      if (id) {
        // Emit Dataverse bind form: "<logicalName>@odata.bind": "/<entitySet>(<id>)"
        out[`${targetField}@odata.bind`] = `/${entry.entitySet}(${id})`;
      }
      // If no id resolved, drop the field silently — the caller can log.
    } else {
      out[targetField] = raw;
    }
  }
  return out;
}

module.exports = {
  mapToMarketo,
  mapToMarketoAsync,
  mapMarketoToCrm,
  mapMarketoToCrmAsync,
};
