import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountICloud, verifyAppleIdentity } from '../lib/hosted/icloud.mjs';

const response = url => async () => ({ ok: true, json: async () => ({ dsInfo: { dsid: '123', appleId: 'a@example.test' }, webservices: { premiummailsettings: { url } } }) });

for (const [region, suffix] of [['global', 'icloud.com'], ['china', 'icloud.com.cn']]) {
  for (const service of ['maildomainws', 'p42-maildomainws', 'maildomainws-china', 'p42-maildomainws-china']) {
    const host = `${service}.${suffix}`;
    test(`authenticated HME service is accepted and used for listing (${host})`, async () => {
      const identity = await verifyAppleIdentity('synthetic', region, response(`https://${host}:443`));
      assert.equal(identity.hmeOrigin, `https://${host}`);
      let requested;
      const cloud = new AccountICloud({ getAccount: async () => ({ identity, region, cookieHeader: 'synthetic', paused: false }), fetchImpl: async url => {
        requested = new URL(url);
        return { ok: true, json: async () => ({ success: true, result: { hmeEmails: [] } }) };
      } });
      assert.deepEqual(await cloud.list(), []);
      assert.equal(requested.hostname, host);
      assert.equal(requested.pathname, '/v2/hme/list');
      assert.equal(requested.searchParams.get('dsid'), '123');
    });
  }
}

for (const [region, suffix, other] of [['global', 'icloud.com', 'icloud.com.cn'], ['china', 'icloud.com.cn', 'icloud.com']]) {
  test(`China shard support retains strict service-origin validation (${region})`, async () => {
    const host = `p42-maildomainws-china.${suffix}`;
    for (const url of [
      `https://${host}.evil.example`, `https://${host}:8443`,
      `https://user:password@${host}`, `https://${host}/private`,
      `https://${host}?token=synthetic`, `https://${host}#fragment`,
      `https://p42-maildomainws-china.${other}`, `https://maildomainws-china.${other}`,
      `https://maildomainws-china-extra.${suffix}`, `https://evil-maildomainws-china.${suffix}`,
      `http://${host}`, 'https://127.0.0.1',
    ]) await assert.rejects(verifyAppleIdentity('synthetic', region, response(url)), { code: 'APPLE_HME_SERVICE_UNAVAILABLE' });
  });
}
