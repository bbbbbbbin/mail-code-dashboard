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

API_KEY = "synthetic-browser-api-key"
LEGACY_KEY = "mail-code-dashboard-v1"


def envelope(data, request_id):
    return {
        "ok": True,
        "data": data,
        "error": None,
        "meta": {
            "service": "mail-code-dashboard",
            "version": "1",
            "requestId": request_id,
        },
    }


def main():
    legacy_records = [
        {
            "id": "legacy-unused",
            "email": "unused.alias@icloud.com",
            "group": "unused",
            "label": "hme-003",
            "remark": "available",
            "unread": False,
            "code": "",
            "subject": "",
            "preview": "",
            "receivedAt": "",
        },
        {
            "id": "legacy-finished",
            "email": "finished.alias@icloud.com",
            "group": "finished",
            "label": "hme-001",
            "remark": "do not reuse",
            "unread": True,
            "code": "123456",
            "subject": "Synthetic verification",
            "preview": "Synthetic preview",
            "receivedAt": "2026-07-25T09:00:00.000Z",
            "statusType": "ok",
            "statusMessage": "checked",
            "lastCheckedAt": "2026-07-25T09:01:00.000Z",
        },
        {
            "id": "legacy-trash",
            "email": "trash.alias@icloud.com",
            "group": "trash",
            "label": "hme-002",
            "remark": "discarded",
            "unread": False,
            "code": "",
            "subject": "",
            "preview": "",
            "receivedAt": "",
        },
    ]
    original_legacy_json = json.dumps(
        legacy_records, ensure_ascii=False, separators=(",", ":")
    )
    server_state = {
        "initialized": False,
        "inventory": [
            {
                "id": "server-existing",
                "email": "server.only@icloud.com",
                "group": "unused",
                "label": "server-001",
                "remark": "server owned",
                "unread": False,
                "code": "",
                "subject": "",
                "preview": "",
                "receivedAt": "",
            }
        ],
        "migration_posts": [],
        "missing_key_requests": [],
    }

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{httpd.server_address[1]}"
    url = f"{origin}/mail-code-dashboard.html"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
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
                localStorage.setItem(
                  {json.dumps(LEGACY_KEY)},
                  {json.dumps(original_legacy_json)}
                );
                localStorage.setItem(
                  "mail-code-dashboard-auto-stock-v2",
                  JSON.stringify({{ enabled: false }})
                );
                window.__legacyInventoryReads = 0;
                const originalGetItem = Storage.prototype.getItem;
                Storage.prototype.getItem = function(key) {{
                  if (key === {json.dumps(LEGACY_KEY)}) {{
                    window.__legacyInventoryReads += 1;
                  }}
                  return originalGetItem.call(this, key);
                }};
                """
            )

            def require_stub_key(route):
                supplied = route.request.headers.get("x-api-key", "")
                if supplied != API_KEY:
                    server_state["missing_key_requests"].append(route.request.url)
                    route.fulfill(
                        status=401,
                        content_type="application/json",
                        body=json.dumps(
                            {
                                "ok": False,
                                "data": None,
                                "error": {
                                    "code": "UNAUTHORIZED",
                                    "message": "Unauthorized",
                                },
                                "meta": {
                                    "service": "mail-code-dashboard",
                                    "version": "1",
                                    "requestId": "stub-unauthorized",
                                },
                            }
                        ),
                    )
                    return False
                return True

            def inventory_route(route):
                if not require_stub_key(route):
                    return
                if route.request.method != "GET":
                    raise AssertionError(
                        f"Inventory loader used {route.request.method}, expected GET."
                    )
                inventory = server_state["inventory"]
                summary = {
                    "total": len(inventory),
                    "unused": sum(item["group"] == "unused" for item in inventory),
                    "finished": sum(
                        item["group"] == "finished" for item in inventory
                    ),
                    "trash": sum(item["group"] == "trash" for item in inventory),
                }
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "initialized": server_state["initialized"],
                                "migration": (
                                    {"completedAt": "2026-07-25T10:00:00.000Z"}
                                    if server_state["initialized"]
                                    else None
                                ),
                                "summary": summary,
                                "inventory": inventory,
                                "claims": [],
                            },
                            "stub-inventory",
                        )
                    ),
                )

            def migration_route(route):
                if not require_stub_key(route):
                    return
                body = route.request.post_data_json
                server_state["migration_posts"].append(body)
                submitted_records = body.get("records", [])
                records = [
                    {**record, "id": f"server-{index}"}
                    for index, record in enumerate(submitted_records, start=1)
                ]
                server_state["inventory"] = [
                    server_state["inventory"][0],
                    *records,
                ]
                server_state["initialized"] = True
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "summary": {
                                    "total": 4,
                                    "unused": 2,
                                    "finished": 1,
                                    "trash": 1,
                                },
                                "migration": {
                                    "completedAt": "2026-07-25T10:00:00.000Z"
                                },
                            },
                            "stub-migration",
                        )
                    ),
                )

            def legacy_api_route(route):
                if not require_stub_key(route):
                    return
                path = route.request.url
                if path.endswith("/api/icloud/status"):
                    body = {"ok": False, "error": "stubbed iCloud status"}
                elif path.endswith("/api/icloud/list"):
                    body = {"emails": []}
                else:
                    body = {"updates": [], "errors": [], "checked": []}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(body),
                )

            page.route("**/v1/inventory", inventory_route)
            page.route("**/v1/migrations/local-storage", migration_route)
            page.route("**/api/**", legacy_api_route)

            page.goto(url, wait_until="domcontentloaded", timeout=15_000)
            page.wait_for_selector("#apiKeyDialog[open]", timeout=5_000)
            if server_state["missing_key_requests"]:
                raise AssertionError("Protected requests ran before API-key entry.")

            page.fill("#apiKeyInput", API_KEY)
            page.click("#apiKeySubmit")
            # 密钥通过后原生 dialog 必须自行关闭，否则模态遮罩会挡住迁移卡片。
            page.wait_for_selector(
                "#apiKeyDialog[open]", state="detached", timeout=5_000
            )
            page.wait_for_selector("#migrationCard:not([hidden])", timeout=5_000)
            page.wait_for_selector(
                '#mailList .row[data-id="server-existing"]', timeout=5_000
            )
            if page.locator('#mailList .row[data-id^="legacy-"]').count():
                raise AssertionError(
                    "Legacy localStorage rows appeared as editable inventory."
                )

            counts = {
                "total": page.locator("#migrationTotal").inner_text(),
                "unused": page.locator("#migrationUnused").inner_text(),
                "finished": page.locator("#migrationFinished").inner_text(),
                "trash": page.locator("#migrationTrash").inner_text(),
            }
            if counts != {
                "total": "3",
                "unused": "1",
                "finished": "1",
                "trash": "1",
            }:
                raise AssertionError(f"Unexpected migration summary: {counts}")
            if page.evaluate("() => window.__legacyInventoryReads") != 1:
                raise AssertionError(
                    "Legacy inventory must be read once into one migration snapshot."
                )

            page.click("#confirmMigrationBtn")
            wait_for_page_condition(page,
                "() => document.querySelector('#migrationCard').hidden"
            )

            if len(server_state["migration_posts"]) != 1:
                raise AssertionError("Migration was not submitted exactly once.")
            if page.evaluate("() => window.__legacyInventoryReads") != 1:
                raise AssertionError(
                    "Migration confirmation re-read localStorage instead of using the snapshot."
                )
            submitted = server_state["migration_posts"][0]["records"]
            finished = next(
                item for item in submitted if item["group"] == "finished"
            )
            trash = next(item for item in submitted if item["group"] == "trash")
            if finished["remark"] != "do not reuse" or not finished["unread"]:
                raise AssertionError("Finished record state was not preserved.")
            for field in (
                "code",
                "subject",
                "preview",
                "receivedAt",
                "statusType",
                "statusMessage",
                "lastCheckedAt",
            ):
                if finished.get(field) != legacy_records[1].get(field):
                    raise AssertionError(f"Mail field was not preserved: {field}")
            if trash["remark"] != "discarded":
                raise AssertionError("Trash record state was not preserved.")

            legacy_after = page.evaluate(
                "(key) => localStorage.getItem(key)", LEGACY_KEY
            )
            if legacy_after != original_legacy_json:
                raise AssertionError("Original localStorage snapshot was changed.")
            local_storage_dump = page.evaluate("() => JSON.stringify(localStorage)")
            if API_KEY in local_storage_dump:
                raise AssertionError("API key leaked into localStorage.")
            if page.evaluate(
                "() => sessionStorage.getItem('mail-code-dashboard-api-key-v1')"
            ) != API_KEY:
                raise AssertionError("API key was not kept in sessionStorage.")

            page.reload(wait_until="domcontentloaded")
            wait_for_page_condition(page,
                "() => document.querySelector('#migrationCard').hidden"
            )
            wait_for_page_condition(page,
                "() => document.querySelector('#totalCount').textContent === '4'"
            )
            if len(server_state["migration_posts"]) != 1:
                raise AssertionError(
                    "Initialized server inventory triggered an automatic overwrite."
                )
            assert_no_browser_errors(browser_errors, "Migration")

            context.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    print("migration smoke test passed")


if __name__ == "__main__":
    main()
