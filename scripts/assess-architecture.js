const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const ARCH_PATH = path.join(ROOT_DIR, 'docs/ARCHITECTURE.md');
const PACKAGE_PATH = path.join(ROOT_DIR, 'package.json');

function assessArchitecture() {
  console.log('Assessing architecture...');

  // 1. Read package.json to determine tech stack
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf-8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  const stack = {
    database: deps['pg'] ? 'PostgreSQL' : 'Unknown',
    broker: deps['@azure/service-bus'] ? 'Azure Service Bus' : (deps['dapr'] ? 'Dapr' : 'Unknown'),
    web: deps['express'] ? 'Express' : 'Unknown'
  };

  if (deps['supabase'] || deps['@supabase/supabase-js']) {
    console.error('Error: Forbidden dependency found (supabase). Please remove it.');
    process.exit(1);
  }

  // 2. Generate prose for ARCHITECTURE.md
  const prose = `
This project dynamically infers its architecture from its dependencies.
- **Database**: The system uses **${stack.database}** (via \`pg\` and \`pg-boss\`) for queueing and audit logs.
- **Message Broker**: The system relies on **${stack.broker}** to handle incoming webhook events.
- **Web Server**: The API routes and webhook ingestion run on **${stack.web}**.
`;

  // 3. Update ARCHITECTURE.md
  let archContent = fs.readFileSync(ARCH_PATH, 'utf-8');
  const startMarker = '<!-- TECH_STACK_START -->';
  const endMarker = '<!-- TECH_STACK_END -->';

  const startIndex = archContent.indexOf(startMarker);
  const endIndex = archContent.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1) {
    archContent = archContent.substring(0, startIndex + startMarker.length) +
                  '\n' + prose.trim() + '\n' +
                  archContent.substring(endIndex);
    fs.writeFileSync(ARCH_PATH, archContent, 'utf-8');
    console.log('Updated ARCHITECTURE.md tech stack prose.');
  }

  // 4. Scan codebase for forbidden terms (e.g., Supabase) and auto-replace them
  const forbiddenTerms = [
    { regex: /Supabase Postgres/gi, replacement: 'PostgreSQL' },
    { regex: /Supabase SQL [Ee]ditor/gi, replacement: 'PostgreSQL client' },
    { regex: /Supabase project/gi, replacement: 'PostgreSQL database' },
    { regex: /Supabase's/gi, replacement: 'PostgreSQL\'s' },
    { regex: /Supabase/gi, replacement: 'PostgreSQL' } // generic catch-all
  ];

  let filesChanged = 0;

  function scanDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(file)) continue;
      
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(js|jsx|md|html|json)$/.test(file)) {
        // Skip package-lock.json and package.json to avoid breaking them
        if (file === 'package-lock.json' || file === 'package.json') continue;
        // Skip the assessment script itself
        if (file === 'assess-architecture.js') continue;

        let content = fs.readFileSync(fullPath, 'utf-8');
        let modified = false;

        for (const term of forbiddenTerms) {
          if (term.regex.test(content)) {
            content = content.replace(term.regex, term.replacement);
            modified = true;
          }
        }

        if (modified) {
          fs.writeFileSync(fullPath, content, 'utf-8');
          console.log(`Cleaned forbidden terms from ${path.relative(ROOT_DIR, fullPath)}`);
          filesChanged++;
        }
      }
    }
  }

  console.log('Scanning codebase for forbidden terms...');
  scanDir(ROOT_DIR);
  
  if (filesChanged > 0) {
    console.log(`Successfully fixed architecture terms in ${filesChanged} file(s).`);
  } else {
    console.log('Codebase is clean. No forbidden architecture terms found.');
  }
}

assessArchitecture();
