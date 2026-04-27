'use strict';

require('dotenv').config();
const { getPool } = require('../src/audit/db');

async function main() {
  const pool = getPool();
  try {
    const { rows } = await pool.query(
      'SELECT id, status, error_message, created_at FROM sync_events WHERE status = $1 ORDER BY created_at DESC LIMIT 5',
      ['failed']
    );
    console.log('--- Recent Failed Sync Events ---');
    console.table(rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
