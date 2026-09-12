// 只用 127.0.0.1：服务固定监听 127.0.0.1，而 Windows 上 localhost 常先解析成 ::1，会直接连接失败。
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PATH = "/api/edge-cookie-bridge";
const DEFAULT_BRIDGE_PORT = 4173;
// 端口以前写死在这行代码里，换端口就得改源码再重新加载扩展。现在和 API key 一样放 chrome.storage.local，
// 由弹窗配置；每次同步都重新读，所以改完不用 reload 扩展。
const BRIDGE_PORT_STORAGE_KEY = "bridgePort";
// 服务对所有 /api/ 请求强制校验 X-API-Key。key 不写在代码里，由用户在插件弹窗粘贴后存到 chrome.storage.local。
const API_KEY_STORAGE_KEY = "bridgeApiKey";
const MISSING_API_KEY_ERROR = "缺少 API key：请打开插件弹窗，粘贴当前服务实例 api-key.txt 里的内容并保存。";
// 一次 iCloud 登录会在几百毫秒内改掉几十个 cookie。不防抖就是几十遍全量收集 + 几十个并发 POST，
// 而服务端每次都要覆写同一个 runtime/cookies.txt，后发的请求不保证后到。
const COOKIE_CHANGE_DEBOUNCE_MS = 300;

const COOKIE_URLS = [
  "https://www.icloud.com/",
  "https://www.icloud.com/mail/",
  "https://www.icloud.com/settings/",
  "https://mail.icloud.com/",
  "https://p68-maildomainws.icloud.com/",
  "https://icloud.com/",
  "https://www.icloud.com.cn/",
  "https://www.icloud.com.cn/mail/",
  "https://www.icloud.com.cn/settings/",
  "https://mail.icloud.com.cn/",
  "https://icloud.com.cn/",
  // 只留登录用的 account.apple.com；apple.com / apple.com.cn 的营销站点不会签发这里要的 cookie。
  "https://account.apple.com/"
];
const COOKIE_DOMAINS = [
  "icloud.com",
  "icloud.com.cn",
  "apple.com"
];
const COOKIE_DOMAIN_PATTERN = /(^|\.)(icloud\.com(\.cn)?|apple\.com)$/i;

// 显式白名单，取代原来那种「名字里带 APPLE 就收」的宽匹配。
// 收上来的东西会被服务端原样拼成一整条 Cookie 头发给 iCloud，所以宽匹配不只是多传几个字节：
// Apple 站点上任何名字里带 apple 的埋点/实验 cookie 都会被一起搬进本机文件并跟着请求外发。
// 名单里的每一项都是这条链路上真的会被读到的：
//   - 前两个是 server.mjs acceptEdgeCookieBridge 的硬性要求，缺一个直接 400；
//   - PCS-Mail 决定邮件正文能不能解密（lib/cookie-freshness.mjs 和 debug_icloud_cookie_bridge.ps1 都在看它）；
//   - HSA-TRUST / LOGIN 是双因子与登录态的附属 cookie，缺了会更早被要求重新验证；
//   - USER 带着 dsid，而 HME 接口的 dsid 查询参数是空串，账号只能靠它解析。
const SYNCED_COOKIE_NAMES = [
  "X-APPLE-DS-WEB-SESSION-TOKEN",
  "X-APPLE-WEBAUTH-TOKEN",
  "X-APPLE-WEBAUTH-PCS-Mail",
  "X-APPLE-WEBAUTH-HSA-TRUST",
  "X-APPLE-WEBAUTH-LOGIN",
  "X-APPLE-WEBAUTH-USER"
];
const CANONICAL_COOKIE_NAMES = new Map(
  SYNCED_COOKIE_NAMES.map(name => [name.toLowerCase(), name])
);

// 同一个 cookie 在 Chrome 里有时是全大写、有时是小写 `x-apple-` 前缀
// （refresh_edge_icloud_cookies.py 也做了同样的兼容），所以比对统一转小写。
// 但发出去时保持浏览器给的原始名字：服务端是按精确大小写找必需 cookie 的，改名反而会让它认不出来。
function shouldSyncCookie(name) {
  return CANONICAL_COOKIE_NAMES.has(String(name || "").toLowerCase());
}

function normalizeBridgePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return DEFAULT_BRIDGE_PORT;
  const port = Number(text);
  // 端口存坏了（空、非数字、越界）就退回默认值：宁可往 4173 发一次失败的请求，
  // 也不要拼出 `http://127.0.0.1:NaN/...` 这种连错误信息都读不懂的 URL。
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_BRIDGE_PORT;
  return port;
}

