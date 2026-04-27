// src/routes/jobQuery.js
'use strict';

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Query recent jobs from pgboss.job and pgboss.archive
 * @param {string} queueName - Optional filter by name
 * @param {object} options - Pagination and filtering options
 * @returns {Promise<Array>}
 */
async function getRecentJobs(queueName, { limit = 20, offset = 0, status = null, search = null } = {}) {
  let whereClauses = [
    "name NOT LIKE '__pgboss__%'",
    "name != 'marketo-engagement-ingest'"
  ];
  const params = [];

  if (queueName) {
    params.push(queueName);
    whereClauses.push(`name = $${params.length}`);
  }

  if (status) {
    params.push(status.toLowerCase());
    whereClauses.push(`LOWER(state::text) = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    whereClauses.push(`(id::text ILIKE $${params.length} OR name ILIKE $${params.length} OR data::text ILIKE $${params.length})`);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT id, name, state, data, createdon, completedon, retrycount
    FROM (
      SELECT id, name, state, data, createdon, completedon, retrycount FROM pgboss.job ${whereStr}
      UNION ALL
      SELECT id, name, state, data, createdon, completedon, retrycount FROM pgboss.archive ${whereStr}
    ) combined
    ORDER BY createdon DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const { rows } = await pool.query(sql, [...params, limit, offset]);
  return rows;
}

/**
 * Get total count of jobs matching filters
 * @param {string} queueName
 * @param {object} options
 * @returns {Promise<number>}
 */
async function getJobCount(queueName, { status = null, search = null } = {}) {
  let whereClauses = [
    "name NOT LIKE '__pgboss__%'",
    "name != 'marketo-engagement-ingest'"
  ];
  const params = [];

  if (queueName) {
    params.push(queueName);
    whereClauses.push(`name = $${params.length}`);
  }

  if (status) {
    params.push(status.toLowerCase());
    whereClauses.push(`LOWER(state::text) = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    whereClauses.push(`(id::text ILIKE $${params.length} OR name ILIKE $${params.length} OR data::text ILIKE $${params.length})`);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT COUNT(*) as count FROM (
      SELECT id FROM pgboss.job ${whereStr}
      UNION ALL
      SELECT id FROM pgboss.archive ${whereStr}
    ) combined
  `;

  const { rows } = await pool.query(sql, params);
  return parseInt(rows[0].count, 10);
}

module.exports = { getRecentJobs, getJobCount };