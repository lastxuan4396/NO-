const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 10000);

app.use(express.static(__dirname, { extensions: ['html'] }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`nvc-couple-share listening on ${port}`);
});
