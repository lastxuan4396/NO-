const fs = require('fs');
const path = require('path');

const apiBase = String(process.env.NVC_API_BASE || '').trim().replace(/\/+$/g, '');
const content = `window.__NVC_API_BASE__ = ${JSON.stringify(apiBase)};\n`;

const outputs = [path.join(__dirname, '..', 'public', 'config.js')];
for (const target of outputs) {
  fs.writeFileSync(target, content, 'utf8');
}

console.log(`[build:config] NVC_API_BASE=${apiBase || '(empty)'}`);
