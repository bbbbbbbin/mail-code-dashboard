"""收件台布局冒烟测试。

自托管 mail-code-dashboard.html（ThreadingHTTPServer + Playwright 路由桩），用
刻意超长的邮箱地址 / 正文 / 链接 / 2400px 宽 HTML 撑爆布局，验证：

  * 页面复用会话里的 API Key，每个受保护请求都带 X-API-Key；
  * 密集列表（`.list-head` + `#mailList.rows` + `.row`）渲染出全部库存行；
  * 1366x768 与 1440x900 下页面与列表都没有横向溢出；
  * 行内「查看」与领取记录里的「查看邮件」都能打开原生 `<dialog id="mailDialog">`，
    且对话框与 `#mailPreview` 正文区不横向溢出（超宽 HTML 只在 iframe 内滚）；
  * 窄视口按设计系统第 4 条「收窄而不是横向滚」：1180px 断点下收掉分组列、
    900px 断点下隐藏表头，两档都必须零横向溢出。

DOM 说明：a0af125 重建了收件台，旧的 `.mail-card` 卡片与 `#modalBackdrop` 自建
浮层已经不存在，现在是密集行 + 原生 `<dialog>`。定位一律优先 id 与 data-*。
"""

import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from browser_smoke_support import (
    BrowserSmokeHandler,
    assert_no_browser_errors,
    capture_browser_errors,
    mock_background_auto_stock,
)
from playwright.sync_api import sync_playwright

PROJECT_DIR = Path(__file__).resolve().parent.parent
SCREENSHOT_DIR = PROJECT_DIR / "runtime"
API_KEY = "synthetic-layout-smoke-key"
ROW_HEIGHT = 52

# 两档桌面视口跑完整流程。
DESKTOP_VIEWPORTS = (
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
)

# 两档窄视口只验证「收窄而不是横向滚」：
#   1180px 断点 —— 分组列消失，表头仍在，6 列变 5 列；
#   900px  断点 —— 表头整体隐藏，行折成 1fr auto。
NARROW_TIERS = (
    {"width": 1100, "height": 768, "cells": 5, "head_visible": True},
    {"width": 640, "height": 768, "cells": 5, "head_visible": False},
)


def envelope(data):
    return {
        "ok": True,
        "data": data,
        "error": None,
        "meta": {
            "service": "mail-code-dashboard",
            "version": "1",
            "requestId": "layout-smoke",
        },
    }


def inventory_state():
    inventory = [
        {
            "id": "finished-row",
            "email": f"{'a' * 220}@icloud.com",
            "group": "finished",
            "source": "icloud-hme",
            "label": "hme-001",
            "remark": "finished",
            "unread": False,
        },
        {
            "id": "unused-row",
            "email": "unused.alias@icloud.com",
            "group": "unused",
            "source": "icloud-hme",
            "label": "hme-002",
            "remark": "unused",
            "unread": False,
        },
        {
            "id": "trash-row",
            "email": "trash.alias@icloud.com",
            "group": "trash",
            "source": "icloud-hme",
            "label": "hme-003",
            "remark": "trash",
            "unread": False,
        },
    ]
    claims = [
        {
            "claimId": "claim-active",
            "inventoryId": "finished-row",
            "email": inventory[0]["email"],
            "status": "active",
            "claimedAt": "2026-07-26T00:00:00.000Z",
        }
    ]
    summary = {"total": 3, "unused": 1, "finished": 1, "trash": 1}
    return inventory, claims, summary


def measure_overflow(page):
    """页面级与列表级的横向溢出，单位 px。"""
    return page.evaluate(
        """() => {
          const doc = document.documentElement;
          const rows = document.getElementById('mailList');
          return {
            page: doc.scrollWidth - doc.clientWidth,
            rows: rows ? rows.scrollWidth - rows.clientWidth : 0
          };
        }"""
    )


def assert_no_overflow(page, label):
    metrics = measure_overflow(page)
    if metrics["page"] > 0 or metrics["rows"] > 1:
        raise AssertionError(f"{label}: horizontal overflow {metrics}.")
    return metrics


def assert_dialog_fits(page, label):
    """对话框与正文区不许横向溢出：2400px 宽的 HTML 只能在 iframe 里滚。"""
    overflow = page.evaluate(
        """() => {
          const dialog = document.getElementById('mailDialog');
          const preview = document.getElementById('mailPreview');
          return {
            dialog: dialog.scrollWidth - dialog.clientWidth,
            preview: preview.scrollWidth - preview.clientWidth
          };
        }"""
    )
    if overflow["dialog"] > 1 or overflow["preview"] > 1:
        raise AssertionError(f"{label}: mail dialog overflow detected: {overflow}.")
    return overflow


