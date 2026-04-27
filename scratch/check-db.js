const { Pool } = require('pg');
require('dotenv').config();

async function countJobs() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const jobCount = await pool.query('SELECT count(*) FROM pgboss.job');
    const archiveCount = await pool.query('SELECT count(*) FROM pgboss.archive');
    console.log('TOTAL_JOBS=' + jobCount.rows[0].count);
    console.log('TOTAL_ARCHIVED=' + archiveCount.rows[0].count);
    
    const recent = await pool.query("SELECT id, name, createdon, state FROM (SELECT id, name, createdon, state FROM pgboss.job UNION ALL SELECT id, name, createdon, state FROM pgboss.archive) sub WHERE name NOT LIKE '__pgboss__%' ORDER BY createdon DESC LIMIT 50");
    console.log('API_MIMIC_JOBS=' + JSON.stringify(recent.rows));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

countJobs();
