'use strict';

const { EventEmitter } = require('events');
const { mapToMarketo } = require('../engine/fieldMapper');

/**
 * In-process event bus. The sync pipeline emits on it after every attempted
 * write; the SSE route subscribes and forwards to connected browsers.
 *
 * Single-process scope — fine for a POC. For multi-replica deployments,
 * swap this for a Redis pub/sub or other real-time channel.
 */
const bus = new EventEmitter();
bus.setMaxListeners(100); // allow many dashboard tabs

/**
 * Build the field-diff payload the dashboard renders.
 * source/targetFields are keyed by their native field names in each system,
 * so the UI can line them up side-by-side.
 */
function buildFieldDiff(source, payload, entityType = 'contact') {
  const sourceFields = { ...payload };
  // Don't show nested associated data in the diff
  delete sourceFields._associatedAccount;
  // Post-Task-15 the event bus only renders outbound diffs for Dynamics-source
  // jobs. Marketo-source jobs route through dedicated handlers (unsubscribe /
  // newLead) that produce their own narrow projections; for the UI stream, we
  // just show the inbound payload on the Marketo side and leave the target
  // column blank — consumers can inspect handler results directly.
  const targetFields = source === 'dynamics'
    ? mapToMarketo(payload, entityType)
    : {};
  return { sourceFields, targetFields };
}

/**
 * Emit a `sync` event for the dashboard.
 *
 * @param {object} evt
 * @param {string} evt.id                   Audit row id or BullMQ job id.
 * @param {'dynamics'|'marketo'} evt.source
 * @param {'dynamics'|'marketo'} evt.target
 * @param {'success'|'skipped'|'failed'} evt.status
 * @param {object} evt.payload              Raw source record.
 * @param {string} [evt.email]
 * @param {string} [evt.error]
 * @param {string} [evt.reason]             Skip reason, if any.
 * @param {string[]} [evt.warnings]         Non-fatal issues (e.g. ambiguous
 *                                          company name). Status stays
 *                                          'success' — the dashboard can
 *                                          surface these as chips.
 */
function emitSync(evt) {
  const entityType = evt.entityType || 'contact';
  let fieldDiff = { sourceFields: {}, targetFields: {} };
  try {
    fieldDiff = buildFieldDiff(evt.source, evt.payload || {}, entityType);
  } catch {
    // unknown entityType or other mapper error — fall back to raw payload
    fieldDiff = { sourceFields: evt.payload || {}, targetFields: {} };
  }

  bus.emit('sync', {
    id:           evt.id,
    source:       evt.source,
    target:       evt.target,
    status:       evt.status,
    entityType,
    email:        evt.email || null,
    error:        evt.error || null,
    reason:       evt.reason || null,
    warnings:     Array.isArray(evt.warnings) && evt.warnings.length ? evt.warnings : null,
    sourceFields: fieldDiff.sourceFields,
    targetFields: fieldDiff.targetFields,
    ts:           new Date().toISOString(),
  });
}

module.exports = { bus, emitSync };
