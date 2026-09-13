// Disposable Docker integration test; never mounts a real account directory or publishes a port.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const image = process.argv[2] || 'mail-dashboard-test';
const id = `mail-hosted-smoke-${randomUUID()}`;
const folder = await mkdtemp(join(tmpdir(), 'mail-hosted-container-'));
const keyFile = join(folder, 'master-key'), passFile = join(folder, 'password');
const password = randomBytes(24).toString('base64url');
// Readable by the non-root container user; disposable random fixtures only.
await writeFile(keyFile, randomBytes(32).toString('base64'), { mode: 0o644 });
await writeFile(passFile, password, { mode: 0o644 });
function docker(args, input, allowFailure = false) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`Docker test step failed (${args[0]}): ${result.error?.message || result.stderr}`);
  return result;
}
const mounts = ['--mount', `type=volume,src=${id},dst=/data`, '--mount', `type=bind,src=${keyFile},dst=/run/secrets/master-key,readonly`, '--mount', `type=bind,src=${passFile},dst=/run/secrets/admin-password,readonly`];
const request = (path, options = {}) => {
  const code = `import { request } from 'node:http';
    const options = ${JSON.stringify(options)}, path = ${JSON.stringify(path)};
    const host = path.startsWith('/mail-api/') ? 'mail.example.test' : 'admin.example.test';
    const r = request({ hostname: '127.0.0.1', port: 8080, path, method: options.method || 'GET', headers: { Host: host, Origin: 'https://' + host, 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}) } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => console.log(JSON.stringify({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0].split(';')[0], headers: res.headers, value: JSON.parse(text) })));
    }); r.on('error', () => process.exit(1)); if (options.data) r.write(JSON.stringify(options.data)); r.end();`;
  return JSON.parse(docker(['exec', '-i', id, 'node', '--input-type=module'], code).stdout);
};
async function ready() {
  for (let n = 0; n < 30; n++) {
    const r = docker(['exec', id, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], undefined, true);
    if (r.status === 0) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Hosted container did not become ready');
}
try {
  docker(['volume', 'create', id]);
  docker(['run', '--rm', '--network', 'none', ...mounts, image, 'node', 'scripts/hosted-init.mjs']);
  assert.notEqual(docker(['run', '--rm', '--network', 'none', ...mounts, image, 'node', 'scripts/hosted-init.mjs'], undefined, true).status, 0, 'reinitialization must not overwrite');
  const seed = `import { HostedState, readMasterKey } from './lib/hosted/state.mjs';
    import { HostedPlatform } from './lib/hosted/platform.mjs';
    const state = new HostedState('/data/platform.enc', await readMasterKey('/run/secrets/master-key'));
    const platform = new HostedPlatform({ state, dataDir: '/data' });
    const a = await platform.addAccount({ name: 'Synthetic A', appleId: 'a@example.test' });
    const b = await platform.addAccount({ name: 'Synthetic B', appleId: 'b@example.test' });
    await state.mutate(s => { for (const a of s.accounts) { a.identity = { dsid: a.id, appleId: a.expectedAppleId }; a.paused = false; } });
    await platform.runtime(a.id).store.createInventoryItems([{ email: 'synthetic-a@icloud.com', label: 'a-001' }]);
    await platform.runtime(b.id).store.createInventoryItems([{ email: 'synthetic-b@icloud.com', label: 'b-001' }]);
    const email = (await platform.runtime(a.id).store.read()).inventory[0];
    const [grant] = await platform.distribute(a.id, [email.id], 'Synthetic owner');
    const secondEmail = (await platform.runtime(b.id).store.read()).inventory[0];
    console.log(JSON.stringify({ grantId: grant.id, token: grant.token, secondAccountId: b.id, secondEmailId: secondEmail.id }));
    await platform.stop();`;
  const grant = JSON.parse(docker(['run', '--rm', '-i', '--network', 'none', ...mounts, image, 'node', '--input-type=module'], seed).stdout);
  docker(['run', '-d', '--name', id, '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', ...mounts, '-e', 'PUBLIC_ORIGIN=https://admin.example.test', '-e', 'MAIL_ORIGIN=https://mail.example.test', image]);
  await ready();
  const login = () => {
    const r = request('/admin-api/login', { method: 'POST', data: { username: 'admin', password } });
    assert.equal(r.status, 200); assert.match(r.headers['set-cookie'][0], /Secure/); return { cookie: r.cookie, csrf: r.value.csrf };
  };
  const admin = login();
  const before = request('/admin-api/inventory', admin);
  assert.equal(before.value.accounts.length, 2);
  assert.deepEqual(before.value.accounts.map(a => a.inventory.length), [1, 1]);
  const shared = request(`/admin-api/accounts/${grant.secondAccountId}/distribute`, { method: 'POST', ...admin, data: { emailIds: [grant.secondEmailId], recipient: 'Synthetic timed owner', durationDays: 7 } });
  assert.equal(shared.status, 201);
  const timed = shared.value.grants[0], link = new URL(timed.shareUrl);
  assert.equal(link.origin, 'https://mail.example.test'); assert.equal(link.pathname, '/inbox'); assert.equal(link.search, '');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), timed.token);
  assert.ok(Date.parse(timed.expiresAt) > Date.now() + 6 * 86400000);
  const timedLogin = request('/mail-api/login', { method: 'POST', data: { token: timed.token } });
  assert.equal(timedLogin.status, 200); assert.equal(timedLogin.value.expiresAt, timed.expiresAt);
  const mail = request('/mail-api/login', { method: 'POST', data: { token: grant.token } }); assert.equal(mail.status, 200);
  docker(['restart', id]); await ready();
  assert.equal(request('/admin-api/session', admin).status, 401, 'restart clears browser session, not original permanent token');
  const admin2 = login(), after = request('/admin-api/inventory', admin2);
  assert.deepEqual(after.value.accounts.map(a => a.inventory.map(i => i.id)), before.value.accounts.map(a => a.inventory.map(i => i.id)));
  const mail2 = request('/mail-api/login', { method: 'POST', data: { token: grant.token } }); assert.equal(mail2.status, 200);
  const timedRestored = request('/mail-api/login', { method: 'POST', data: { token: timed.token } });
  assert.equal(timedRestored.status, 200); assert.equal(timedRestored.value.expiresAt, timed.expiresAt);
  const listing = request('/admin-api/grants', admin2);
  assert.ok(!JSON.stringify(listing.value).includes(timed.token)); assert.ok(!JSON.stringify(listing.value).includes('shareUrl'));
  const reset = request(`/admin-api/grants/${timed.id}/reset`, { method: 'POST', ...admin2, data: {} });
  assert.equal(reset.status, 200); assert.equal(reset.value.expiresAt, timed.expiresAt);
  assert.notEqual(reset.value.token, timed.token);
  assert.equal(new URLSearchParams(new URL(reset.value.shareUrl).hash.slice(1)).get('token'), reset.value.token);
  assert.equal(request('/mail-api/login', { method: 'POST', data: { token: timed.token } }).status, 401);
  const renewed = request(`/admin-api/grants/${timed.id}`, { method: 'PATCH', ...admin2, data: { durationDays: 30 } });
  assert.equal(renewed.status, 200); assert.ok(Date.parse(renewed.value.expiresAt) > Date.parse(timed.expiresAt));
  assert.equal(request('/mail-api/login', { method: 'POST', data: { token: reset.value.token } }).status, 200);
  assert.equal(request(`/admin-api/grants/${timed.id}/revoke`, { method: 'POST', ...admin2, data: {} }).status, 200);
  assert.equal(request('/mail-api/login', { method: 'POST', data: { token: reset.value.token } }).status, 401);
  assert.equal(request(`/admin-api/grants/${grant.grantId}/revoke`, { method: 'POST', ...admin2, data: {} }).status, 200);
  assert.equal(request('/mail-api/messages', { cookie: mail2.cookie }).status, 401);
  assert.equal(request('/mail-api/login', { method: 'POST', data: { token: grant.token } }).status, 401);
  console.log('Container smoke passed: non-root/read-only, isolated accounts, exclusive init, persistent inventory, permanent/timed grants, fragment links, reset, renewal, restart and revocation. No real credentials or external connections.');
} finally {
  docker(['rm', '-f', id], undefined, true);
  docker(['volume', 'rm', id], undefined, true);
  const target = resolve(folder), parent = resolve(tmpdir()) + sep;
  if (!target.startsWith(parent) || !target.slice(parent.length).startsWith('mail-hosted-container-')) throw new Error('Unexpected cleanup path');
  await rm(target, { recursive: true, force: true });
}
