import { join } from 'node:path';
import { DashboardStore } from '../dashboard-store.mjs';
import { AutoStockService } from '../auto-stock-service.mjs';
import { ForwardMailboxReader, normalizeForwardMailboxConfig } from '../forward-mailbox.mjs';
import { accountIn, audit, digest, fail, iso, newId, newToken, publicAccount, publicGrant } from './state.mjs';
import { AccountICloud, cookieHeader, verifyAppleIdentity } from './icloud.mjs';

const text = (v, max = 120) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, 'INVALID_TEXT'); return v.trim(); };
export class HostedPlatform {
  constructor({ state, dataDir, verifyIdentity = verifyAppleIdentity, mailReaderFactory, cloudFactory, autoOptions = {} }) {
    Object.assign(this, { state, dataDir, verifyIdentity, mailReaderFactory, cloudFactory, autoOptions });
    this.runtimes = new Map(); this.syncQueues = new Map(); this.mailCache = new Map(); this.started = false;
  }
  async account(id) { return accountIn(await this.state.read(), id); }
  runtime(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(404, 'ACCOUNT_NOT_FOUND');
    if (!this.runtimes.has(id)) {
      const store = new DashboardStore({ statePath: join(this.dataDir, 'accounts', id, 'dashboard-state-v1.json'), backupDir: join(this.dataDir, 'accounts', id, 'backups'), allowMissing: false });
      const getAccount = () => this.account(id);
      const cloud = this.cloudFactory?.({ getAccount, store }) || new AccountICloud({ getAccount, store });
      const reader = this.mailReaderFactory?.(id) || new ForwardMailboxReader({ strictRecipients: true, configProvider: async () => (await getAccount()).forward });
      const autoStock = new AutoStockService({ store, generateOne: label => cloud.generate(label), generateBatch: labels => cloud.generateBatch(labels), ...this.autoOptions });
      this.runtimes.set(id, { store, cloud, reader, autoStock });
      if (this.started) autoStock.start();
    }
    return this.runtimes.get(id);
  }
  async start() {
    if (this.started) return; this.started = true;
    for (const a of (await this.state.read()).accounts) this.runtime(a.id).autoStock.start();
    this.mailTimer = setInterval(() => { void this.scanAll().catch(() => {}); }, 60000); this.mailTimer.unref?.();
  }
  async stop() { this.started = false; clearInterval(this.mailTimer); await Promise.all([...this.runtimes.values()].map(async r => { await r.autoStock.stop(); await r.scanning?.catch(() => {}); })); await this.state.idle(); }
  async scanAll() {
    const accounts = (await this.state.read()).accounts.filter(a => !a.paused && a.forward);
    return Promise.all(accounts.map(a => this.scanMail(a.id).catch(() => ({ accountId: a.id, error: 'MAIL_SCAN_UNAVAILABLE' }))));
  }
  async scanMail(id) {
    const a = await this.account(id); if (a.paused) fail(409, 'ACCOUNT_PAUSED');
    const r = this.runtime(id); if (r.scanning) return r.scanning;
    r.scanning = (async () => {
      const rows = (await r.store.read()).inventory.filter(i => i.group !== 'trash' && i.isActive !== false);
      const result = await r.reader.latestForAliases(rows.map(i => i.email));
      const entries = rows.flatMap(i => {
        const m = result.messages[i.email.toLowerCase()]; if (!m) return [];
        const isNew = !i.receivedAt || Date.parse(m.receivedAt) > Date.parse(i.receivedAt);
        return [{ id: i.id, expectedGroup: i.group, patch: { receivedAt: m.receivedAt, subject: m.subject, preview: String(m.text || '').slice(0, 4000), code: m.codes?.[0] || '', lastCheckedAt: iso(), statusType: 'ok', statusMessage: '已扫描转发收件', ...(isNew ? { unread: true } : {}) } }];
      });
      await r.store.updateInventoryItems(entries);
      await this.state.mutate(s => { const a = accountIn(s, id); a.mailStatus = result.truncated ? 'scan_window_truncated' : 'ok'; a.lastMailScanAt = iso(); });
      return { accountId: id, checked: rows.length, matched: entries.length, truncated: result.truncated };
    })().catch(async e => { await this.state.mutate(s => { accountIn(s, id).mailStatus = 'unavailable'; }); throw e; }).finally(() => { r.scanning = null; });
    return r.scanning;
  }
  async addAccount(body) {
    const name = text(body.name, 60), expectedAppleId = text(body.appleId, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAppleId)) fail(400, 'INVALID_APPLE_ID');
    const account = { id: newId(), name, expectedAppleId, color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#18796b', region: body.region === 'china' ? 'china' : 'global', paused: true, createdAt: iso() };
    await this.state.mutate(async s => {
      if (s.accounts.some(a => a.expectedAppleId === expectedAppleId)) fail(409, 'ACCOUNT_ALREADY_EXISTS');
      // Only explicit account creation initializes storage. Missing files after that
      // are an error, never a signal to silently recreate an empty inventory.
      const initial = new DashboardStore({ statePath: join(this.dataDir, 'accounts', account.id, 'dashboard-state-v1.json'), backupDir: join(this.dataDir, 'accounts', account.id, 'backups') });
      await initial.mutate(() => {});
      s.accounts.push(account); audit(s, 'account.create', account.id);
    });
    this.runtime(account.id);
    return publicAccount(account);
  }
  async updateAccount(id, patch) {
    // Identity/region are immutable: rebinding never happens via a regular settings update.
    return this.state.mutate(s => {
      const a = accountIn(s, id);
      if (Object.hasOwn(patch, 'name')) a.name = text(patch.name, 60);
      if (Object.hasOwn(patch, 'paused')) {
        if (typeof patch.paused !== 'boolean') fail(400, 'INVALID_PAUSE');
        if (!patch.paused && !a.identity) fail(409, 'ACCOUNT_NOT_BOUND');
        a.paused = patch.paused;
      }
      if (Object.hasOwn(patch, 'forward')) {
        const input = { ...patch.forward };
        if (!input.password && a.forward && (input.host !== a.forward.host || input.email !== a.forward.email || Number(input.port) !== a.forward.port)) fail(400, 'NEW_IMAP_PASSWORD_REQUIRED');
        if (!input.password && a.forward) input.password = a.forward.password;
        const config = normalizeForwardMailboxConfig(input);
        if (!config.secure) fail(400, 'IMAP_TLS_REQUIRED');
        a.forward = config;
        for (const key of this.mailCache.keys()) if (key.startsWith(`${id}:`)) this.mailCache.delete(key);
      }
      audit(s, 'account.configure', id); return publicAccount(a);
    });
  }
  async inventory(accountId, { includeSettings = false } = {}) {
    const s = await this.state.read();
    const accounts = accountId ? [accountIn(s, accountId)] : s.accounts;
    return Promise.all(accounts.map(async a => {
      try {
        const r = this.runtime(a.id), inv = await r.store.read();
        return { ...publicAccount(a), ...(includeSettings ? { forwardSettings: a.forward ? { email: a.forward.email, host: a.forward.host, port: a.forward.port } : null } : {}), autoStock: await r.autoStock.status(), inventory: inv.inventory.map(item => ({ ...item, accountId: a.id, distribution: publicGrant(s.grants.find(g => g.accountId === a.id && g.emailId === item.id) || { status: 'unassigned' }) })) };
      } catch { return { ...publicAccount(a), inventory: [], error: 'ACCOUNT_STORAGE_UNAVAILABLE' }; }
    }));
  }
  async createKey(id, kind, label, scopes = []) {
    if (!['upload', 'program'].includes(kind)) fail(400, 'INVALID_KEY_KIND');
    const allowed = ['inventory:read', 'mail:read', 'generate'];
    if (kind === 'program' && (!Array.isArray(scopes) || !scopes.length || scopes.some(v => !allowed.includes(v)))) fail(400, 'INVALID_SCOPE');
    const token = newToken(kind === 'upload' ? 'upl' : 'api');
    const key = { id: newId(), accountId: id, kind, name: text(label), scopes: kind === 'upload' ? ['cookies:write'] : scopes, hash: digest(token), mask: token.slice(0, 8) + '…' + token.slice(-4), createdAt: iso(), revoked: false };
    await this.state.mutate(s => { accountIn(s, id); s.keys.push(key); audit(s, 'key.create', id, key.id); });
    const { hash, ...safe } = key;
    return { ...safe, token };
  }
  async authenticateKey(token, kind) {
    const s = await this.state.read();
    const key = s.keys.find(k => !k.revoked && k.kind === kind && k.hash === digest(token));
    if (!key) fail(401, 'INVALID_KEY');
    return key;
  }
  async markKeyUsed(id) {
    await this.state.mutate(s => { const key = s.keys.find(k => k.id === id && !k.revoked); if (!key) fail(401, 'INVALID_KEY'); if (!key.lastUsedAt || Date.parse(key.lastUsedAt) + 60000 < Date.now()) key.lastUsedAt = iso(); });
  }
  async syncCookies(token, cookies) {
    const key = await this.authenticateKey(token, 'upload');
    const job = async () => {
      const header = cookieHeader(cookies), before = await this.account(key.accountId);
      let identity;
      try { identity = await this.verifyIdentity(header, before.region); }
      catch (e) {
        await this.state.mutate(s => { accountIn(s, key.accountId).cookieStatus = 'verification_failed'; audit(s, 'cookies.verify_failed', key.accountId); });
        throw e;
      }
      return this.state.mutate(s => {
        const currentKey = s.keys.find(k => k.id === key.id && !k.revoked);
        if (!currentKey) fail(401, 'INVALID_KEY');
        const a = accountIn(s, key.accountId);
        if (identity.appleId !== a.expectedAppleId || (a.identity && a.identity.dsid !== identity.dsid)) fail(409, 'ACCOUNT_IDENTITY_MISMATCH');
        if (s.accounts.some(other => other.id !== a.id && other.identity?.dsid === identity.dsid)) fail(409, 'IDENTITY_ALREADY_BOUND');
        a.identity = identity; a.cookieHeader = header; a.lastSyncedAt = iso(); a.cookieStatus = 'verified'; currentKey.lastUsedAt = iso();
        audit(s, 'cookies.sync', a.id); return { ok: true, account: publicAccount(a), count: cookies.length };
      });
    };
    const promise = (this.syncQueues.get(key.accountId) || Promise.resolve()).then(job);
    this.syncQueues.set(key.accountId, promise.catch(() => {}));
    return promise;
  }
  async syncInventory(id) {
    await this.account(id);
    const r = this.runtime(id), aliases = await r.cloud.list();
    await r.store.syncAliases(aliases); await r.autoStock.reconciled();
    return { synced: aliases.length };
  }
  async distribute(id, ids, recipient, includeHistory = false) {
    await this.account(id);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail(400, 'INVALID_EMAIL_SELECTION');
    const inventory = (await this.runtime(id).store.read()).inventory;
    const rows = ids.map(emailId => {
      const item = inventory.find(i => i.id === emailId && i.isActive !== false && i.group !== 'trash');
      if (!item) fail(404, 'EMAIL_NOT_AVAILABLE');
      return item;
    });
    recipient = text(recipient);
    if (typeof includeHistory !== 'boolean') fail(400, 'INVALID_HISTORY_OPTION');
    return this.state.mutate(s => {
      accountIn(s, id);
      if (rows.some(row => s.grants.some(g => g.accountId === id && g.emailId === row.id))) fail(409, 'ALREADY_DISTRIBUTED_RESET_EXISTING');
      return rows.map(row => {
        const token = newToken('mbx'), at = iso();
        const grant = { id: newId(), accountId: id, emailId: row.id, email: row.email, recipient, status: 'active', createdAt: at, since: includeHistory ? null : at, expiresAt: null, revision: 1, mask: token.slice(0, 8) + '…' + token.slice(-4), tokenHash: digest(token) };
        s.grants.push(grant); audit(s, 'mailbox.distribute', id, grant.id);
        return { ...publicGrant(grant), token };
      });
    });
  }
  async changeGrant(id, action) {
    if (!['revoke', 'reset'].includes(action)) fail(400, 'INVALID_GRANT_ACTION');
    return this.state.mutate(s => {
      const g = s.grants.find(g => g.id === id); if (!g) fail(404, 'GRANT_NOT_FOUND');
      g.revision++; g.updatedAt = iso();
      if (action === 'revoke') { g.status = 'revoked'; g.tokenHash = ''; audit(s, 'mailbox.revoke', g.accountId, id); return publicGrant(g); }
      const token = newToken('mbx'); g.status = 'active'; g.tokenHash = digest(token); g.mask = token.slice(0, 8) + '…' + token.slice(-4);
      audit(s, 'mailbox.reset_same_recipient', g.accountId, id); return { ...publicGrant(g), token };
    });
  }
  async authorizeGrant(token) {
    const s = await this.state.read();
    const grant = s.grants.find(g => g.status === 'active' && g.tokenHash === digest(token));
    if (!grant) fail(401, 'INVALID_MAIL_TOKEN');
    return grant;
  }
  async checkGrant(id, revision) {
    const s = await this.state.read(), g = s.grants.find(g => g.id === id && g.revision === revision && g.status === 'active');
    if (!g) fail(401, 'MAIL_ACCESS_REVOKED');
    if (accountIn(s, g.accountId).paused) fail(503, 'ACCOUNT_PAUSED');
    const item = (await this.runtime(g.accountId).store.read()).inventory.find(i => i.id === g.emailId && i.email === g.email && i.isActive !== false && i.group !== 'trash');
    if (!item) fail(404, 'MAILBOX_UNAVAILABLE');
    return g;
  }
  async messages(accountId, emailId, since = null) {
    const a = await this.account(accountId);
    if (a.paused) fail(503, 'ACCOUNT_PAUSED');
    const r = this.runtime(accountId), item = (await r.store.read()).inventory.find(i => i.id === emailId);
    if (!item) fail(404, 'EMAIL_NOT_FOUND');
    const cacheKey = `${accountId}:${emailId}:${since || ''}`;
    const cached = this.mailCache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.promise;
    // Include tenant and grant time boundary in cache identity. No shared mailbox fallback.
    const promise = r.reader.listForAlias(item.email, { limit: 50, strictRecipients: true, since }).then(rows => rows.map(m => ({ subject: m.subject, from: m.from, receivedAt: m.receivedAt, text: String(m.text || '').slice(0, 100000), codes: m.codes || [] }))).catch(e => { this.mailCache.delete(cacheKey); throw e; });
    if (this.mailCache.size > 1000) this.mailCache.delete(this.mailCache.keys().next().value);
    this.mailCache.set(cacheKey, { until: Date.now() + 10000, promise });
    return promise;
  }
}
