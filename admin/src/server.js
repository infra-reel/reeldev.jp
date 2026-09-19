/**
 * reeldev.jp — Admin Panel Server
 * 修正内容:
 *   1. connect-sqlite3 でセッションをファイル永続化 (Pod再起動でも維持)
 *   2. app.set('trust proxy', 1) で Traefik 経由の HTTPS を正しく検知
 *   3. callback 後 session.save() を明示呼び出し → redirect 前に保存保証
 *   4. secure cookie は NODE_ENV=production かつ proxy 信頼時のみ有効
 */

import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.ADMIN_PORT || 3002;

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI || 'https://admin.reeldev.jp/auth/callback';
const ALLOWED_DISCORD_IDS   = (process.env.ALLOWED_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const API_BASE              = process.env.API_BASE || 'http://api-service:3001';
const ADMIN_API_KEY         = process.env.ADMIN_API_KEY;
const SESSION_DIR           = process.env.SESSION_DIR || '/data/sessions';
const IS_PROD               = process.env.NODE_ENV === 'production';

// セッション保存ディレクトリを確保
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── Trust proxy (Traefik がフロントに立つため必須) ────────────────────────
// これがないと req.secure = false になり secure cookie がブラウザに届かない
app.set('trust proxy', 1);

// ── SQLite セッションストア ───────────────────────────────────────────────
const SQLiteStore = connectSqlite3(session);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({
    dir:    SESSION_DIR,   // /data/sessions/sessions.db に永続化
    table:  'sessions',
    ttl:    86400,         // 1日 (秒)
    concurrentDB: true,
  }),
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,   // アクセスのたびに有効期限を延長
  name:              'reeldev.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   86400_000,     // 1日 (ms)
    // secure は trust proxy + HTTPS 環境で自動的に有効
    secure: IS_PROD,
  },
}));

app.use(express.static(path.join(__dirname, '../public')));

// ── Healthcheck (セッション不要) ──────────────────────────────────────────
app.get('/healthz', (_, res) => res.json({ ok: true }));

// ── Auth guard ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // API 呼び出しには 401、ページには /login リダイレクト
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
}

// ── Discord OAuth ──────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(500).send('DISCORD_CLIENT_ID が設定されていません');
  }
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
    // 1. code → access_token 交換
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

    if (!token.access_token) {
      console.error('Token exchange failed:', token);
      return res.redirect('/login.html?error=token_failed');
    }

    // 2. ユーザ情報取得
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await userRes.json();

    if (!user.id) {
      console.error('Failed to get Discord user:', user);
      return res.redirect('/login.html?error=user_fetch_failed');
    }

    // 3. 管理者チェック
    if (ALLOWED_DISCORD_IDS.length && !ALLOWED_DISCORD_IDS.includes(user.id)) {
      console.warn(`Discord ID ${user.id} (${user.username}) はアクセス拒否`);
      return res.redirect('/login.html?error=forbidden');
    }

    // 4. セッションに保存 — save() を await して redirect 前に書き込み完了を保証
    req.session.user = {
      id:       user.id,
      username: user.username,
      avatar:   user.avatar,
    };

    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    res.redirect('/');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.redirect('/login.html?error=oauth_error');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy error:', err);
    res.clearCookie('reeldev.sid');
    res.redirect('/login.html');
  });
});

// ── Session info ───────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// ── Proxy to backend API ───────────────────────────────────────────────────
async function proxyToApi(method, apiPath, body) {
  const headers = { 'x-api-key': ADMIN_API_KEY };
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const opts = { method, headers };
  if (body) opts.body = (body instanceof FormData) ? body : JSON.stringify(body);
  const r = await fetch(`${API_BASE}${apiPath}`, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// --- News proxy ---
app.get('/api/admin/news', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('GET', `/api/news?page=${req.query.page || 1}&limit=20`);
  res.status(status).json(data);
});

app.post('/api/admin/news', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('POST', '/api/news', req.body);
  res.status(status).json(data);
});

app.put('/api/admin/news/:id', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('PUT', `/api/news/${req.params.id}`, req.body);
  res.status(status).json(data);
});

app.delete('/api/admin/news/:id', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('DELETE', `/api/news/${req.params.id}`);
  res.status(status).json(data);
});

// --- Links proxy ---
app.get('/api/admin/links', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('GET', '/api/links');
  res.status(status).json(data);
});

app.post('/api/admin/links', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('POST', '/api/links', req.body);
  res.status(status).json(data);
});

app.delete('/api/admin/links/:id', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('DELETE', `/api/links/${req.params.id}`);
  res.status(status).json(data);
});

// --- Qiita refresh ---
app.post('/api/admin/qiita/refresh', requireAuth, async (req, res) => {
  const { status, data } = await proxyToApi('POST', '/api/qiita/refresh', {});
  res.status(status).json(data);
});

app.listen(PORT, () => {
  console.log(`Admin listening on :${PORT} (prod=${IS_PROD})`);
  console.log(`Session store: ${SESSION_DIR}/sessions.db`);
  console.log(`Allowed Discord IDs: ${ALLOWED_DISCORD_IDS.join(', ') || '(all — 要設定)'}`);
});
