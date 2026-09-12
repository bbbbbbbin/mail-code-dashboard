(() => {
  const get = id => document.getElementById(id);
  let saved = {};
  chrome.storage.local.get('hostedBridge').then(data => {
    saved = data.hostedBridge || {};
    get('hostedEnabled').checked = saved.enabled === true;
    get('hostedOrigin').value = saved.origin || '';
    get('hostedAccount').value = saved.accountId || '';
    get('hostedRegion').value = saved.region || 'global';
    get('hostedHint').textContent = saved.enabled ? `服务器模式：${saved.origin} / ${saved.accountId}` : '本机模式：原有端口与 API Key 保持不变。';
  });
  get('hostedSave').onclick = async () => {
    try {
      if (!get('hostedEnabled').checked) {
        saved = { ...saved, enabled: false }; await chrome.storage.local.set({ hostedBridge: saved });
        get('hostedHint').textContent = '已切回本机模式，原端口与 API Key 未更改。'; return;
      }
      const raw = get('hostedOrigin').value.trim().replace(/\/$/, '');
      const url = new URL(raw);
      if (url.protocol !== 'https:' || raw !== url.origin || url.username || url.password) throw new Error('请填写纯 HTTPS 地址，不带路径或参数。');
      const accountId = get('hostedAccount').value.trim();
      if (!/^[0-9a-f-]{36}$/.test(accountId)) throw new Error('请复制后台生成的完整账号编号。');
      let token = get('hostedToken').value.trim();
      if (!token && saved.origin === raw && saved.accountId === accountId) token = saved.token;
      if (!token?.startsWith('upl_')) throw new Error('更换服务器或账号时，必须填写该账号的同步密钥。');
      // Request only the user-entered origin, in this user gesture. Never auto-grant all HTTPS sites.
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) throw new Error('请允许扩展访问指定服务器后再同步。');
      saved = { enabled: true, origin: raw, accountId, token, region: get('hostedRegion').value };
      await chrome.storage.local.set({ hostedBridge: saved }); get('hostedToken').value = '';
      get('hostedHint').textContent = `已绑定 ${raw} / ${accountId}。当前 Chrome 只向这个账号同步。`;
    } catch (e) { get('hostedHint').textContent = e.message; }
  };
})();
