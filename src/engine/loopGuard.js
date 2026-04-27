'use strict';

/**
 * Loop guard — prevents infinite sync loops between Dynamics and Marketo.
 *
 * Each writer stamps a `syncSource` / `cr_syncsource` field on every record
 * it creates or updates so the other side can detect its own echo.
 *
 * Field conventions:
 *   Dynamics → stores the originating system in `cr_syncsource` (custom field)
 *   Marketo  → stores the originating system in `syncSource`    (custom field)
 *
 * @param {object} event         - Inbound sync event; must have a `.payload` property
 *                                 (or be the payload itself).
 * @param {string} targetSystem  - 'dynamics' | 'marketo'
 * @returns {{ skip: boolean, reason?: string }}
 */
function shouldSkip(event, targetSystem) {
  if (!event || !targetSystem) return { skip: false };

  const payload = event.payload ?? event;

  // Check flat fields and one level of `.attributes` nesting (Dynamics OData style)
  const syncSource =
    payload.syncSource           ??
    payload.cr_syncsource        ??
    payload.attributes?.syncSource    ??
    payload.attributes?.cr_syncsource ??
    null;

  if (!syncSource) return { skip: false };

  const sourceNorm = String(syncSource).toLowerCase().trim();
  const targetNorm = String(targetSystem).toLowerCase().trim();

  if (sourceNorm === targetNorm) {
    return {
      skip:   true,
      reason: `Loop guard: record originated from "${targetSystem}"; skipping write-back`,
    };
  }

  return { skip: false };
}

module.exports = { shouldSkip };
