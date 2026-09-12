import { fail } from './state.mjs';
const NAMES = ['X-APPLE-DS-WEB-SESSION-TOKEN', 'X-APPLE-WEBAUTH-TOKEN', 'X-APPLE-WEBAUTH-PCS-Mail', 'X-APPLE-WEBAUTH-HSA-TRUST', 'X-APPLE-WEBAUTH-LOGIN', 'X-APPLE-WEBAUTH-USER'];
function mailOrigin(value, region) {
  let url;
  try { url = new URL(value); } catch { fail(502, 'APPLE_HME_SERVICE_UNAVAILABLE'); }
  const suffix = region === 'china' ? 'icloud.com.cn' : 'icloud.com';
  const host = /^(?:p\d+-)?maildomainws\.(icloud\.com(?:\.cn)?)$/.exec(url.hostname);
  if (url.protocol !== 'https:' || !host || host[1] !== suffix || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail(502, 'APPLE_HME_SERVICE_UNAVAILABLE');
  return url.origin;
}
export function cookieHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 100) fail(400, 'INVALID_COOKIES');
  const found = new Map();
  for (const c of cookies) {
    const name = NAMES.find(n => n.toLowerCase() === String(c?.name).toLowerCase());
    if (!name) continue;
    if (typeof c.value !== 'string' || !c.value.trim() || /[\x00-\x20\x7f;]/.test(c.value) || c.value.length > 16000) fail(400, 'INVALID_COOKIES');
    if (found.has(name) && found.get(name) !== c.value) fail(400, 'AMBIGUOUS_COOKIES');
    found.set(name, c.value);
  }
  if (!found.has(NAMES[0]) || !found.has(NAMES[1])) fail(400, 'INCOMPLETE_COOKIES');
  return [...found].map(([n, v]) => `${n}=${v}`).join(';');
}
export async function verifyAppleIdentity(header, region = 'global', fetchImpl = fetch) {
  const suffix = region === 'china' ? '.com.cn' : '.com';
  let response, data;
  try {
    response = await fetchImpl(`https://setup.icloud${suffix}/setup/ws/1/validate`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), body: '{}',
      headers: { Cookie: header, 'Content-Type': 'text/plain', Origin: `https://www.icloud${suffix}`, Referer: `https://www.icloud${suffix}/` }
    });
    data = await response.json();
  } catch { fail(502, 'APPLE_VERIFICATION_UNAVAILABLE'); }
  const dsid = String(data?.dsInfo?.dsid || '');
  const appleId = String(data?.dsInfo?.appleId || '').toLowerCase().trim();
  if (!response.ok || !/^[0-9]+$/.test(dsid) || !appleId.includes('@') || data.hsaChallengeRequired) fail(401, 'APPLE_LOGIN_REQUIRED');
  // Learn the per-account shard from Apple's authenticated response, never upload metadata.
  const service = data.webservices?.premiummailsettings?.url;
  return { dsid, appleId, hmeOrigin: service ? mailOrigin(service, region) : null };
}
export class AccountICloud {
  constructor({ getAccount, store, fetchImpl = fetch }) { this.getAccount = getAccount; this.store = store; this.fetch = fetchImpl; }
  async request(path, body) {
    const a = await this.getAccount();
    if (!a.identity || !a.cookieHeader || a.paused) fail(409, 'ACCOUNT_NOT_READY');
    const suffix = a.region === 'china' ? '.com.cn' : '.com';
    const root = mailOrigin(a.identity.hmeOrigin, a.region);
    const url = `${root}/${path}?dsid=${encodeURIComponent(a.identity.dsid)}`;
    let response, data;
    try {
      response = await this.fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Cookie: a.cookieHeader, 'Content-Type': 'text/plain', Origin: `https://www.icloud${suffix}`, Referer: `https://www.icloud${suffix}/` },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      data = await response.json();
    } catch { fail(502, 'APPLE_REQUEST_UNCERTAIN'); }
    if (!response.ok || !data?.success) fail(response.status === 401 ? 401 : 502, 'APPLE_REQUEST_FAILED');
    return data.result;
  }
  async list() {
    const data = await this.request('v2/hme/list');
    if (!Array.isArray(data?.hmeEmails)) fail(502, 'APPLE_INVALID_LIST');
    return data.hmeEmails.filter(r => r?.hme).map(r => ({ email: r.hme, label: r.label || '', appleLabel: r.label || '', anonymousId: r.anonymousId || '', isActive: r.isActive !== false }));
  }
  async generate(label) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}-\d+$/.test(label)) fail(400, 'INVALID_LABEL');
    // Persist the sequence before the first non-idempotent request; never reuse on failure.
    const prefix = label.slice(0, label.lastIndexOf('-'));
    const reserved = await this.store.mutate(s => {
      s.hostedSequence ||= {};
      const max = s.inventory.reduce((n, r) => r.label?.startsWith(`${prefix}-`) ? Math.max(n, Number(r.label.slice(prefix.length + 1)) || 0) : n, 0);
      const number = Math.max(Number(s.hostedSequence[prefix]) || 0, max, Number(label.slice(prefix.length + 1)) - 1) + 1;
      if (!Number.isSafeInteger(number)) fail(409, 'LABEL_EXHAUSTED');
      s.hostedSequence[prefix] = number;
      return `${prefix}-${String(number).padStart(3, '0')}`;
    });
    try {
      const result = await this.request('v1/hme/generate', { langCode: 'en-us' });
      if (!result?.hme) throw new Error('MISSING_HME');
      await this.request('v1/hme/reserve', { hme: result.hme, label: reserved, note: 'Mail dashboard' });
      return { email: result.hme, label: reserved };
    } catch (error) {
      // Never silently retry either operation after a potentially committed request.
      error.code = 'GENERATION_RESULT_UNCERTAIN';
      throw error;
    }
  }
  async generateBatch(labels) {
    const generated = [];
    for (const label of labels) {
      try { generated.push(await this.generate(label)); }
      catch { return { generated, errors: [{ code: 'GENERATION_RESULT_UNCERTAIN', error: 'APPLE_GENERATION_RECONCILE_REQUIRED' }] }; }
    }
    return { generated, errors: [] };
  }
}
