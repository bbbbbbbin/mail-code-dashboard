"""分组标签页 + 设置面板冒烟测试。

验证重建后的密集列表 UI：
  * 四个分组标签页按设计系统渲染成 role="tablist" / role="tab" + aria-selected；
  * 默认每页 25 行，旧的三列卡片布局彻底消失；
  * 下一页翻页生效，切换标签页会把页码重置回第 1 页；
  * 搜索只在当前标签页内过滤；
  * 设置对话框里的“每页显示”改成 50 后列表立刻跟随；
  * 1440x900 下没有横向溢出。
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
    wait_for_page_condition,
)
from playwright.sync_api import sync_playwright

PROJECT_DIR = Path(__file__).resolve().parent.parent
API_KEY = "synthetic-tabs-settings-key"

# (data-group, 标签文本)：顺序即 DOM 顺序。
EXPECTED_TABS = (
    ("all", "全部"),
    ("finished", "已使用"),
    ("unused", "未使用"),
    ("trash", "垃圾箱"),
)
ROW_SELECTOR = "#mailList .row"


def envelope(data):
    return {
        "ok": True,
        "data": data,
        "error": None,
        "meta": {
            "service": "mail-code-dashboard",
            "version": "1",
            "requestId": "tabs-settings-smoke",
        },
    }


def inventory_rows():
    rows = []
    for number in range(1, 81):
        group = "finished" if number <= 30 else "unused"
        if number > 70:
            group = "trash"
        rows.append(
            {
                "id": f"inventory-{number:03d}",
                "email": f"alias-{number:03d}@icloud.com",
                "group": group,
                "source": "icloud-hme",
                "label": f"hme-{number:03d}",
                "remark": f"hme-{number:03d}",
                "isActive": True,
                "code": "",
                "subject": "",
                "preview": "",
                "receivedAt": "",
                "unread": False,
                "statusType": "ok",
                "statusMessage": "等待检查",
                "lastCheckedAt": "",
                "lastMethod": "",
                "noCodeReason": "",
            }
        )
    return rows


def group_tab(page, group):
    """按 role + data-group 定位标签页，不依赖易变的 class。"""
    return page.locator(f'#groupTabs [role="tab"][data-group="{group}"]')


def tab_label(tab):
    """取标签页自身的文字，剔除内嵌的计数徽标。"""
    return tab.evaluate(
        "node => [...node.childNodes]"
        ".filter(child => child.nodeType === Node.TEXT_NODE)"
        ".map(child => child.textContent).join('').trim()"
    )


def assert_tabs_rendered(page):
    """标签页必须是 tablist/tab，而不是一排普通按钮。"""
    tablist = page.get_by_role("tablist", name="邮箱分组")
    tablist.wait_for()
    tabs = tablist.get_by_role("tab")
    if tabs.count() != len(EXPECTED_TABS):
        raise AssertionError(
            f"Group tablist must expose {len(EXPECTED_TABS)} tabs, got {tabs.count()}."
        )
    for group, label in EXPECTED_TABS:
        tab = group_tab(page, group)
        tab.wait_for()
        actual = tab_label(tab)
        if actual != label:
            raise AssertionError(f"Tab {group!r} is labelled {actual!r}, want {label!r}.")


def assert_selected_tab(page, active_group):
    """设计系统要求选中态走 aria-selected，而不是只换 class。"""
    for group, _label in EXPECTED_TABS:
        expected = "true" if group == active_group else "false"
        actual = group_tab(page, group).get_attribute("aria-selected")
        if actual != expected:
            raise AssertionError(
                f"Tab {group!r} aria-selected is {actual!r}, want {expected!r}."
            )


def row_ids(page):
    return page.eval_on_selector_all(
        ROW_SELECTOR, "nodes => nodes.map(node => node.dataset.id)"
    )


def wait_for_row_count(page, expected, what):
    """搜索/翻页是防抖或异步渲染的，等待即断言：等不到就直接失败。"""
    try:
        wait_for_page_condition(page,
            f"() => document.querySelectorAll('{ROW_SELECTOR}').length === {expected}",
            timeout=5_000,
        )
    except Exception as error:  # noqa: BLE001 - 转成带上下文的断言失败
        actual = page.locator(ROW_SELECTOR).count()
        raise AssertionError(
            f"{what}: expected {expected} rows, list settled at {actual}."
        ) from error


def main():
    rows = inventory_rows()
    summary = {"total": 80, "finished": 30, "unused": 40, "trash": 10}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/mail-code-dashboard.html"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            browser_errors = capture_browser_errors(page)
            mock_background_auto_stock(page)
            page.add_init_script(
                f"""
                localStorage.clear();
                localStorage.setItem(
                  "mail-code-dashboard-auto-stock-v2",
                  JSON.stringify({{ enabled: false }})
                );
                sessionStorage.setItem(
                  "mail-code-dashboard-api-key-v1",
                  {json.dumps(API_KEY)}
                );
                """
            )

            def assert_key(route):
                if route.request.headers.get("x-api-key") != API_KEY:
                    raise AssertionError("Dashboard request omitted its API key.")

            def inventory_route(route):
                assert_key(route)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "initialized": True,
                                "migration": {"completedAt": "2026-07-26T00:00:00Z"},
                                "summary": summary,
                                "inventory": rows,
                                "claims": [],
                            }
                        )
                    ),
                )

            def sync_route(route):
                assert_key(route)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "summary": summary,
                                "inventory": rows,
                                "claims": [],
                            }
                        )
                    ),
                )

            def status_route(route):
                assert_key(route)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps({"ok": True, "count": 80}),
                )

            page.route("**/v1/inventory", inventory_route)
            page.route("**/v1/inventory/sync-icloud", sync_route)
            page.route("**/api/icloud/status", status_route)

            page.goto(url, wait_until="networkidle", timeout=20_000)
            wait_for_page_condition(page,
                "() => document.querySelector('#totalCount')?.textContent === '80'"
            )

            assert_tabs_rendered(page)
            assert_selected_tab(page, "all")

            wait_for_row_count(page, 25, "Default page size must render 25 rows")
            if page.locator("#finishedList").count() != 0:
                raise AssertionError("Legacy three-column lists still exist.")
            if page.locator("#mailList .mail-card").count() != 0:
                raise AssertionError("Legacy card markup still exists.")

            page.locator("#nextPageBtn").click()
            if "第 2 / 4 页" not in page.locator("#pageSummary").inner_text():
                raise AssertionError("Next-page navigation did not advance.")

            group_tab(page, "unused").click()
            assert_selected_tab(page, "unused")
            if "第 1 / 2 页" not in page.locator("#pageSummary").inner_text():
                raise AssertionError("Tab switch did not reset pagination.")
            wait_for_row_count(page, 25, "Unused tab did not apply page size")

            group_tab(page, "all").click()
            assert_selected_tab(page, "all")
            page.locator("#search").fill("alias-079")
            wait_for_row_count(page, 1, "Search did not filter the active tab")
            if row_ids(page) != ["inventory-079"]:
                raise AssertionError(f"Search matched the wrong row: {row_ids(page)}.")
            page.locator("#search").fill("")
            wait_for_row_count(page, 25, "Clearing the search did not restore the list")

            page.locator("#settingsBtn").click()
            page.wait_for_selector("#settingsDialog[open]")
            page.locator("#pageSizeSetting").select_option("50")
            page.locator("#settingsDialog [data-close-dialog]").click()
            page.wait_for_selector("#settingsDialog[open]", state="detached")
            wait_for_row_count(page, 50, "Page-size setting was not applied")

            overflow = page.evaluate(
                "() => document.documentElement.scrollWidth "
                "- document.documentElement.clientWidth"
            )
            if overflow > 0:
                raise AssertionError(
                    f"Tabs dashboard overflowed horizontally by {overflow}px."
                )
            page.screenshot(
                path=str(PROJECT_DIR / "runtime" / "tabs-settings-smoke.png")
            )
            assert_no_browser_errors(browser_errors, "Tabs and settings")
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    print("tabs and settings smoke test passed")


if __name__ == "__main__":
    main()
