import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    background = (ROOT / "background.js").read_text(encoding="utf-8")
    popup = (ROOT / "popup.js").read_text(encoding="utf-8")

    action = manifest.get("action") or {}
    permissions = set(manifest.get("permissions") or [])
    host_permissions = list(manifest.get("host_permissions") or [])
    icons = manifest.get("icons") or {}

    assert action.get("default_popup") == "popup.html", "manifest action.default_popup must point to popup.html"
    assert "storage" in permissions, "manifest permissions must include storage for popup status"
    assert "chrome.storage.local.set" in background, "background must save last sync status for popup display"
    for source_name, source in (("background", background), ("popup", popup)):
        assert 'BRIDGE_PORT_STORAGE_KEY = "bridgePort"' in source, (
            f"{source_name} must use the shared bridgePort storage key"
        )
        assert "DEFAULT_BRIDGE_PORT = 4173" in source, (
            f"{source_name} must use the shared default bridge port"
        )
        assert "!/^\\d+$/.test(text)" in source, (
            f"{source_name} must reject partially numeric ports"
        )

    assert "CANONICAL_COOKIE_NAMES" in background, (
        "background must canonicalize mixed-case cookie names before posting"
    )

    assert manifest.get("minimum_chrome_version"), "manifest must declare minimum_chrome_version"
    for size in ("16", "32", "48", "128"):
        rel = icons.get(size)
        assert rel, f"manifest icons must declare size {size}"
        assert (ROOT / rel).is_file(), f"icon file {rel} is missing"

    # match pattern 的 host 部分不允许带端口，写了会让整条权限被浏览器判为非法；
    # 端口改成可配之后也需要覆盖所有端口，所以只写 http://127.0.0.1/*。
    for pattern in host_permissions:
        host = pattern.split("://", 1)[-1].split("/", 1)[0]
        assert ":" not in host, f"host permission {pattern} must not pin a port"
    assert "https://*.apple.com/*" not in host_permissions, "apple.com wildcard is wider than this extension needs"

    print("extension validation passed")


if __name__ == "__main__":
    main()
