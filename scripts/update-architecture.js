const fs = require('fs');
const path = require('path');

const ARCH_PATH = path.join(__dirname, '../docs/ARCHITECTURE.md');

// Directories to map
const TARGET_DIRS = ['src', 'web', 'tests', 'db', 'docs', 'scripts'];

function updateArchitecture() {
  const content = fs.readFileSync(ARCH_PATH, 'utf-8');
  
  // Find the module map block
  const startMarker = '<!-- MODULE_MAP_START -->';
  const endMarker = '<!-- MODULE_MAP_END -->';
  
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  
  if (startIndex === -1 || endIndex === -1) {
    console.error('Error: Could not find MODULE_MAP_START or MODULE_MAP_END markers in ARCHITECTURE.md');
    process.exit(1);
  }
  
  // Extract existing tree to preserve comments
  const existingBlock = content.slice(startIndex + startMarker.length, endIndex);
  const commentMap = extractComments(existingBlock);
  
  let newTree = '\n```\n';
  
  // Generate tree for each main directory, but for simplicity we'll just do src/ and web/ mostly
  // Actually, the original map just showed src/ and web/ explicitly. 
  // Let's dynamically map src/ and web/.
  newTree += generateTree('src', 'src', '', commentMap);
  newTree += '\n';
  newTree += generateTree('web', 'web', '', commentMap);
  newTree += '```\n';
  
  const newContent = content.substring(0, startIndex + startMarker.length) + newTree + content.substring(endIndex);
  
  fs.writeFileSync(ARCH_PATH, newContent, 'utf-8');
  console.log('Successfully updated docs/ARCHITECTURE.md');
}

function extractComments(block) {
  const map = {};
  const lines = block.split('\n');
  let currentPath = [];
  
  for (const line of lines) {
    // Basic heuristic to parse tree and comments
    const match = line.match(/^([│\s├└─]*)([\w.-]+)(?:\s{2,}(.+))?$/);
    if (match) {
      const prefix = match[1];
      const name = match[2];
      const comment = match[3];
      
      // We can approximate depth by the length of the prefix (each level is roughly 4 spaces/chars)
      const depth = Math.floor(prefix.replace(/│/g, ' ').length / 4);
      currentPath = currentPath.slice(0, depth);
      currentPath.push(name);
      
      if (comment) {
        map[currentPath.join('/')] = comment.trim();
      }
    }
  }
  return map;
}

function generateTree(dirPath, rootName, prefix, commentMap) {
  const fullPath = path.join(__dirname, '..', dirPath);
  if (!fs.existsSync(fullPath)) return '';
  
  let out = '';
  if (prefix === '') {
    out += `${rootName}/\n`;
  }
  
  const items = fs.readdirSync(fullPath, { withFileTypes: true })
    .filter(item => !['node_modules', 'dist', '.git', 'coverage', '.DS_Store'].includes(item.name))
    .sort((a, b) => {
      // Directories first
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    
  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    
    const itemPath = path.join(dirPath, item.name);
    const normalizedPath = itemPath.replace(/\\/g, '/'); // normalize for Windows
    const comment = commentMap[normalizedPath] || '';
    
    let line = `${prefix}${connector}${item.name}${item.isDirectory() ? '/' : ''}`;
    
    if (comment) {
      const padding = Math.max(1, 31 - line.length);
      line += ' '.repeat(padding) + comment;
    }
    
    out += line + '\n';
    
    if (item.isDirectory()) {
      out += generateTree(itemPath, '', childPrefix, commentMap);
      if (prefix === '' && isLast) {
         // optional spacing at root level
      }
    }
  });
  
  return out;
}

updateArchitecture();
