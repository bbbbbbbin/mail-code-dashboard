const API_KEY_STORAGE_KEY = "bridgeApiKey";
const BRIDGE_PORT_STORAGE_KEY = "bridgePort";
const DEFAULT_BRIDGE_PORT = 4173;

const statusEl = document.getElementById("status");
const syncBtn = document.getElementById("syncBtn");
const portEl = document.getElementById("bridgePort");
const apiKeyEl = document.getElementById("apiKey");
const keyHintEl = document.getElementById("keyHint");
const saveBtn = document.getElementById("saveBtn");

// 和 background.js 里的同名函数是同一套规则。popup 是普通页面脚本、background 是 service worker，
// 两边没有共享模块，为了一个 5 行的校验去改 manifest 引 ES module 不划算，所以这里接受这份重复。
function normalizeBridgePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return DEFAULT_BRIDGE_PORT;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_BRIDGE_PORT;
  return port;
}

async function renderStatus() {
  const data = await chrome.storage.local.get("lastSyncStatus");
  const status = data.lastSyncStatus;
  if (!status) {
    statusEl.textContent = "暂无同步记录。请确认当前 Chrome 配置文件已登录 iCloud，然后点立即同步。";
    return;
  }
  const endpoint = (status.endpoint ? `\n目标：${status.endpoint}` : "") + (status.account ? `\n绑定账号：${status.account}` : "");
  statusEl.textContent = status.ok
    ? `OK\n同步时间：${status.at}\nCookie 数量：${status.count || 0}${endpoint}`
    : `失败\n时间：${status.at}\n原因：${status.error || "unknown"}${endpoint}`;
}

// 端口不是机密，回填出来方便确认当前发到哪；API key 只显示有没有，不回填。
async function renderSettings() {
  const data = await chrome.storage.local.get([API_KEY_STORAGE_KEY, BRIDGE_PORT_STORAGE_KEY]);
  portEl.value = String(normalizeBridgePort(data?.[BRIDGE_PORT_STORAGE_KEY]));
  const saved = String(data?.[API_KEY_STORAGE_KEY] || "").trim();
  keyHintEl.textContent = saved
    ? "已保存 API key。换 key 时粘贴新值再保存即可。"
    : "未保存 API key。服务会拒绝没有 key 的请求（401）。";
}

syncBtn.addEventListener("click", async () => {
  statusEl.textContent = "同步中...";
  await chrome.runtime.sendMessage({ type: "sync-now" });
  setTimeout(renderStatus, 500);
});

saveBtn.addEventListener("click", async () => {
  const rawPort = portEl.value.trim();
  const port = normalizeBridgePort(rawPort);
  const updates = { [BRIDGE_PORT_STORAGE_KEY]: port };

  // API key 留空 = 不改动已存的 key，否则每次只想改端口都得把 key 再粘一遍。
  const apiKey = apiKeyEl.value.trim();
  if (apiKey) updates[API_KEY_STORAGE_KEY] = apiKey;

  await chrome.storage.local.set(updates);
  apiKeyEl.value = "";
  portEl.value = String(port);

  const portNote = rawPort && String(port) !== rawPort
    ? `端口 “${rawPort}” 不合法，已按默认值 ${port} 保存。`
    : `端口已保存：127.0.0.1:${port}。`;
  const keyNote = apiKey ? "API key 已保存到本机浏览器存储。" : "API key 未改动。";
  keyHintEl.textContent = `${portNote}${keyNote}`;
});

renderStatus();
renderSettings();
