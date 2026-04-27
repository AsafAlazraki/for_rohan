const { getPool } = require('../src/audit/db');
require('dotenv').config();

async function checkUnknown() {
  const pool = getPool();
  try {
    const res = await pool.query("SELECT source_system, source_type, payload FROM sync_events WHERE LOWER(source_type) = 'unknown' OR source_type = '' LIMIT 3;");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}

checkUnknown();
