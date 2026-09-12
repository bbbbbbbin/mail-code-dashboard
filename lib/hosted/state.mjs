import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const newToken = prefix => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const newId = () => randomUUID();
export const iso = () => new Date().toISOString();
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) fail(400, 'PASSWORD_LENGTH_14_256');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, value] = String(stored).split(':');
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(value || '', 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function readMasterKey(path) {
  const key = Buffer.from((await readFile(path, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY_MUST_BE_32_BYTES');
  return key;
}
export class HostedState {
  #path; #key; #queue = Promise.resolve();
  constructor(path, key) { this.#path = path; this.#key = key; }
  async read() {
    // Missing/corrupt state is never replaced with an empty installation.
    const envelope = JSON.parse(await readFile(this.#path, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from('mail-dashboard-hosted-v1'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
    if (state.version !== 1 || !state.admin || !Array.isArray(state.accounts) || !Array.isArray(state.grants) || !Array.isArray(state.keys)) throw new Error('INVALID_HOSTED_STATE');
    return state;
  }
  async #write(state, exclusive = false) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('mail-dashboard-hosted-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const data = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    if (exclusive) return writeFile(this.#path, data, { mode: 0o600, flag: 'wx' });
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await rename(temp, this.#path);
  }
  async initialize(username, password) {
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) fail(400, 'INVALID_USERNAME');
    await this.#write({ version: 1, admin: { username, passwordHash: await passwordHash(password), version: 1 }, accounts: [], keys: [], grants: [], audit: [] }, true);
  }
  mutate(fn) {
    const operation = this.#queue.then(async () => {
      const state = await this.read();
      const result = await fn(state);
      await this.#write(state);
      return structuredClone(result);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  idle() { return this.#queue; }
}
export function audit(state, action, accountId = null, objectId = null) {
  state.audit.push({ at: iso(), action, accountId, objectId });
  state.audit = state.audit.slice(-5000);
}
export function accountIn(state, id) {
  const account = state.accounts.find(a => a.id === id);
  if (!account) fail(404, 'ACCOUNT_NOT_FOUND');
  return account;
}
export function publicAccount(a) {
  return { id: a.id, name: a.name, color: a.color, region: a.region, expectedAppleId: a.expectedAppleId,
    bound: Boolean(a.identity), paused: a.paused, lastSyncedAt: a.lastSyncedAt || null,
    mailStatus: a.mailStatus || 'not_checked', lastMailScanAt: a.lastMailScanAt || null,
    forwardConfigured: Boolean(a.forward), cookieStatus: a.cookieStatus || 'not_synced' };
}
export function publicGrant(g) {
  const { tokenHash, ...safe } = g;
  return safe;
}
