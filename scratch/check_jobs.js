const { Client } = require('pg');
require('dotenv').config();

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        const res = await client.query(`
            SELECT 
                data->'payload'->>'emailaddress1' as email, 
                count(*) as count 
            FROM pgboss.job 
            WHERE name = 'sync-events' 
            GROUP BY email 
            ORDER BY count DESC
        `);
        console.log("Current Jobs in Queue:");
        console.table(res.rows);
    } catch (err) {
        console.error("Error querying database:", err.message);
    } finally {
        await client.end();
    }
}

main();
