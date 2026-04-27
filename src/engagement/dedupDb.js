'use strict';

/**
 * Thin pg-backed accessor for the engagement_dedup table. Centralised so the
 * runner / filter modules stay readable and the queries are easy to mock in
 * tests.
 *
 * Table shape (see db/schema.sql):
 *   marketo_activity_id BIGINT PK
 *   activity_type_id    INT
 *   marketo_lead_id     BIGINT
 *   asset_name          TEXT
 *   url                 TEXT
 *   dynamics_contact_id             TEXT
 *   dynamics_engagement_activity_id TEXT
 *   filter_decision     'written'|'skipped'|'unmatched'
 *   filter_reason       TEXT
 *   occurred_at         TIMESTAMPTZ
 *   created_at          TIMESTAMPTZ DEFAULT NOW()
 */

const { getPool } = require('../audit/db');

/**
 * Return true when an Email Open already exists for (leadId, assetName).
 */
async function hasEmailOpen(leadId, assetName) {
  const { rows } = await getPool().query(
    `SELECT 1 FROM engagement_dedup
       WHERE marketo_lead_id = $1
         AND activity_type_id = 10
         AND asset_name = $2
         AND filter_decision = 'written'
       LIMIT 1`,
    [leadId, assetName],
  );
  return rows.length > 0;
}

/**
 * Return true when an Email Click already exists for (leadId, assetName, url).
 */
async function hasEmailClick(leadId, assetName, url) {
  const { rows } = await getPool().query(
    `SELECT 1 FROM engagement_dedup
       WHERE marketo_lead_id = $1
         AND activity_type_id = 9
         AND asset_name = $2
         AND url = $3
         AND filter_decision = 'written'
       LIMIT 1`,
    [leadId, assetName, url],
  );
  return rows.length > 0;
}

/**
 * Return true when a Campaign Response with the same (leadId, programName,
 * status) already exists. The status is encoded into filter_reason so we can
 * dedup without adding a new column.
 */
async function hasCampaignResponse(leadId, programName, status) {
  const { rows } = await getPool().query(
    `SELECT 1 FROM engagement_dedup
       WHERE marketo_lead_id = $1
         AND activity_type_id = 14
         AND asset_name = $2
         AND filter_reason = $3
         AND filter_decision = 'written'
       LIMIT 1`,
    [leadId, programName, `status:${status || ''}`],
  );
  return rows.length > 0;
}

/**
 * Count of Web Visits written for this lead in the last 24h. Used to enforce
 * the "max 5/day" cap.
 */
async function countRecentWebVisits(leadId) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM engagement_dedup
       WHERE marketo_lead_id = $1
         AND activity_type_id = 1
         AND filter_decision = 'written'
         AND created_at > NOW() - INTERVAL '24 hours'`,
    [leadId],
  );
  return rows[0]?.n || 0;
}

/**
 * Insert a single dedup row. ON CONFLICT DO NOTHING — safe to re-run if the
 * cursor backs up over previously-seen activities.
 */
async function insertDedup(row) {
  const {
    marketoActivityId,
    activityTypeId,
    marketoLeadId,
    assetName,
    url,
    dynamicsContactId,
    dynamicsEngagementActivityId,
    filterDecision,
    filterReason,
    occurredAt,
  } = row;

  await getPool().query(
    `INSERT INTO engagement_dedup
       (marketo_activity_id, activity_type_id, marketo_lead_id,
        asset_name, url,
        dynamics_contact_id, dynamics_engagement_activity_id,
        filter_decision, filter_reason, occurred_at)
     VALUES ($1,$2,$3, $4,$5, $6,$7, $8,$9,$10)
     ON CONFLICT (marketo_activity_id) DO NOTHING`,
    [
      marketoActivityId,
      activityTypeId,
      marketoLeadId != null ? String(marketoLeadId) : null,
      assetName || null,
      url || null,
      dynamicsContactId || null,
      dynamicsEngagementActivityId || null,
      filterDecision,
      filterReason || null,
      occurredAt || null,
    ],
  );
}

/**
 * Recent rows for the listing endpoint. Optional filter by type and "since".
 */
async function listRecent({ limit = 50, type = null, since = null } = {}) {
  const conditions = [];
  const values     = [];
  let   idx        = 1;

  if (type != null) {
    conditions.push(`activity_type_id = $${idx++}`);
    values.push(parseInt(type, 10));
  }
  if (since) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(new Date(since));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(Math.min(parseInt(limit, 10) || 50, 500));

  const { rows } = await getPool().query(
    `SELECT
       marketo_activity_id, activity_type_id, marketo_lead_id,
       asset_name, url,
       dynamics_contact_id, dynamics_engagement_activity_id,
       filter_decision, filter_reason,
       occurred_at, created_at
     FROM engagement_dedup
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return rows;
}

/**
 * Aggregate counts for /api/engagement/stats.
 */
async function aggregateStats() {
  const pool = getPool();
  const [{ rows: total }, { rows: byType }, { rows: byStatus }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM engagement_dedup`),
    pool.query(`SELECT activity_type_id AS type, COUNT(*)::int AS n FROM engagement_dedup GROUP BY activity_type_id`),
    pool.query(`SELECT filter_decision AS status, COUNT(*)::int AS n FROM engagement_dedup GROUP BY filter_decision`),
  ]);
  return {
    total:    total[0]?.n || 0,
    byType:   byType   || [],
    byStatus: byStatus || [],
  };
}

module.exports = {
  hasEmailOpen,
  hasEmailClick,
  hasCampaignResponse,
  countRecentWebVisits,
  insertDedup,
  listRecent,
  aggregateStats,
};
