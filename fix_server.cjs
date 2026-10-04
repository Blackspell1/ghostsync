const fs = require('fs');
const filePath = process.argv[2] || 'build/server/index.js';
let content = fs.readFileSync(filePath, 'utf8');
content = content.split('build\\\\client').join('build/client');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed build path in', filePath);