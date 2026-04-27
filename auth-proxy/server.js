'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const httpProxy = require('http-proxy');

const users = require('./users');
const instances = require('./instances');
const adminApi = require('./admin-api');

// Returns true if the session user still exists and is not disabled.
function isSessionUserActive(sessionUser) {
  if (!sessionUser) return false;
  const dbUser = users.find(sessionUser.username);
  return !!(dbUser && !dbUser.disabled);
}

const PORT = parseInt(process.env.PORT || '8080', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'insecure-dev-secret-change-me';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'cs_sid';
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/config/sessions';
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === 'true';

// ----- Bootstrap admin if configured -----
(async () => {
  try {
    await users.bootstrap({
      username: process.env.BOOTSTRAP_ADMIN_USER,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD
    });
  } catch (e) {
    console.error('[bootstrap]', e.message);
  }
})();

// ----- Session middleware (reused in HTTP and WS upgrade) -----
const sessionStore = new FileStore({
  path: SESSIONS_DIR,
  ttl: 7 * 24 * 3600,
  retries: 1,
  logFn: () => {}
});

const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
    // secure: true,  // включите при HTTPS
  }
});

// ----- Proxy (HTTP + WS) -----
const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false
});
proxy.on('error', (err, req, res) => {
  console.error('[proxy]', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('code-server недоступен: ' + err.message);
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
});

// ----- Express app -----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(sessionMiddleware);

// Стаические ресурсы панели — по префиксу /_auth, чтобы не конфликтовать с code-server
app.use('/_auth/static', express.static(path.join(__dirname, 'public'), {
  etag: true, maxAge: '1h'
}));

// ---- Login ----
app.get('/_auth/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/_auth/login',
  bodyParser.urlencoded({ extended: false, limit: '16kb' }),
  async (req, res) => {
    try {
      const { username = '', password = '' } = req.body;
      const user = await users.verify(String(username).toLowerCase().trim(), String(password));
      if (!user) {
        return res.redirect('/_auth/login?e=1');
      }
      req.session.regenerate(err => {
        if (err) return res.status(500).send('Session error');
        req.session.user = user;
        req.session.save(() => {
          // Стартуем code-server для пользователя заранее, не блокируя редирект
          instances.ensureRunning(user.username).catch(e =>
            console.error(`[login] start instance failed for ${user.username}:`, e.message)
          );
          const redirect = (req.query.next && /^\/[^/\\]/.test(req.query.next)) ? req.query.next : '/';
          res.redirect(redirect);
        });
      });
    } catch (e) {
      console.error('[login]', e);
      res.status(500).send('Login error');
    }
  }
);

app.post('/_auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.redirect('/_auth/login');
  });
});

// Удобство: GET-logout тоже работает (кнопка-ссылка)
app.get('/_auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.redirect('/_auth/login');
  });
});

// ---- Registration (optional, enabled via ALLOW_REGISTRATION=true) ----
app.get('/_auth/register', (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(404).send('Registration is disabled');
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/_auth/register',
  bodyParser.json({ limit: '16kb' }),
  async (req, res) => {
    if (!ALLOW_REGISTRATION) return res.status(404).json({ error: 'Registration is disabled' });
    if (req.session.user) return res.status(400).json({ error: 'Already logged in' });
    try {
      const { username = '', password = '' } = req.body || {};
      const user = await users.add({
        username: String(username).toLowerCase().trim(),
        password: String(password),
        isAdmin: false
      });
      req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error' });
        req.session.user = user;
        req.session.save(() => {
          instances.ensureRunning(user.username).catch(e =>
            console.error(`[register] start instance failed for ${user.username}:`, e.message)
          );
          res.json({ ok: true });
        });
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
);

// ---- Account panel (переключение пользователя / смена пароля) ----
app.get('/_auth/account', (req, res) => {
  if (!req.session.user) return res.redirect('/_auth/login?next=' + encodeURIComponent('/_auth/account'));
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

// ---- Admin panel ----
app.get('/_auth/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/_auth/login?next=' + encodeURIComponent('/_auth/admin'));
  if (!req.session.user.isAdmin) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- API ----
app.use('/_auth/api', adminApi);

// ---- Root: serve iframe wrapper (panel below code-server, no overlap) ----
// GET / without ?__cs=1 → wrapper page; with ?__cs=1 → fall through to proxy
app.get('/', (req, res, next) => {
  if (!req.session.user) return res.redirect('/_auth/login?next=' + encodeURIComponent('/'));
  if (req.query.__cs === '1') return next();
  res.sendFile(path.join(__dirname, 'public', 'frame.html'));
});

// ---- Everything else: proxy to the user's code-server ----
app.use(async (req, res) => {
  if (!req.session.user) {
    const next = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/_auth/login?next=${next}`);
  }
  // Reject if the user was deleted or disabled after the session was created.
  if (!isSessionUserActive(req.session.user)) {
    req.session.destroy(() => {});
    return res.redirect('/_auth/login');
  }
  try {
    const inst = await instances.ensureRunning(req.session.user.username);
    instances.touch(req.session.user.username);
    proxy.web(req, res, { target: `http://127.0.0.1:${inst.port}` });
  } catch (e) {
    console.error('[proxy-start]', e);
    res.status(500).send('Не удалось запустить code-server: ' + e.message);
  }
});

// ----- HTTP server with WS upgrade handling -----
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  // Восстанавливаем сессию по cookie
  const fakeRes = {
    getHeader() {}, setHeader() {}, end() {}, writeHead() {}
  };
  sessionMiddleware(req, fakeRes, async () => {
    const user = req.session?.user;
    if (!user || !isSessionUserActive(user)) { socket.destroy(); return; }
    try {
      const inst = await instances.ensureRunning(user.username);
      instances.touch(user.username);
      proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${inst.port}` });
    } catch (e) {
      console.error('[ws-upgrade]', e.message);
      try { socket.destroy(); } catch (_) { /* ignore */ }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[auth-proxy] listening on 0.0.0.0:${PORT}`);
});

function shutdown(sig) {
  console.log(`[auth-proxy] received ${sig}, shutting down…`);
  instances.shutdownAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
