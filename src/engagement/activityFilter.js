'use strict';

/**
 * Per-activity-type filter rules for the Marketo engagement-ingest pipeline.
 *
 * Pure-ish: takes fetched activities + an injectable `db` shim implementing
 * the `engagement_dedup` query helpers and returns a {toWrite, toSkip} split.
 * The runner is responsible for actually persisting the skip decisions —
 * pulling DB writes into here would couple test setup to a real pool.
 *
 * Type ids:
 *    1 → Web Visit
 *    2 → Form Submit
 *    7 → Email Delivered
 *    9 → Email Click
 *   10 → Email Open
 *   14 → Campaign Response (Change Status in Progression)
 */

/** Pull a value from Marketo's `attributes: [{name, value}]` shape. */
function attrValue(activity, name) {
  const attrs = Array.isArray(activity?.attributes) ? activity.attributes : [];
  const hit   = attrs.find(a => a && a.name === name);
  return hit ? hit.value : undefined;
}

/**
 * Parse the comma-separated allow-list of "key URLs" for Web Visits. Empty
 * string => no allow-list (allow everything). Comparison is substring-based
 * because Marketo's webpage URLs include query strings.
 */
function parseKeyUrls(s) {
  if (!s || typeof s !== 'string') return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function urlMatchesAllowlist(url, allowlist) {
  if (!allowlist.length) return true; // empty list ⇒ no restriction
  if (!url) return false;
  return allowlist.some(needle => url.includes(needle));
}

/**
 * Apply the doc's per-type rules to a batch of fetched activities.
 *
 * @param {Array<object>} activities                          - raw Marketo activity objects
 * @param {object}        opts
 * @param {object}        opts.db                             - dedupDb-shaped helper
 * @param {string}        [opts.webVisitKeyUrls]              - comma-separated allow-list
 * @returns {Promise<{ toWrite: Array, toSkip: Array<{ activity, reason }> }>}
 */
async function filterActivities(activities, { db, webVisitKeyUrls = '' } = {}) {
  if (!Array.isArray(activities)) {
    return { toWrite: [], toSkip: [] };
  }
  if (!db) throw new Error('[engagement/activityFilter] db helper required');

  const allowlist = parseKeyUrls(webVisitKeyUrls);
  const toWrite = [];
  const toSkip  = [];

  // In-batch dedup so one fetch page can't produce two writes for the same
  // (lead, asset) just because the cursor returned both within the same call.
  const seenOpens     = new Set();
  const seenClicks    = new Set();
  const seenResponses = new Set();
  // Per-batch counter so the 5/day cap is enforced even if a backlog brings
  // in 50 visits in a single page.
  const webVisitsThisBatch = new Map();

  for (const activity of activities) {
    const typeId = activity.activityTypeId;
    const leadId = activity.leadId;
    const asset  = activity.primaryAttributeValue;

    switch (typeId) {
      case 7: // Email Delivered — allow all
      case 2: // Form Submit     — allow all
        toWrite.push(activity);
        break;

      case 10: { // Email Open — one per (leadId, asset)
        const key = `${leadId}::${asset}`;
        if (seenOpens.has(key)) {
          toSkip.push({ activity, reason: 'duplicate Email Open in same batch' });
          break;
        }
        if (await db.hasEmailOpen(leadId, asset)) {
          toSkip.push({ activity, reason: 'duplicate Email Open already recorded' });
          break;
        }
        seenOpens.add(key);
        toWrite.push(activity);
        break;
      }

      case 9: { // Email Click — one per (leadId, asset, link)
        const link = attrValue(activity, 'Link');
        const key  = `${leadId}::${asset}::${link}`;
        if (seenClicks.has(key)) {
          toSkip.push({ activity, reason: 'duplicate Email Click in same batch' });
          break;
        }
        if (await db.hasEmailClick(leadId, asset, link)) {
          toSkip.push({ activity, reason: 'duplicate Email Click already recorded' });
          break;
        }
        seenClicks.add(key);
        toWrite.push(activity);
        break;
      }

      case 1: { // Web Visit — allowlist + 5/day cap
        const url = attrValue(activity, 'Webpage URL') || asset;
        if (!urlMatchesAllowlist(url, allowlist)) {
          toSkip.push({ activity, reason: 'web visit url not on allow-list' });
          break;
        }
        const already = await db.countRecentWebVisits(leadId);
        const inBatch = webVisitsThisBatch.get(leadId) || 0;
        if (already + inBatch >= 5) {
          toSkip.push({ activity, reason: 'web visit cap reached (5/24h)' });
          break;
        }
        webVisitsThisBatch.set(leadId, inBatch + 1);
        toWrite.push(activity);
        break;
      }

      case 14: { // Campaign Response — one per (leadId, program, status)
        const status = attrValue(activity, 'New Status') ||
                       attrValue(activity, 'Success') ||
                       attrValue(activity, 'Reason')   || '';
        const key = `${leadId}::${asset}::${status}`;
        if (seenResponses.has(key)) {
          toSkip.push({ activity, reason: 'duplicate Campaign Response in same batch' });
          break;
        }
        if (await db.hasCampaignResponse(leadId, asset, status)) {
          toSkip.push({ activity, reason: 'duplicate Campaign Response already recorded' });
          break;
        }
        seenResponses.add(key);
        toWrite.push(activity);
        break;
      }

      default:
        // Unknown type — let the runner deal with it (it shouldn't have
        // requested it in the first place, so log + drop).
        toSkip.push({ activity, reason: `unsupported activityTypeId ${typeId}` });
    }
  }

  return { toWrite, toSkip };
}

module.exports = {
  filterActivities,
  // Internal helpers exposed for unit tests
  _attrValue: attrValue,
  _parseKeyUrls: parseKeyUrls,
  _urlMatchesAllowlist: urlMatchesAllowlist,
};