def open_mail_dialog(page, opener, label):
    """点开一个入口 → 等 <dialog open> 与 HTML 预览 iframe → 量溢出 → Esc 关闭。"""
    page.evaluate("() => { document.documentElement.dataset.theme = 'dark'; }")
    opener.click()
    page.wait_for_selector("#mailDialog[open]")
    page.wait_for_selector("#mailDialog .mail-html-frame")
    frame_appearance = page.locator("#mailDialog .mail-html-frame").evaluate(
        """frame => {
          const style = getComputedStyle(frame);
          return {
            colorScheme: style.colorScheme,
            background: style.backgroundColor
          };
        }"""
    )
    if "light" not in frame_appearance["colorScheme"]:
        raise AssertionError(
            f"{label}: mail iframe is not forced to a light color scheme: "
            f"{frame_appearance}."
        )
    if frame_appearance["background"] != "rgb(255, 255, 255)":
        raise AssertionError(
            f"{label}: dark-theme mail iframe is not white: {frame_appearance}."
        )
    overflow = assert_dialog_fits(page, label)
    page.screenshot(path=str(SCREENSHOT_DIR / f"{label}.png"))
    page.keyboard.press("Escape")
    page.wait_for_selector("#mailDialog[open]", state="detached")
    return overflow


def check_row_grid(page, viewport):
    """表头与数据行必须共用同一份列宽，否则列会错位。"""
    metrics = page.evaluate(
        """() => {
          const head = document.querySelector('.list-head');
          const row = document.querySelector('#mailList .row');
          return {
            rowHeight: row.getBoundingClientRect().height,
            headCols: getComputedStyle(head).gridTemplateColumns,
            rowCols: getComputedStyle(row).gridTemplateColumns,
            cells: [...row.children].filter(
              node => getComputedStyle(node).display !== 'none'
            ).length
          };
        }"""
    )
    if round(metrics["rowHeight"]) != ROW_HEIGHT:
        raise AssertionError(
            f"{viewport}: row height must stay {ROW_HEIGHT}px, "
            f"got {metrics['rowHeight']}."
        )
    if metrics["headCols"] != metrics["rowCols"]:
        raise AssertionError(
            f"{viewport}: header and row grids diverged: "
            f"{metrics['headCols']} vs {metrics['rowCols']}."
        )
    if metrics["cells"] != 6:
        raise AssertionError(
            f"{viewport}: desktop row must show 6 cells, got {metrics['cells']}."
        )
    return metrics


def check_narrow_tiers(page):
    """设计系统第 4 条：窄视口收窄，不横向滚。"""
    results = {}
    for tier in NARROW_TIERS:
        page.set_viewport_size({"width": tier["width"], "height": tier["height"]})
        page.wait_for_timeout(120)
        layout = page.evaluate(
            """() => {
              const head = document.querySelector('.list-head');
              const row = document.querySelector('#mailList .row');
              return {
                headVisible: getComputedStyle(head).display !== 'none',
                headCols: getComputedStyle(head).gridTemplateColumns,
                rowCols: getComputedStyle(row).gridTemplateColumns,
                cells: [...row.children].filter(
                  node => getComputedStyle(node).display !== 'none'
                ).length
              };
            }"""
        )
        if layout["headVisible"] != tier["head_visible"]:
            raise AssertionError(
                f"{tier['width']}px: list header visibility should be "
                f"{tier['head_visible']}, got {layout['headVisible']}."
            )
        if layout["cells"] != tier["cells"]:
            raise AssertionError(
                f"{tier['width']}px must narrow to {tier['cells']} cells, "
                f"got {layout['cells']}."
            )
        if layout["headVisible"] and layout["headCols"] != layout["rowCols"]:
            raise AssertionError(
                f"{tier['width']}px: header and row grids diverged: "
                f"{layout['headCols']} vs {layout['rowCols']}."
            )
        results[tier["width"]] = assert_no_overflow(page, f"{tier['width']}px")
        page.screenshot(
            path=str(SCREENSHOT_DIR / f"layout-smoke-{tier['width']}-narrow.png")
        )
    return results


def install_routes(page, inventory, claims, summary, message, calls):
    def assert_key(route):
        if route.request.headers.get("x-api-key") != API_KEY:
            calls["missingKey"] += 1

    def inventory_route(route):
        assert_key(route)
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                envelope(
                    {
                        "initialized": True,
                        "migration": {"completedAt": "2026-07-26T00:00:00.000Z"},
                        "summary": summary,
                        "inventory": inventory,
                        "claims": claims,
                    }
                )
            ),
        )

    def sync_route(route):
        assert_key(route)
        if route.request.method != "POST":
            calls["badMethod"].append(f"sync:{route.request.method}")
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                envelope(
                    {"summary": summary, "inventory": inventory, "claims": claims}
                )
            ),
        )

    def inventory_latest_route(route):
        """行内「查看」走的是库存收件接口（POST，无 query）。"""
        assert_key(route)
        calls["inventoryLatest"] += 1
        if route.request.method != "POST":
            calls["badMethod"].append(f"inventoryLatest:{route.request.method}")
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                envelope({"inventoryItem": inventory[0], "message": message})
            ),
        )

    def claim_latest_route(route):
        """领取记录里的「查看邮件」走 claim 接口。"""
        assert_key(route)
        calls["claimLatest"] += 1
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(envelope({"message": message})),
        )

    def icloud_status_route(route):
        assert_key(route)
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"ok": True}),
        )

    page.route("**/v1/inventory", inventory_route)
    page.route("**/v1/inventory/sync-icloud", sync_route)
    page.route("**/v1/inventory/*/messages/latest", inventory_latest_route)
    page.route("**/v1/claims/claim-active/messages/latest?*", claim_latest_route)
    page.route("**/api/icloud/status", icloud_status_route)


