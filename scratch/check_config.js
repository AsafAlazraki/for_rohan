'use strict';

require('dotenv').config();
const { listConfig } = require('../src/config/loader');

async function main() {
  try {
    const config = await listConfig();
    console.log('--- Admin Config (Database) ---');
    console.table(config);
    
    console.log('\n--- Environment Config ---');
    console.log('MARKETO_MUNCHKIN_ID:', process.env.MARKETO_MUNCHKIN_ID);
    console.log('MARKETO_BASE_URL:', process.env.MARKETO_BASE_URL);
    console.log('MARKETO_CLIENT_ID:', process.env.MARKETO_CLIENT_ID ? 'Set (masked)' : 'Not set');
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
