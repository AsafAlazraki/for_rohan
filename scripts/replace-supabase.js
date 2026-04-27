const fs = require('fs');
const path = require('path');

const filesToProcess = [
  'README.md',
  'web/src/tabs/Dashboard.jsx',
  'web/src/tabs/Architecture.jsx',
  'web/src/tabs/Admin.jsx',
  'web/playwright.config.js',
  'src/routes/events.js',
  'src/engagement/cursor.js',
  'src/engagement/dedupDb.js',
  'src/config/loader.js',
  'src/audit/db.js',
  'src/auth/dynamics.js',
  'docs/COMPLIANCE_ANALYSIS.md',
  'docs/GETTING_STARTED.md',
  'docs/HANDOVER_CHECKLIST.md',
  'docs/PRODUCT_OVERVIEW.md',
  'docs/ARCHITECTURE.md',
  'docs/AZURE_DEPLOY.md'
];

filesToProcess.forEach(file => {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) return;
  
  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Specific replacements
  content = content.replace(/db\/PostgreSQL\.sql/g, 'db/schema.sql');
  content = content.replace(/PostgreSQL SQL [Ee]ditor/g, 'PostgreSQL client');
  content = content.replace(/PostgreSQL/g, 'PostgreSQL');
  content = content.replace(/PostgreSQL database/g, 'PostgreSQL database');
  content = content.replace(/PostgreSQL's/g, 'PostgreSQL\'s');
  
  // URL and env var replacements
  content = content.replace(/PostgreSQL_URL/g, 'DB_HOST');
  content = content.replace(/PostgreSQL_SERVICE_ROLE_KEY/g, 'DB_PASSWORD');
  content = content.replace(/PostgreSQL_DB_URL/g, 'DATABASE_URL');
  
  // General replacements
  content = content.replace(/PostgreSQL/g, 'PostgreSQL');
  content = content.replace(/PostgreSQL/g, 'postgres');

  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`Updated ${file}`);
});
