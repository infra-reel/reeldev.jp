/**
 * reeldev.jp — Backend API
 * Express + better-sqlite3
 * Routes: /api/news, /api/links, /api/qiita
 */

import express from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.sqlite');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads');
const QIITA_USER = process.env.QIITA_USER || 'riel_hosiduki';

// Ensure dirs
[path.dirname(DB_PATH), UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// DB init
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    body       TEXT,
    image      TEXT,
    published  INTEGER DEFAULT 1,
    createdAt  TEXT    DEFAULT (datetime('now')),
    updatedAt  TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS links (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    icon  TEXT,
    label TEXT NOT NULL,
    url   TEXT NOT NULL,
    type  TEXT DEFAULT 'sns',
    ord   INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS qiita_cache (
    fetched_at TEXT,
    payload    TEXT
  );
`);

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer for image uploads
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// ── Auth middleware (internal: called from admin after Discord OAuth) ──────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key && key === process.env.ADMIN_API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ===== NEWS =================================================================
// GET /api/news
app.get('/api/news', (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 9);
  const offset = (page - 1) * limit;
  const items = db.prepare(
    'SELECT id,title,body,image,createdAt FROM news WHERE published=1 ORDER BY createdAt DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM news WHERE published=1').get();
  res.json({ items, total, page, limit });
});

// GET /api/news/:id
app.get('/api/news/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id=? AND published=1').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// POST /api/news (admin)
app.post('/api/news', requireApiKey, upload.single('image'), (req, res) => {
  const { title, body, published = 1 } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO news (title,body,image,published) VALUES (?,?,?,?)'
  ).run(title, body || null, image, parseInt(published));
  res.status(201).json({ id: lastInsertRowid });
});

// PUT /api/news/:id (admin)
app.put('/api/news/:id', requireApiKey, upload.single('image'), (req, res) => {
  const { title, body, published } = req.body;
  const item = db.prepare('SELECT * FROM news WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const image = req.file ? `/uploads/${req.file.filename}` : item.image;
  db.prepare(
    'UPDATE news SET title=?,body=?,image=?,published=?,updatedAt=datetime("now") WHERE id=?'
  ).run(title ?? item.title, body ?? item.body, image, published != null ? parseInt(published) : item.published, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/news/:id (admin)
app.delete('/api/news/:id', requireApiKey, (req, res) => {
  db.prepare('DELETE FROM news WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== LINKS ================================================================
app.get('/api/links', (req, res) => {
  const type = req.query.type;
  const rows = type
    ? db.prepare('SELECT * FROM links WHERE type=? ORDER BY ord').all(type)
    : db.prepare('SELECT * FROM links ORDER BY ord').all();
  res.json({ items: rows });
});

app.post('/api/links', requireApiKey, (req, res) => {
  const { icon, label, url, type = 'sns', ord = 0 } = req.body;
  if (!label || !url) return res.status(400).json({ error: 'label and url required' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO links (icon,label,url,type,ord) VALUES (?,?,?,?,?)'
  ).run(icon || null, label, url, type, ord);
  res.status(201).json({ id: lastInsertRowid });
});

app.delete('/api/links/:id', requireApiKey, (req, res) => {
  db.prepare('DELETE FROM links WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== QIITA ================================================================
// Cache 1 hour; fetched by cron /api/qiita/refresh (admin) or on demand
app.get('/api/qiita', async (req, res) => {
  const row = db.prepare('SELECT * FROM qiita_cache ORDER BY rowid DESC LIMIT 1').get();
  if (row && (Date.now() - new Date(row.fetched_at).getTime()) < 3600_000) {
    return res.json({ items: JSON.parse(row.payload), cached: true });
  }
  try {
    const data = await fetchQiita();
    res.json({ items: data });
  } catch (e) {
    if (row) return res.json({ items: JSON.parse(row.payload), cached: true });
    res.status(502).json({ error: 'Qiita fetch failed' });
  }
});

// POST /api/qiita/refresh — called by CronJob in k8s
app.post('/api/qiita/refresh', requireApiKey, async (req, res) => {
  try {
    const data = await fetchQiita();
    res.json({ ok: true, count: data.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function fetchQiita() {
  const url = `https://qiita.com/api/v2/users/${QIITA_USER}/items?per_page=12`;
  const r = await fetch(url, {
    headers: process.env.QIITA_TOKEN ? { Authorization: `Bearer ${process.env.QIITA_TOKEN}` } : {}
  });
  if (!r.ok) throw new Error(`Qiita API ${r.status}`);
  const data = await r.json();
  db.prepare('DELETE FROM qiita_cache').run();
  db.prepare('INSERT INTO qiita_cache (fetched_at,payload) VALUES (?,?)').run(
    new Date().toISOString(), JSON.stringify(data)
  );
  return data;
}

// Health
app.get('/healthz', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
