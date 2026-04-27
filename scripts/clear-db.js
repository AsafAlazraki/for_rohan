require('dotenv').config();
const { Client } = require('pg');

async function clearJobs() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Connecting to database...');
    await client.connect();

    console.log('Clearing pgboss tables...');
    // Cascade ensures that related data in pgboss.archive etc is also cleared if necessary.
    await client.query('TRUNCATE TABLE pgboss.job CASCADE');
    await client.query('TRUNCATE TABLE pgboss.archive CASCADE');

    console.log('Successfully cleared all jobs from the dashboard!');
  } catch (err) {
    console.error('Error clearing database:', err);
  } finally {
    await client.end();
  }
}

clearJobs();
