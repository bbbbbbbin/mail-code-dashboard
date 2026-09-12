import json
import threading
from http.server import ThreadingHTTPServer

from browser_smoke_support import (
    BrowserSmokeHandler,
    assert_no_browser_errors,
    capture_browser_errors,
    mock_background_auto_stock,
    wait_for_page_condition,
)
from playwright.sync_api import sync_playwright

API_KEY = "synthetic-dashboard-smoke-key"


def envelope(data):
    return {
        "ok": True,
        "data": data,
        "error": None,
        "meta": {
            "service": "mail-code-dashboard",
            "version": "1",
            "requestId": "dashboard-smoke",
        },
    }


def error_envelope(code, message):
    return {
        "ok": False,
        "data": None,
        "error": {"code": code, "message": message},
        "meta": {
            "service": "mail-code-dashboard",
            "version": "1",
            "requestId": "dashboard-smoke-error",
        },
    }


def main():
    batch_error = "stubbed batch failure"
    sync_calls = []
    single_mail_calls = []
    finished_mail_calls = []
    unused_mail_calls = []
    patch_calls = []
    legacy_forward_calls = []
    generate_calls = []
    create_inventory_calls = []
    inventory = [
        {
            "id": "inventory-1",
            "email": "alias1@icloud.com",
            "group": "finished",
            "source": "icloud-hme",
            "label": "hme-001",
            "remark": "operator note",
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
        },
        {
            "id": "inventory-2",
            "email": "alias2@icloud.com",
            "group": "unused",
            "source": "icloud-hme",
            "label": "hme-002",
            "remark": "hme-002",
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
        },
    ]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{httpd.server_address[1]}"
    url = f"{origin}/mail-code-dashboard.html"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            browser_errors = capture_browser_errors(page)
            mock_background_auto_stock(page)
            module_response = page.request.get(f"{origin}/assets/dashboard.js")
            if module_response.status != 200:
                raise AssertionError(
                    f"Dashboard module returned {module_response.status}."
                )
            if "javascript" not in module_response.headers.get("content-type", ""):
                raise AssertionError(
                    "Dashboard module was not served with JavaScript MIME."
                )
            page.add_init_script(
                f"""
                localStorage.clear();
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
                if route.request.method == "POST":
                    body = route.request.post_data_json
                    create_inventory_calls.append(body)
                    if len(create_inventory_calls) == 2:
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps(
                                error_envelope(
                                    "STORAGE_ERROR",
                                    "synthetic inventory write failure",
                                )
                            ),
                        )
                        return
                    address = body["addresses"][0]
                    inventory.append(
                        {
                            "id": "server-generated-stable-id",
                            "email": address["email"],
                            "group": "unused",
                            "source": "icloud-hme",
                            "label": address["label"],
                            "remark": address["label"],
                            "isActive": True,
                            "code": "",
                            "subject": "",
                            "preview": "",
                            "receivedAt": "",
                            "unread": False,
                            "statusType": "ok",
                            "statusMessage": "已生成，等待使用",
                            "lastCheckedAt": "",
                            "lastMethod": "",
                            "noCodeReason": "",
                        }
                    )
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps(
                            envelope(
                                {
                                    "inventory": inventory,
                                    "claims": [],
                                    "created": [inventory[-1]],
                                    "existing": [],
                                }
                            )
                        ),
                    )
                    return
                if route.request.method != "GET":
                    raise AssertionError(
                        f"Unexpected inventory method {route.request.method}."
                    )
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "initialized": True,
                                "migration": {
                                    "completedAt": "2026-07-25T00:00:00.000Z"
                                },
                                "summary": {
                                    "total": 2,
                                    "unused": 1,
                                    "finished": 1,
                                    "trash": 0,
                                },
                                "inventory": inventory,
                                "claims": [],
                            }
                        )
                    ),
                )

            def icloud_status_route(route):
                assert_key(route)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {"ok": False, "error": "stubbed iCloud status"}
                    ),
                )

            def icloud_sync_route(route):
                assert_key(route)
                if route.request.method != "POST":
                    raise AssertionError("Persistent iCloud sync must use POST.")
                sync_calls.append(route.request.url)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "summary": {
                                    "total": 2,
                                    "unused": 1,
                                    "finished": 1,
                                    "trash": 0,
                                },
                                "inventory": inventory,
                                "claims": [],
                            }
                        )
                    ),
                )

            def single_mail_route(route):
                assert_key(route)
                single_mail_calls.append(route.request.url)
                updated = {
                    **inventory[0],
                    "subject": "Synthetic forwarded message",
                    "preview": "Code 123456",
                    "receivedAt": "2026-07-26T02:00:00.000Z",
                    "code": "123456",
                    "unread": True,
                    "statusMessage": "已识别验证码",
                }
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "checked": 1,
                                "updated": 1,
                                "errors": [],
                                "inventoryItem": updated,
                                "message": {
                                    "subject": updated["subject"],
                                    "text": updated["preview"],
                                    "codes": ["123456"],
                                    "links": [],
                                    "primaryLink": None,
                                },
                            }
                        )
                    ),
                )

            def finished_mail_route(route):
                assert_key(route)
                finished_mail_calls.append(route.request.url)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "checked": 1,
                                "updated": 0,
                                "errors": [],
                                "inventory": inventory,
                            }
                        )
                    ),
                )

            def unused_mail_route(route):
                assert_key(route)
                if route.request.method != "POST":
                    raise AssertionError("Unused inventory scan must use POST.")
                unused_mail_calls.append(route.request.url)
                moved = {
                    **inventory[1],
                    "group": "finished",
                    "subject": "Matched unused forwarded message",
                    "receivedAt": "2026-07-26T02:00:00.000Z",
                    "unread": True,
                }
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "checked": 1,
                                "updated": 1,
                                "moved": 1,
                                "errors": [],
                                "inventory": [inventory[0], moved],
                            }
                        )
                    ),
                )

            def patch_inventory_route(route):
                assert_key(route)
                patch = route.request.post_data_json or {}
                patch_calls.append(patch)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "inventoryItem": {
                                    **inventory[0],
                                    **patch,
                                }
                            }
                        )
                    ),
                )

            def legacy_forward_route(route):
                legacy_forward_calls.append(route.request.url)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {"updates": [], "errors": [], "checked": []}
                    ),
                )

            def batch_route(route):
                assert_key(route)
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "generated": [],
                            "errors": [{"error": batch_error}],
                        }
                    ),
                )

            def generate_route(route):
                assert_key(route)
                if route.request.method != "POST":
                    raise AssertionError("iCloud generation must use POST.")
                generate_calls.append(route.request.post_data_json)
                number = len(generate_calls) + 2
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "email": f"generated-{number}@icloud.com",
                            "label": f"hme-{number:03d}",
                        }
                    ),
                )

            page.route("**/v1/inventory", inventory_route)
            page.route("**/v1/inventory/sync-icloud", icloud_sync_route)
            page.route(
                "**/v1/inventory/inventory-1/messages/latest",
                single_mail_route,
            )
            page.route(
                "**/v1/inventory/check-finished-mail",
                finished_mail_route,
            )
            page.route(
                "**/v1/inventory/check-unused-mail",
                unused_mail_route,
            )
            page.route("**/v1/inventory/inventory-1", patch_inventory_route)
            page.route("**/api/icloud/status", icloud_status_route)
            page.route("**/api/icloud/generate", generate_route)
            page.route("**/api/icloud/generate-batch", batch_route)
            page.route("**/api/forward/check", legacy_forward_route)

            page.goto(url, wait_until="networkidle", timeout=15_000)
            page.wait_for_selector(".toast .notice", timeout=5_000)
            startup_body = page.locator("body").inner_text(timeout=5_000)
            # 密集列表：每个邮箱是 #mailList 里的一个 .row，不再是 .mail-card。
            page.wait_for_selector("#mailList .row", timeout=5_000)
            first_row = page.locator("#mailList .row").first
            remark_cell = first_row.locator(".cell-remark")
            subject_cell = first_row.locator(".cell-subject")
            if remark_cell.count() != 1:
                raise AssertionError(
                    "Dashboard must render the operator remark in its own cell."
                )
            if remark_cell.inner_text().strip() != "operator note":
                raise AssertionError(
                    "Dashboard did not keep the operator remark in the remark cell."
                )
            if "operator note" in subject_cell.inner_text():
                raise AssertionError(
                    "Dashboard mixed the operator remark into the mail detail cell."
                )
            unread_tone = page.locator("#newCodeCount").evaluate(
                "node => node.parentElement.dataset.tone"
            )
            if unread_tone != "brand":
                raise AssertionError("Unread statistics did not use the brand tone.")
            initial_tones = set(
                page.locator("#mailList .tag").evaluate_all(
                    "tags => tags.map(tag => tag.dataset.tone)"
                )
            )
            if not {"ok", "info"}.issubset(initial_tones):
                raise AssertionError(
                    f"Inventory group tags did not use semantic tones: {initial_tones}."
                )
            page.locator("#themeToggle").click()
            wait_for_page_condition(page,
                "() => document.documentElement.dataset.theme === 'light'"
            )
            if sync_calls:
                raise AssertionError(
                    "Dashboard synchronized iCloud before the user requested it."
                )
            page.locator("#syncIcloudBtn").click()
            page.wait_for_timeout(250)
            page.locator("#scanUnusedMailBtn").click(timeout=3_000)
            wait_for_page_condition(page,
                """() =>
                  document.querySelector("#finishedCount")?.textContent === "2" &&
                  document.querySelector("#unusedCount")?.textContent === "0"
                """,
                timeout=5_000,
            )
            # 行内操作只保留「收件」，其余收进行尾的「⋯」菜单。
            first_row.get_by_role("button", name="收件", exact=True).click()
            page.wait_for_selector(
                '#mailList .row[data-id="inventory-1"][data-marked="true"]',
                timeout=5_000,
            )
            updated_row = page.locator('#mailList .row[data-id="inventory-1"]')
            if updated_row.locator(".cell-remark").inner_text().strip() != "operator note":
                raise AssertionError(
                    "A received mail refresh must not overwrite the operator remark."
                )
            if "Synthetic forwarded message" not in updated_row.locator(
                ".cell-subject"
            ).inner_text():
                raise AssertionError(
                    "A received mail refresh did not stay in the mail detail cell."
                )
            page.locator("#refreshForwardBtn").click()
            # 批量读取会用响应里的库存整体替换列表并重建所有行。必须等它落定
            # 再打开备注编辑框，否则重渲染会把正在输入的输入框换掉。
            wait_for_page_condition(page,
                """() =>
                  document.querySelector("#finishedCount")?.textContent === "1" &&
                  document.querySelector("#unusedCount")?.textContent === "1"
                """,
                timeout=5_000,
            )
            # 备注不再是常驻输入框：先开行菜单再选「编辑备注」。行内操作的
            # 可访问名必须带上具体邮箱地址（设计系统的可访问性基线）。
            first_row.get_by_role(
                "button", name="alias1@icloud.com 的更多操作", exact=True
            ).click()
            page.locator("#rowMenu").get_by_role(
                "menuitem", name="编辑备注", exact=True
            ).click()
            remark = page.locator('#mailList .row input[data-action="remark"]')
            remark.fill("persist this remark")
            remark.press("Tab")
            page.wait_for_timeout(7_000)

            page.locator("#generateIcloudBtn").click()
            page.wait_for_selector(
                '#mailList .row[data-id="server-generated-stable-id"]',
                timeout=5_000,
            )
            generated_row = page.locator(
                '#mailList .row[data-id="server-generated-stable-id"]'
            )
            if "generated-3@icloud.com" not in generated_row.inner_text():
                raise AssertionError(
                    "Dashboard did not render the server-owned generated row."
                )

            page.locator("#generateIcloudBtn").click()
            page.get_by_text(
                "地址已在 Apple 生成但库存写入失败，请执行同步 iCloud 恢复。",
                exact=True,
            ).wait_for(timeout=5_000)
            auto_stock = page.evaluate(
                """() => JSON.parse(
                  localStorage.getItem("mail-code-dashboard-auto-stock-v2")
                )"""
            )
            if "同步 iCloud" not in auto_stock.get("pausedReason", ""):
                raise AssertionError(
                    "A half-successful generation did not pause auto stock."
                )
            generate_count = len(generate_calls)
            page.wait_for_timeout(100)
            if len(generate_calls) != generate_count:
                raise AssertionError(
                    "Auto stock generated another Apple address while paused."
                )
            body = page.locator("body").inner_text(timeout=5_000)
            assert_no_browser_errors(browser_errors, "Dashboard")
            browser.close()

        if "Cannot access 'errors' before initialization" in body:
            raise AssertionError(
                "Dashboard hit errors temporal-dead-zone bug on empty batch response."
            )
        if batch_error not in startup_body:
            raise AssertionError(
                "Dashboard did not surface the batch error returned by the API."
            )
        if len(sync_calls) != 1:
            raise AssertionError(
                f"Expected one authenticated startup sync, got {len(sync_calls)}."
            )
        if len(single_mail_calls) != 1:
            raise AssertionError(
                f"Expected one single-alias mail request, got {len(single_mail_calls)}."
            )
        if len(finished_mail_calls) != 1:
            raise AssertionError(
                "Expected the top mail action to check finished inventory once."
            )
        if len(unused_mail_calls) != 1:
            raise AssertionError(
                "Expected the unused inventory action to scan exactly once."
            )
        if not patch_calls or patch_calls[-1].get("remark") != "persist this remark":
            raise AssertionError("Dashboard did not persist the changed remark.")
        if legacy_forward_calls:
            raise AssertionError(
                f"Dashboard still used legacy forward scanning {len(legacy_forward_calls)} times."
            )
        if len(generate_calls) != 2:
            raise AssertionError(
                f"Expected two manual Apple generation calls, got {len(generate_calls)}."
            )
        if create_inventory_calls != [
            {
                "addresses": [
                    {
                        "email": "generated-3@icloud.com",
                        "label": "hme-003",
                    }
                ]
            },
            {
                "addresses": [
                    {
                        "email": "generated-4@icloud.com",
                        "label": "hme-004",
                    }
                ]
            },
        ]:
            raise AssertionError(
                f"Generated addresses were not persisted exactly once each: "
                f"{create_inventory_calls}"
            )
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    print("dashboard smoke test passed")


if __name__ == "__main__":
    main()
