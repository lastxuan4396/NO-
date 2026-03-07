const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 10000);
const storeFile = process.env.SHORTLINK_STORE_FILE || path.join(__dirname, 'shortlinks-store.json');
const defaultBaseUrl = process.env.PUBLIC_BASE_URL || '';

app.use(express.json({ limit: '80kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function ensureStoreDir() {
  const dir = path.dirname(storeFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.links) {
      return { links: {} };
    }
    return parsed;
  } catch {
    return { links: {} };
  }
}

function saveStore(store) {
  ensureStoreDir();
  fs.writeFileSync(storeFile, JSON.stringify(store), 'utf8');
}

const store = loadStore();

function generateId(length = 7) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function sanitizeState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null;
  }

  const clean = {
    observation: String(rawState.observation || '').slice(0, 1200),
    request: String(rawState.request || '').slice(0, 1200),
    customFeeling: String(rawState.customFeeling || '').slice(0, 300),
    customNeed: String(rawState.customNeed || '').slice(0, 300),
    selectedFeelings: Array.isArray(rawState.selectedFeelings) ? rawState.selectedFeelings.slice(0, 6).map((v) => String(v).slice(0, 20)) : [],
    selectedNeeds: Array.isArray(rawState.selectedNeeds) ? rawState.selectedNeeds.slice(0, 6).map((v) => String(v).slice(0, 20)) : []
  };

  return clean;
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, service: 'nvc-couple-share' });
});

app.post('/api/shortlinks', (req, res) => {
  const state = sanitizeState(req.body && req.body.state);
  if (!state) {
    res.status(400).json({ message: 'state is required' });
    return;
  }

  let id = generateId();
  while (store.links[id]) {
    id = generateId();
  }

  store.links[id] = {
    state,
    createdAt: new Date().toISOString(),
    hits: 0
  };
  saveStore(store);

  const baseUrl = defaultBaseUrl || `${req.protocol}://${req.get('host')}`;
  res.status(201).json({
    id,
    shortUrl: `${baseUrl}/?sid=${id}`
  });
});

app.get('/api/shortlinks/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ message: 'id is required' });
    return;
  }

  const entry = store.links[id];
  if (!entry) {
    res.status(404).json({ message: 'short link not found' });
    return;
  }

  entry.hits = Number(entry.hits || 0) + 1;
  saveStore(store);

  res.status(200).json({
    id,
    createdAt: entry.createdAt,
    hits: entry.hits,
    state: entry.state
  });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('*', (_req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
    return;
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`nvc-couple-share listening on ${port}`);
});