function redactSensitiveError(value) {
  return String(value || "unknown").replace(
    /\b(X-APPLE-[A-Z0-9-]+)\s*=\s*([^;,\s"'}]+)/gi,
    "$1=[已隐藏]"
  );
}

function buildBridgeUrl(port) {
  return `http://${BRIDGE_HOST}:${normalizeBridgePort(port)}${BRIDGE_PATH}`;
}

async function readBridgeUrl() {
  const data = await chrome.storage.local.get(BRIDGE_PORT_STORAGE_KEY);
  return buildBridgeUrl(data?.[BRIDGE_PORT_STORAGE_KEY]);
}

async function setStatus(status) {
  const ok = status.ok === true;
  await chrome.storage.local.set({
    lastSyncStatus: {
      ...status,
      at: new Date().toLocaleString()
    }
  });
  await chrome.action.setBadgeText({ text: ok ? "OK" : "!" });
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#0bbf72" : "#e5484d" });
  await chrome.action.setTitle({ title: ok ? `iCloud cookies synced: ${status.count || 0}` : `iCloud cookie sync failed: ${status.error || "unknown"}` });
}

async function readApiKey() {
  const data = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return String(data?.[API_KEY_STORAGE_KEY] || "").trim();
}

async function collectAppleCookies() {
  const byName = new Map();
  const take = cookies => {
    for (const cookie of cookies) {
      const lowerName = String(cookie?.name || "").toLowerCase();
      const canonicalName = CANONICAL_COOKIE_NAMES.get(lowerName);
      if (!canonicalName) continue;
      byName.set(lowerName, {
        name: canonicalName,
        value: cookie.value
      });
    }
  };
  for (const url of COOKIE_URLS) take(await chrome.cookies.getAll({ url }));
  // 再按域名扫一遍：iCloud 的分片主机名（p68-… 这种编号）会变，靠固定 URL 列表会漏。
  for (const domain of COOKIE_DOMAINS) take(await chrome.cookies.getAll({ domain }));
  return Array.from(byName.values());
}

async function syncCookies() {
  try {
    const hosted = (await chrome.storage.local.get('hostedBridge')).hostedBridge;
    if (hosted?.enabled) return await syncHostedCookies(hosted);
    const apiKey = await readApiKey();
    if (!apiKey) {
      const status = { ok: false, error: MISSING_API_KEY_ERROR };
      await setStatus(status);
      return status;
    }
    const bridgeUrl = await readBridgeUrl();
    const cookies = await collectAppleCookies();
    if (!cookies.length) {
      const status = { ok: false, error: "no apple cookies found", endpoint: bridgeUrl };
      await setStatus(status);
      return status;
    }
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey
      },
      body: JSON.stringify({ cookies })
    });
    const text = await response.text();
    if (response.status === 401) {
      throw new Error("API key 无效：请在插件弹窗重新粘贴当前服务实例 api-key.txt 的内容。");
    }
    // Never persist the response body on failure. It comes from a component
    // handling the submitted Cookie header and may echo a rejected value.
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = { ok: true, count: cookies.length, response: text, endpoint: bridgeUrl };
    await setStatus(status);
    return status;
  } catch (error) {
    const status = {
      ok: false,
      error: redactSensitiveError(error?.message || String(error))
    };
    await setStatus(status);
    return status;
  }
}

function hostedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('服务器地址必须是 HTTPS 域名，不含路径或参数。');
  return url.origin;
}

async function syncHostedCookies(config) {
  const origin = hostedOrigin(config.origin);
  if (!config.token?.startsWith('upl_') || !/^[0-9a-f-]{36}$/.test(config.accountId || '')) throw new Error('请先保存服务器的账号编号与专属同步密钥。');
  const suffix = config.region === 'china' ? 'icloud.com.cn' : 'icloud.com';
  const cookies = await chrome.cookies.getAll({ domain: suffix });
  const byName = new Map();
  for (const item of cookies) {
    const name = CANONICAL_COOKIE_NAMES.get(String(item.name || '').toLowerCase());
    if (!name) continue;
    if (byName.has(name) && byName.get(name) !== item.value) throw new Error('当前 Chrome 存在相互冲突的 iCloud Cookie，请核对登录配置文件。');
    byName.set(name, item.value);
  }
  const endpoint = `${origin}/bridge/v1/sync`;
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ expectedAccountId: config.accountId, cookies: [...byName].map(([name, value]) => ({ name, value })) }) });
  if (!response.ok) {
    // Status only; never persist an arbitrary server body or an echoed secret.
    throw new Error(response.status === 409 ? '账号不匹配，服务器拒绝覆盖，请核对绑定。' : `服务器同步未完成（HTTP ${response.status}），请查看后台状态。`);
  }
  const result = await response.json();
  if (result?.account?.id !== config.accountId) throw new Error('服务器返回账号与扩展绑定不一致。');
  const status = { ok: true, count: byName.size, endpoint, account: String(result.account.name || '').slice(0, 60) };
  await setStatus(status);
  return status;
}

let debounceTimer = null;
let inFlightSync = null;
let resyncQueued = false;

/**
 * 串行化同步。两次同步并发跑没有意义：它们收的是同一份 cookie，服务端却要各写一次
 * runtime/cookies.txt，先发后到就会把新的覆盖成旧的。
 *
 * 在飞的时候只记一个"待重跑"标记，而不是丢弃请求——丢弃会让"最后一次变更"落空。
 */
function runSync() {
  if (inFlightSync) {
    resyncQueued = true;
    return inFlightSync;
  }
  inFlightSync = syncCookies().finally(() => {
    inFlightSync = null;
    if (resyncQueued) {
      resyncQueued = false;
      runSync();
    }
  });
  return inFlightSync;
}

/**
 * 尾沿防抖：窗口内反复调用只会推迟计时器，窗口结束后一定会跑一次，
 * 所以最后一次 cookie 变更永远会被同步到，只是最多晚 COOKIE_CHANGE_DEBOUNCE_MS。
 */
function scheduleSync(delayMs = COOKIE_CHANGE_DEBOUNCE_MS) {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSync();
  }, delayMs);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sync-icloud-cookies", { delayInMinutes: 0.1, periodInMinutes: 5 });
  runSync();
});

chrome.runtime.onStartup.addListener(() => runSync());

// 设了 default_popup 之后 onClicked 基本不会触发，留着是为了万一弹窗被禁用时还有个手动入口。
chrome.action.onClicked.addListener(() => runSync());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "sync-now") {
    // 手动点"立即同步"不该再等 300ms，直接进串行队列。
    runSync().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

chrome.cookies.onChanged.addListener(changeInfo => {
  const cookie = changeInfo.cookie;
  if (!cookie?.name || !shouldSyncCookie(cookie.name)) return;
  if (!COOKIE_DOMAIN_PATTERN.test(cookie.domain || "")) return;
  scheduleSync();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "sync-icloud-cookies") runSync();
});
