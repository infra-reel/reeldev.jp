/**
 * reeldev.jp — Admin Panel Server
 * 修正: multerでmultipart受信 → form-dataでapiに転送
 */

import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fetch from 'node-fetch';
import FormData from 'form-data';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.ADMIN_PORT || 3002;

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI || 'https://admin.reeldev.jp/auth/callback';
const ALLOWED_DISCORD_IDS   = (process.env.ALLOWED_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const API_BASE              = process.env.API_BASE || 'http://api:3001';
const ADMIN_API_KEY         = process.env.ADMIN_API_KEY;
const SESSION_DIR           = process.env.SESSION_DIR || '/data/sessions';
const IS_PROD               = process.env.NODE_ENV === 'production';

fs.mkdirSync(SESSION_DIR, { recursive: true });

app.set('trust proxy', 1);

const SQLiteStore = connectSqlite3(session);
const upload = multer({ dest: '/tmp/admin-uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({
    dir:   SESSION_DIR,
    table: 'sessions',
    ttl:   86400,
    concurrentDB: true,
  }),
  secret:            process.env.SESSION_SECRET || 'change-me',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,
  name:              'reeldev.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   86400_000,
    secure:   IS_PROD,
  },
}));

app.use(express.static(path.join(__dirname, '../public')));

app.get('/healthz', (_, res) => res.json({ ok: true }));

// ── Auth guard ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
}

// ── Discord OAuth ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/login.html?error=${error}`);
  if (!code)  return res.redirect('/login.html?error=no_code');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) return res.redirect('/login.html?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await userRes.json();
    if (!user.id) return res.redirect('/login.html?error=user_fetch_failed');

    if (ALLOWED_DISCORD_IDS.length && !ALLOWED_DISCORD_IDS.includes(user.id)) {
      return res.redirect('/login.html?error=forbidden');
    }

    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.redirect('/');
  } catch (e) {
    console.error('OAuth error:', e);
    res.redirect('/login.html?error=oauth_error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('reeldev.sid');
    res.redirect('/login.html');
  });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// ── JSON proxy helper ──────────────────────────────────────────────────────
async function proxyJson(method, apiPath, body) {
  const headers = { 'x-api-key': ADMIN_API_KEY, 'Content-Type': 'application/json' };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${API_BASE}${apiPath}`, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// ── NEWS ───────────────────────────────────────────────────────────────────
app.get('/api/admin/news', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('GET', `/api/news?page=${req.query.page || 1}&limit=20`);
    res.status(status).json(data);
  } catch (e) {
    console.error('news GET error:', e);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/admin/news', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, body, published = 1 } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    if (req.file) {
      const fd = new FormData();
      fd.append('title', title);
      if (body) fd.append('body', body);
      fd.append('published', String(published));
      fd.append('image', fs.createReadStream(req.file.path), {
        filename:    req.file.originalname,
        contentType: req.file.mimetype,
      });
      const r = await fetch(`${API_BASE}/api/news`, {
        method:  'POST',
        headers: { 'x-api-key': ADMIN_API_KEY, ...fd.getHeaders() },
        body:    fd,
      });
      fs.unlink(req.file.path, () => {});
      return res.status(r.status).json(await r.json().catch(() => ({})));
    }

    const { status, data } = await proxyJson('POST', '/api/news', { title, body, published });
    res.status(status).json(data);
  } catch (e) {
    console.error('news POST error:', e);
    res.status(502).json({ error: e.message });
  }
});

app.put('/api/admin/news/:id', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, body, published } = req.body;

    if (req.file) {
      const fd = new FormData();
      if (title)     fd.append('title', title);
      if (body)      fd.append('body', body);
      if (published != null) fd.append('published', String(published));
      fd.append('image', fs.createReadStream(req.file.path), {
        filename:    req.file.originalname,
        contentType: req.file.mimetype,
      });
      const r = await fetch(`${API_BASE}/api/news/${req.params.id}`, {
        method:  'PUT',
        headers: { 'x-api-key': ADMIN_API_KEY, ...fd.getHeaders() },
        body:    fd,
      });
      fs.unlink(req.file.path, () => {});
      return res.status(r.status).json(await r.json().catch(() => ({})));
    }

    const { status, data } = await proxyJson('PUT', `/api/news/${req.params.id}`, { title, body, published });
    res.status(status).json(data);
  } catch (e) {
    console.error('news PUT error:', e);
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/admin/news/:id', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('DELETE', `/api/news/${req.params.id}`);
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── LINKS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/links', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('GET', '/api/links');
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/admin/links', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('POST', '/api/links', req.body);
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/admin/links/:id', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('DELETE', `/api/links/${req.params.id}`);
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── QIITA ─────────────────────────────────────────────────────────────────
app.post('/api/admin/qiita/refresh', requireAuth, async (req, res) => {
  try {
    const { status, data } = await proxyJson('POST', '/api/qiita/refresh', {});
    res.status(status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Unhandled Rejection でプロセスが落ちないように ─────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`Admin listening on :${PORT} (prod=${IS_PROD})`);
  console.log(`Session store: ${SESSION_DIR}/sessions.db`);
  console.log(`Allowed Discord IDs: ${ALLOWED_DISCORD_IDS.join(', ')}`);
});
