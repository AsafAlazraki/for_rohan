// Simple script to test Azure PostgreSQL connection using DATABASE_URL from .env
require('dotenv').config({ path: './.env' });
const { Client } = require('pg');

async function testConnection() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const res = await client.query('SELECT NOW() as now');
    console.log('Connection successful! Server time:', res.rows[0].now);
  } catch (err) {
    console.error('Connection failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

testConnection();
