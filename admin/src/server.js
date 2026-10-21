/**
 * reeldev.jp — Admin Panel Server
 * Discord OAuth2 認証 → セッション → 管理API プロキシ
 */

import express from 'express';
import session from 'express-session';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.ADMIN_PORT || 3002;

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || 'https://admin.reeldev.jp/auth/callback';
const ALLOWED_DISCORD_IDS   = (process.env.ALLOWED_DISCORD_IDS || '').split(',').map(s => s.trim());
const API_BASE              = process.env.API_BASE || 'http://api-service:3001';
const ADMIN_API_KEY         = process.env.ADMIN_API_KEY;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 86400_000 },
}));
app.use(express.static(path.join(__dirname, '../public')));

// ── Auth guard ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/login');
}

// ── Discord OAuth ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login?error=no_code');
  try {
    // Exchange code
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error('Token exchange failed');

    // Get user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await userRes.json();

    if (!ALLOWED_DISCORD_IDS.includes(user.id)) {
      return res.redirect('/login?error=forbidden');
    }
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    res.redirect('/');
  } catch (e) {
    console.error('OAuth error:', e);
    res.redirect('/login?error=oauth_error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Session info ───────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// ── Proxy to backend API ───────────────────────────────────────────────────
async function proxyToApi(method, path, body, isFormData = false) {
  const headers = { 'x-api-key': ADMIN_API_KEY };
  if (!isFormData) headers['Content-Type'] = 'application/json';
  const opts = { method, headers };
  if (body) opts.body = isFormData ? body : JSON.stringify(body);
  const r = await fetch(`${API_BASE}${path}`, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// --- News proxy ---
app.get('/api/admin/news',       requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('GET', `/api/news?page=${req.query.page||1}&limit=20`);
  res.status(status).json(data);
});

app.post('/api/admin/news',      requireAuth, async (req, res) => {
  // Multipart handled by passing raw body — in practice use a dedicated proxy lib
  // For simplicity, forward JSON-only here; image handled separately
  const { status, data } = await proxyToApi('POST', '/api/news', req.body);
  res.status(status).json(data);
});

app.put('/api/admin/news/:id',   requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('PUT', `/api/news/${req.params.id}`, req.body);
  res.status(status).json(data);
});

app.delete('/api/admin/news/:id', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('DELETE', `/api/news/${req.params.id}`);
  res.status(status).json(data);
});

// --- Links proxy ---
app.get('/api/admin/links',        requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('GET', '/api/links');
  res.status(status).json(data);
});

app.post('/api/admin/links',       requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('POST', '/api/links', req.body);
  res.status(status).json(data);
});

app.delete('/api/admin/links/:id', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('DELETE', `/api/links/${req.params.id}`);
  res.status(status).json(data);
});

// Qiita refresh
app.post('/api/admin/qiita/refresh', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('POST', '/api/qiita/refresh', {});
  res.status(status).json(data);
});

app.listen(PORT, () => console.log(`Admin listening on :${PORT}`));
