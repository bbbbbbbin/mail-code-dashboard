// 只做"源码里该有的东西还在不在"的粗筛。真正的行为断言在 test/background.test.mjs，
// 那里会把 background.js 跑起来。这个脚本留着是因为它不依赖 node:test，装机后能一条命令自查。
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const popup = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const url of [
  "https://www.icloud.com/mail/",
  "https://mail.icloud.com/",
  "https://p68-maildomainws.icloud.com/"
]) {
  assert(source.includes(url), `background.js should collect cookies for ${url}`);
}

assert(
  source.includes("chrome.storage.local.set"),
  "background.js should persist lastSyncStatus for popup diagnostics"
);

assert(
  source.includes("COOKIE_DOMAINS") && source.includes("domain"),
  "background.js should collect Apple cookies by domain, not only fixed URLs"
);

assert(
  source.includes('BRIDGE_HOST = "127.0.0.1"') &&
    source.includes('BRIDGE_PATH = "/api/edge-cookie-bridge"') &&
    !source.includes("localhost:4173"),
  "background.js must post to 127.0.0.1, because the service never binds localhost/::1"
);

assert(
  source.includes("DEFAULT_BRIDGE_PORT = 4173") &&
    source.includes('BRIDGE_PORT_STORAGE_KEY = "bridgePort"') &&
    popup.includes("DEFAULT_BRIDGE_PORT = 4173") &&
    popup.includes('BRIDGE_PORT_STORAGE_KEY = "bridgePort"'),
  "background and popup must share the configurable bridge-port contract"
);

assert(
  source.includes("!/^\\d+$/.test(text)") && popup.includes("!/^\\d+$/.test(text)"),
  "background and popup must reject partially numeric ports"
);

assert(
  !/BRIDGE_URL\s*=\s*"http/.test(source),
  "the endpoint must be built from the stored port, not hardcoded as a whole URL"
);

assert(
  source.includes('"X-API-Key"'),
  "background.js must send X-API-Key, because every /api/ route requires it"
);

assert(
  source.includes("chrome.storage.local.get") && source.includes("API_KEY_STORAGE_KEY"),
  "background.js must read the API key from chrome.storage.local instead of hardcoding it"
);

assert(
  source.includes("SYNCED_COOKIE_NAMES") &&
    source.includes("CANONICAL_COOKIE_NAMES") &&
    !source.includes('toUpperCase().includes("APPLE")'),
  "cookie selection must be an explicit allow list, not a substring match on APPLE"
);

for (const name of [
  "X-APPLE-DS-WEB-SESSION-TOKEN",
  "X-APPLE-WEBAUTH-TOKEN",
  "X-APPLE-WEBAUTH-PCS-Mail"
]) {
  assert(source.includes(name), `the allow list must keep ${name}, the server requires it`);
}

assert(
  source.includes("COOKIE_CHANGE_DEBOUNCE_MS") && source.includes("clearTimeout"),
  "cookie change bursts must be debounced, one iCloud login rewrites dozens of cookies"
);

assert(
  !manifest.host_permissions.includes("https://*.apple.com/*"),
  "host_permissions must not cover all of apple.com"
);

assert(
  manifest.icons && manifest.minimum_chrome_version,
  "manifest must declare icons and minimum_chrome_version"
);

console.log("extension config smoke test passed");