def new_calls():
    return {"inventoryLatest": 0, "claimLatest": 0, "missingKey": 0, "badMethod": []}


def exercise(page, viewport, calls):
    label = f"layout-smoke-{viewport['width']}x{viewport['height']}"

    # ---- 密集列表渲染 ----------------------------------------------------
    page.wait_for_selector("#mailList .row")
    rows = page.locator("#mailList .row")
    if rows.count() != 3:
        raise AssertionError(f"{viewport}: expected 3 rows, got {rows.count()}.")

    check_row_grid(page, viewport)
    assert_no_overflow(page, f"{viewport} list")
    page.screenshot(path=str(SCREENSHOT_DIR / f"{label}-page.png"))

    # ---- 行内「查看」打开邮件对话框 ---------------------------------------
    before = calls["inventoryLatest"]
    open_mail_dialog(
        page,
        page.locator('#mailList .row[data-id="finished-row"] button[data-action="read"]'),
        f"{label}-row-dialog",
    )
    if calls["inventoryLatest"] != before + 1:
        raise AssertionError(
            f"{viewport}: row 查看 must hit the inventory latest endpoint once, "
            f"got {calls['inventoryLatest'] - before}."
        )
    assert_no_overflow(page, f"{viewport} after row dialog")

    # ---- 领取记录里的「查看邮件」也打开同一个对话框 ------------------------
    page.locator("#claimHistoryPanel > summary").click()
    page.wait_for_selector("#claimHistoryList .claim-row")
    before = calls["claimLatest"]
    open_mail_dialog(
        page,
        page.locator(
            '#claimHistoryList button[data-action="claim-mail"]'
            '[data-claim-id="claim-active"]'
        ),
        f"{label}-claim-dialog",
    )
    if calls["claimLatest"] != before + 1:
        raise AssertionError(
            f"{viewport}: 查看邮件 must hit the claim latest endpoint once, "
            f"got {calls['claimLatest'] - before}."
        )
    assert_no_overflow(page, f"{viewport} after claim dialog")

    if calls["missingKey"]:
        raise AssertionError("Some request omitted the X-API-Key header.")
    if calls["badMethod"]:
        raise AssertionError(f"Wrong HTTP methods: {calls['badMethod']}.")


def main():
    inventory, claims, summary = inventory_state()
    long_token = "x" * 500
    long_url = f"https://example.test/verify?token={'y' * 500}"
    message = {
        "id": "INBOX:1",
        "from": "sender@example.test",
        "subject": "Synthetic long message",
        "receivedAt": "2026-07-26T00:00:00.000Z",
        "text": long_token,
        "html": '<div style="width: 2400px">wide sanitized content</div>',
        "codes": ["123456"],
        "links": [long_url],
        "primaryLink": long_url,
    }

    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/mail-code-dashboard.html"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for index, viewport in enumerate(DESKTOP_VIEWPORTS):
                calls = new_calls()
                page = browser.new_page(viewport=viewport)
                browser_errors = capture_browser_errors(page)
                mock_background_auto_stock(page)
                page.add_init_script(
                    f"""
                    if (window.top === window) {{
                      localStorage.clear();
                      localStorage.setItem(
                        "mail-code-dashboard-auto-stock-v2",
                        JSON.stringify({{ enabled: false }})
                      );
                      sessionStorage.setItem(
                        "mail-code-dashboard-api-key-v1",
                        {json.dumps(API_KEY)}
                      );
                    }}
                    """
                )
                install_routes(page, inventory, claims, summary, message, calls)
                page.goto(url, wait_until="networkidle", timeout=15_000)
                exercise(page, viewport, calls)
                # 窄视口收窄检查只需要跑一遍。
                if index == 0:
                    check_narrow_tiers(page)
                assert_no_browser_errors(
                    browser_errors,
                    f"Layout viewport {viewport['width']}x{viewport['height']}",
                )
                page.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    print(
        "layout overflow smoke test passed at 1366x768, 1440x900 "
        "and narrow 1100 / 640"
    )


if __name__ == "__main__":
    main()
