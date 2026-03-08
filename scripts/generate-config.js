const fs = require('fs');
const path = require('path');

const apiBase = String(process.env.NVC_API_BASE || '').trim().replace(/\/+$/g, '');
const turnstileSiteKey = String(process.env.NVC_TURNSTILE_SITE_KEY || '').trim();
const content = [
  `window.__NVC_API_BASE__ = ${JSON.stringify(apiBase)};`,
  `window.__NVC_TURNSTILE_SITE_KEY__ = ${JSON.stringify(turnstileSiteKey)};`,
  ''
].join('\n');

const outputs = [path.join(__dirname, '..', 'public', 'config.js')];
for (const target of outputs) {
  fs.writeFileSync(target, content, 'utf8');
}

console.log(`[build:config] NVC_API_BASE=${apiBase || '(empty)'} NVC_TURNSTILE_SITE_KEY=${turnstileSiteKey ? '(set)' : '(empty)'}`);
