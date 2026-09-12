import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HostedState, readMasterKey, passwordMatches, passwordHash, newToken, digest, fail, publicAccount, publicGrant, audit, iso } from './lib/hosted/state.mjs';
import { HostedPlatform } from './lib/hosted/platform.mjs';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SESSION_MS = 12 * 3600000;
const ASSETS = new Map([['/', 'admin.html'], ['/admin', 'admin.html'], ['/inbox', 'inbox.html'], ['/ui/admin.js', 'admin.js'], ['/ui/inbox.js', 'inbox.js'], ['/ui/shared.js', 'shared.js'], ['/ui/site.css', 'site.css']]);

async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON_REQUIRED');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 256000) fail(413, 'BODY_TOO_LARGE'); chunks.push(c); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON'); return value; }
  catch { fail(400, 'INVALID_JSON'); }
}
function cookie(req, name) { return String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || ''; }
function bearer(req) { return /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1] || ''; }
function send(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function originValue(value, allowHttp) {
  const u = new URL(value);
  if (u.origin !== value || u.username || u.password || (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('EXPLICIT_HTTPS_ORIGIN_REQUIRED');
  return u;
}
export function createHostedServer({ platform, adminOrigin, mailOrigin = adminOrigin, allowHttp = false }) {
  const adminURL = originValue(adminOrigin, allowHttp), mailURL = originValue(mailOrigin, allowHttp);
  if (!allowHttp && adminURL.hostname === mailURL.hostname) throw new Error('SEPARATE_ADMIN_AND_MAIL_HOSTS_REQUIRED');
  const sessions = new Map(), rates = new Map();
  const secure = adminURL.protocol === 'https:';
  const cookieName = kind => `${secure ? '__Host-' : ''}md_${kind}`;
  function sessionCookie(res, kind, token, clear = false) {
    res.setHeader('Set-Cookie', `${cookieName(kind)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  }
  function rate(req, group, limit) {
    const key = `${req.socket.remoteAddress}:${group}`;
    const now = Date.now(), entry = rates.get(key);
    if (!entry || entry.until < now) rates.set(key, { count: 1, until: now + 60000 });
    else if (++entry.count > limit) fail(429, 'RATE_LIMITED');
    if (rates.size > 5000) for (const [k, v] of rates) if (v.until < now) rates.delete(k);
  }
  function origin(req, expected) { if (req.headers.origin !== expected) fail(403, 'ORIGIN_REJECTED'); }
  function createSession(kind, data, res) {
    for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
    if (sessions.size >= 2000) fail(503, 'SESSION_CAPACITY');
    const token = newToken('ses'), csrf = newToken('csrf');
    sessions.set(digest(token), { kind, ...data, csrf, expires: Date.now() + SESSION_MS });
    sessionCookie(res, kind, token); return csrf;
  }
  function session(req, kind) {
    const id = digest(cookie(req, cookieName(kind))), s = sessions.get(id);
    if (!s || s.kind !== kind || s.expires < Date.now()) { sessions.delete(id); fail(401, 'LOGIN_REQUIRED'); }
    return s;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url || '/', 'http://internal'), path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') { await platform.state.read(); return send(res, 200, { ok: true }); }
      if (![adminURL.host, mailURL.host].includes(req.headers.host)) fail(400, 'HOST_REJECTED');
      if (url.search) fail(400, 'QUERY_NOT_SUPPORTED'); // Credentials are never URL parameters.
      rate(req, 'all', 1800);
      if (path.startsWith('/admin-api/') && req.headers.host !== adminURL.host) fail(404, 'NOT_FOUND');
      if (path.startsWith('/mail-api/') && req.headers.host !== mailURL.host) fail(404, 'NOT_FOUND');
      if (path === '/admin-api/login' && req.method === 'POST') {
        origin(req, adminOrigin); rate(req, 'admin-login', 8);
        const b = await body(req), s = await platform.state.read();
        const valid = await passwordMatches(b.password, s.admin.passwordHash);
        if (!valid || b.username !== s.admin.username) fail(401, 'INVALID_LOGIN');
        return send(res, 200, { csrf: createSession('admin', { version: s.admin.version }, res) });
      }
      if (path === '/bridge/v1/sync' && req.method === 'POST') {
        if (req.headers.host !== adminURL.host) fail(404, 'NOT_FOUND');
        rate(req, 'cookie-upload', 60);
        const token = bearer(req), key = await platform.authenticateKey(token, 'upload');
        const b = await body(req);
        if (b.expectedAccountId && b.expectedAccountId !== key.accountId) fail(409, 'ACCOUNT_IDENTITY_MISMATCH');
        return send(res, 200, await platform.syncCookies(token, b.cookies));
      }
      if (path === '/mail-api/login' && req.method === 'POST') {
        origin(req, mailOrigin); rate(req, 'mail-login', 30);
        const g = await platform.authorizeGrant((await body(req)).token);
        await platform.checkGrant(g.id, g.revision);
        createSession('mail', { grantId: g.id, revision: g.revision }, res);
        return send(res, 200, { email: g.email, expiresAt: null });
      }
      if (path.startsWith('/mail-api/')) {
        const s = session(req, 'mail');
        if (path === '/mail-api/logout' && req.method === 'POST') { origin(req, mailOrigin); sessions.delete(digest(cookie(req, cookieName('mail')))); sessionCookie(res, 'mail', '', true); return send(res, 200, { ok: true }); }
        const g = await platform.checkGrant(s.grantId, s.revision);
        if (path !== '/mail-api/messages' || req.method !== 'GET') fail(404, 'NOT_FOUND');
        rate(req, `mail:${g.id}`, 20);
        const messages = await platform.messages(g.accountId, g.emailId, g.since);
        // Authorization is checked again after IMAP I/O: revoke during a slow fetch is effective.
        await platform.checkGrant(s.grantId, s.revision);
        await platform.state.mutate(st => { const item = st.grants.find(item => item.id === g.id); if (item && (!item.lastUsedAt || Date.parse(item.lastUsedAt) + 60000 < Date.now())) item.lastUsedAt = iso(); });
        return send(res, 200, { email: g.email, expiresAt: null, messages });
      }
      if (path.startsWith('/admin-api/')) {
        let principal;
        const token = bearer(req);
        if (token) principal = await platform.authenticateKey(token, 'program');
        else {
          principal = session(req, 'admin');
          if (principal.version !== (await platform.state.read()).admin.version) fail(401, 'LOGIN_REQUIRED');
          if (!['GET', 'HEAD'].includes(req.method)) { origin(req, adminOrigin); if (req.headers['x-csrf-token'] !== principal.csrf) fail(403, 'CSRF_REJECTED'); }
        }
        const match = /^\/admin-api\/accounts\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(path);
        const accountId = match?.[1], suffix = match?.[2] || '';
        if (principal.kind === 'program') {
          const scope = suffix === 'inventory' && req.method === 'GET' ? 'inventory:read' : /^emails\/[0-9a-f-]{36}\/messages$/.test(suffix) && req.method === 'GET' ? 'mail:read' : suffix === 'generate' && req.method === 'POST' ? 'generate' : '';
          if (!accountId || principal.accountId !== accountId || !principal.scopes.includes(scope)) fail(403, 'SCOPE_REJECTED');
          await platform.markKeyUsed(principal.id);
        }
        if (path === '/admin-api/session' && req.method === 'GET') return send(res, 200, { csrf: principal.csrf });
        if (path === '/admin-api/logout' && req.method === 'POST') { sessions.delete(digest(cookie(req, cookieName('admin')))); sessionCookie(res, 'admin', '', true); return send(res, 200, { ok: true }); }
        if (path === '/admin-api/password' && req.method === 'POST') {
          const b = await body(req), current = (await platform.state.read()).admin;
          if (!await passwordMatches(b.currentPassword, current.passwordHash)) fail(401, 'INVALID_LOGIN');
          const hash = await passwordHash(b.newPassword);
          await platform.state.mutate(s => { s.admin.passwordHash = hash; s.admin.version++; audit(s, 'admin.password_changed'); });
          return send(res, 200, { loginRequired: true });
        }
        if (path === '/admin-api/accounts' && req.method === 'POST') return send(res, 201, await platform.addAccount(await body(req)));
        if (path === '/admin-api/inventory' && req.method === 'GET') return send(res, 200, { accounts: await platform.inventory(undefined, { includeSettings: true }) });
        if (path === '/admin-api/scan-mail' && req.method === 'POST') return send(res, 200, { results: await platform.scanAll() });
        if (path === '/admin-api/keys' && req.method === 'GET') return send(res, 200, { keys: (await platform.state.read()).keys.map(({ hash, ...k }) => k) });
        if (path === '/admin-api/grants' && req.method === 'GET') return send(res, 200, { grants: (await platform.state.read()).grants.map(publicGrant) });
        if (path === '/admin-api/audit' && req.method === 'GET') return send(res, 200, { events: (await platform.state.read()).audit.slice(-200).reverse() });
        const keyAction = /^\/admin-api\/keys\/([0-9a-f-]{36})\/revoke$/.exec(path);
        if (keyAction && req.method === 'POST') {
          await platform.state.mutate(s => { const k = s.keys.find(k => k.id === keyAction[1]); if (!k) fail(404, 'KEY_NOT_FOUND'); k.revoked = true; audit(s, 'key.revoke', k.accountId, k.id); });
          return send(res, 200, { ok: true });
        }
        const grantAction = /^\/admin-api\/grants\/([0-9a-f-]{36})\/(reset|revoke)$/.exec(path);
        if (grantAction && req.method === 'POST') return send(res, 200, await platform.changeGrant(grantAction[1], grantAction[2]));
        if (accountId) {
          await platform.account(accountId);
          if (!suffix && req.method === 'PATCH') return send(res, 200, await platform.updateAccount(accountId, await body(req)));
          if (suffix === 'inventory' && req.method === 'GET') return send(res, 200, { accounts: await platform.inventory(accountId) });
          if (suffix === 'keys' && req.method === 'POST') { const b = await body(req); return send(res, 201, await platform.createKey(accountId, b.kind, b.name, b.scopes)); }
          if (suffix === 'distribute' && req.method === 'POST') { const b = await body(req); return send(res, 201, { grants: await platform.distribute(accountId, b.emailIds, b.recipient, b.includeHistory ?? false), inboxUrl: `${mailOrigin}/inbox` }); }
          if (suffix === 'sync' && req.method === 'POST') return send(res, 200, await platform.syncInventory(accountId));
          if (suffix === 'scan-mail' && req.method === 'POST') return send(res, 200, await platform.scanMail(accountId));
          if (suffix === 'auto-stock' && req.method === 'PATCH') {
            const b = await body(req); if (b.enabled && (await platform.account(accountId)).paused) fail(409, 'ACCOUNT_PAUSED');
            return send(res, 200, await platform.runtime(accountId).autoStock.configure(b));
          }
          if (suffix === 'generate' && req.method === 'POST') return send(res, 200, await platform.runtime(accountId).autoStock.manualOne((await body(req)).label));
          const email = /^emails\/([0-9a-f-]{36})\/messages$/.exec(suffix);
          if (email && req.method === 'GET') return send(res, 200, { messages: await platform.messages(accountId, email[1]) });
        }
        fail(404, 'NOT_FOUND');
      }
      if (req.method !== 'GET' || !ASSETS.has(path)) fail(404, 'NOT_FOUND');
      const file = ASSETS.get(path);
      if (file === 'admin.html' && req.headers.host !== adminURL.host) fail(404, 'NOT_FOUND');
      if (file === 'inbox.html' && req.headers.host !== mailURL.host) fail(404, 'NOT_FOUND');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
      res.end(await readFile(join(ROOT, 'web', file)));
    } catch (e) {
      // Never forward upstream response/error text: it can contain cookies, IMAP secrets or mail.
      const code = e.code && /^[A-Z][A-Z0-9_]{1,70}$/.test(e.code) ? e.code : 'REQUEST_FAILED';
      send(res, Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500, { error: code });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const state = new HostedState(join(dataDir, 'platform.enc'), await readMasterKey(process.env.MASTER_KEY_FILE || './secrets/master-key'));
  await state.read();
  const platform = new HostedPlatform({ state, dataDir });
  const server = createHostedServer({ platform, adminOrigin: process.env.PUBLIC_ORIGIN, mailOrigin: process.env.MAIL_ORIGIN || process.env.PUBLIC_ORIGIN });
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', async () => { await platform.start(); console.log('Hosted dashboard ready'); });
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
    server.close(); await platform.stop(); server.closeAllConnections(); clearTimeout(deadline);
  });
}
