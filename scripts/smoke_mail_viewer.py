"""邮件查看器冒烟测试。

自托管 mail-code-dashboard.html（ThreadingHTTPServer + Playwright 路由桩），验证
领取记录与邮件对话框：

  * 领取记录列出 claimId / 邮箱 / 时间，已释放的记录收件按钮为禁用态；
  * 点「查看邮件」打开原生 `<dialog id="mailDialog">`，`#mailPreview` 渲染出
    发件人 / 主题 / 正文 / 推荐链接；
  * 验证码逐个可复制、链接全部带 target=_blank 与 noopener noreferrer；
  * HTML 预览走 sandbox iframe，邮件里的 `<script>` 不会执行；
  * 空轮询结果显示「尚未收到邮件」而不是报错；
  * 点已释放记录的禁用按钮不会发出收件请求。

DOM 说明：a0af125 重建了收件台。旧的 `#modalBackdrop.open` 自建浮层已换成原生
`<dialog id="mailDialog">`（`showModal()`，打开时页面其余部分 inert），关闭按钮
从 `#closeModalBtn` 换成 `[data-close-dialog]`，领取记录则收进了折叠面板
`<details id="claimHistoryPanel">`——面板展开时才会渲染行。定位一律优先 id 与
data-*。
"""

import json
import re
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

# 密集行放不下完整时间戳，`formatRelativeTime()` 输出的是短相对时间，超过 30 天
# 才退回 zh-CN 的 MM/DD。空值会变成 "暂无"，所以这里必须整串匹配。
RELATIVE_STAMP = re.compile(r"刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前|\d{2}/\d{2}")
SANDBOX_SCRIPT_BLOCKED_ERROR = (
    "console.error: Blocked script execution in 'about:srcdoc' because the "
    "document's frame is sandboxed and the 'allow-scripts' permission is not set."
)


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


def close_mail_dialog(page):
    """点关闭按钮收起邮件对话框，并等 `<dialog open>` 真正消失。

    `openDialog()` 用的是 `showModal()`，对话框开着的时候页面其余部分是 inert
    的，点不动——所以后续操作前必须确认它关掉了。
    """
    page.click("#mailDialog [data-close-dialog]")
    page.wait_for_selector("#mailDialog[open]", state="detached")


def main():
    claims = [
        {
            "claimId": "active-claim",
            "emailId": "inventory-1",
            "email": "active.alias@icloud.com",
            "status": "active",
            "claimedAt": "2026-07-25T10:00:00.000Z",
            "releasedAt": None,
            "releaseReason": "",
        },
        {
            "claimId": "waiting-claim",
            "emailId": "inventory-2",
            "email": "waiting.alias@icloud.com",
            "status": "active",
            "claimedAt": "2026-07-25T10:01:00.000Z",
            "releasedAt": None,
            "releaseReason": "",
        },
        {
            "claimId": "released-claim",
            "emailId": "inventory-3",
            "email": "released.alias@icloud.com",
            "status": "released",
            "claimedAt": "2026-07-25T09:00:00.000Z",
            "releasedAt": "2026-07-25T09:30:00.000Z",
            "releaseReason": "synthetic release",
        },
    ]
    inventory = [
        {
            "id": claim["emailId"],
            "email": claim["email"],
            "group": "finished",
            "label": f"hme-00{index}",
            "remark": f"hme-00{index}",
            "unread": False,
        }
        for index, claim in enumerate(claims, start=1)
    ]
    message = {
        "id": "INBOX:42",
        "mailbox": "INBOX",
        "uid": 42,
        "from": "sender@example.test",
        "subject": "Synthetic verification",
        "receivedAt": "2026-07-25T10:02:00.000Z",
        "text": "Synthetic safe text for the viewer.",
        "html": (
            "<p>Synthetic safe HTML.</p>"
            "<script>parent.syntheticMailScriptExecuted = true</script>"
        ),
        "codes": ["123456", "987654"],
        "links": [
            "https://example.test/verify",
            "https://example.test/help",
        ],
        "primaryLink": "https://example.test/verify",
    }
    mail_requests = []

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}/mail-code-dashboard.html"

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            browser_errors = capture_browser_errors(page)
            mock_background_auto_stock(page)
            page.add_init_script(
                f"""
                if (window.top === window) {{
                  sessionStorage.setItem(
                    "mail-code-dashboard-api-key-v1",
                    {json.dumps(API_KEY)}
                  );
                  localStorage.setItem(
                    "mail-code-dashboard-auto-stock-v2",
                    JSON.stringify({{ enabled: false }})
                  );
                }}
                """
            )

            def require_key(route):
                if route.request.headers.get("x-api-key") != API_KEY:
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
                if not require_key(route):
                    return
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope(
                            {
                                "initialized": True,
                                "migration": {
                                    "completedAt": "2026-07-25T08:00:00.000Z"
                                },
                                "summary": {
                                    "total": 3,
                                    "unused": 0,
                                    "finished": 3,
                                    "trash": 0,
                                },
                                "inventory": inventory,
                                "claims": claims,
                            },
                            "stub-inventory",
                        )
                    ),
                )

            def latest_route(route):
                if not require_key(route):
                    return
                mail_requests.append(route.request.url)
                claim_id = route.request.url.split("/v1/claims/", 1)[1].split(
                    "/", 1
                )[0]
                result = message if claim_id == "active-claim" else None
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        envelope({"message": result}, f"stub-{claim_id}")
                    ),
                )

            def legacy_route(route):
                if not require_key(route):
                    return
                if route.request.url.endswith("/api/icloud/status"):
                    body = {"ok": False, "error": "stubbed iCloud status"}
                elif route.request.url.endswith("/api/icloud/list"):
                    body = {"emails": []}
                else:
                    body = {"updates": [], "errors": [], "checked": []}
                route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(body),
                )

            page.route("**/v1/inventory*", inventory_route)
            page.route("**/v1/claims/*/messages/latest*", latest_route)
            page.route("**/api/**", legacy_route)

            page.goto(url, wait_until="domcontentloaded", timeout=15_000)
            page.evaluate(
                "() => { window.syntheticMailScriptExecuted = false; }"
            )
            # 领取记录在折叠面板里，展开后才渲染行。
            page.click("#claimHistoryPanel > summary")
            page.wait_for_selector(
                '#claimHistoryList [data-claim-id="released-claim"]',
                timeout=5_000,
            )
            history = page.locator("#claimHistoryList").inner_text()
            for expected in (
                "active-claim",
                "active.alias@icloud.com",
                "released-claim",
                "released.alias@icloud.com",
            ):
                if expected not in history:
                    raise AssertionError(f"Claim history omitted {expected!r}.")

            # 时间戳照旧要落到行里，只是 a0af125 之后是短相对时间而不是年份。
            for claim_id, prefixes in (
                ("active-claim", ("领取：",)),
                ("released-claim", ("领取：", "释放：")),
            ):
                labels = page.locator(
                    f'#claimHistoryList .claim-row:has([data-claim-id="{claim_id}"]) span'
                ).all_inner_texts()
                for prefix in prefixes:
                    stamps = [
                        text[len(prefix):].strip()
                        for text in labels
                        if text.startswith(prefix)
                    ]
                    if len(stamps) != 1:
                        raise AssertionError(
                            f"Claim history row {claim_id!r} should show exactly one "
                            f"{prefix!r} stamp, got {stamps!r}."
                        )
                    if not RELATIVE_STAMP.fullmatch(stamps[0]):
                        raise AssertionError(
                            f"Claim history row {claim_id!r} shows "
                            f"{prefix}{stamps[0]!r} instead of a real timestamp."
                        )

            released_button = page.locator(
                '[data-claim-id="released-claim"][data-action="claim-mail"]'
            )
            if not released_button.is_disabled():
                raise AssertionError("Released claim mail polling is not disabled.")

            claim_tags = page.evaluate(
                """() => Object.fromEntries(
                  ["active-claim", "released-claim"].map(claimId => {
                    const tag = document.querySelector(
                      `.claim-row:has([data-claim-id="${claimId}"]) .tag`
                    );
                    const style = getComputedStyle(tag);
                    return [
                      claimId,
                      {
                        tone: tag.dataset.tone,
                        color: style.color,
                        background: style.backgroundColor
                      }
                    ];
                  })
                )"""
            )
            if claim_tags["active-claim"]["tone"] != "ok":
                raise AssertionError(f"Active claim tag is not ok: {claim_tags!r}.")
            if claim_tags["released-claim"]["tone"] != "neutral":
                raise AssertionError(
                    f"Released claim tag is not neutral: {claim_tags!r}."
                )
            if (
                claim_tags["active-claim"]["color"]
                == claim_tags["released-claim"]["color"]
                or claim_tags["active-claim"]["background"]
                == claim_tags["released-claim"]["background"]
            ):
                raise AssertionError(
                    f"Claim tones did not produce distinct computed styles: {claim_tags!r}."
                )

            page.click(
                '[data-claim-id="active-claim"][data-action="claim-mail"]'
            )
            page.wait_for_selector("#mailDialog[open]", timeout=5_000)
            wait_for_page_condition(page,
                "() => document.querySelector('#mailPreview').textContent.includes('sender@example.test')"
            )
            preview = page.locator("#mailPreview").inner_text()
            for expected in (
                "sender@example.test",
                "Synthetic verification",
                "Synthetic safe text for the viewer.",
                "推荐链接",
            ):
                if expected not in preview:
                    raise AssertionError(f"Mail viewer omitted {expected!r}.")

            code_buttons = page.locator("#mailPreview .message-code")
            if code_buttons.count() != 2:
                raise AssertionError("Codes are not individually copyable.")
            links = page.locator("#mailPreview a.message-link")
            if links.count() != 2:
                raise AssertionError("Mail viewer did not show all links.")
            for index in range(links.count()):
                anchor = links.nth(index)
                if anchor.get_attribute("target") != "_blank":
                    raise AssertionError("External link does not open in a new tab.")
                rel = set((anchor.get_attribute("rel") or "").split())
                if not {"noopener", "noreferrer"}.issubset(rel):
                    raise AssertionError("External link is missing safe rel values.")
            if page.locator("#mailPreview .primary-link").count() != 1:
                raise AssertionError("Primary link is not identified.")

            iframe = page.locator("#mailPreview iframe")
            if iframe.count() != 1 or iframe.get_attribute("sandbox") != "":
                raise AssertionError(
                    "Sanitized HTML iframe must grant no sandbox permissions."
                )
            page.wait_for_timeout(200)
            if page.evaluate("() => window.syntheticMailScriptExecuted"):
                raise AssertionError("Sandboxed message HTML executed its script.")

            close_mail_dialog(page)
            page.click(
                '[data-claim-id="waiting-claim"][data-action="claim-mail"]'
            )
            page.wait_for_selector("#mailDialog[open]", timeout=5_000)
            wait_for_page_condition(page,
                "() => document.querySelector('#mailPreview').textContent.includes('尚未收到邮件')"
            )
            if "尚未收到邮件" not in page.locator("#mailPreview").inner_text():
                raise AssertionError("Normal empty polling result was shown as an error.")

            # 对话框必须先关掉：模态 <dialog> 会让下面的按钮 inert，否则这一次
            # 点击根本碰不到按钮，断言就永远成立了。
            close_mail_dialog(page)
            before_released_click = len(mail_requests)
            # 直接派发 click 而不是走真鼠标：`.toast` 是 fixed 在右下角且没有
            # pointer-events: none，通知一冒出来就正好盖住这颗按钮，force 点击
            # 会落到通知上，这条断言就白跑了。派发事件既绕开遮挡，又能真的验到
            # JS 侧的 disabled / status 守卫，而不只是浏览器对 disabled 的处理。
            released_button.dispatch_event("click")

            # `openClaimMail()` 是先开对话框再发请求，所以对话框没开就等于这次
            # 点击什么都没触发——这一步是同步的，不用等。
            if page.locator("#mailDialog[open]").count():
                raise AssertionError("Released claim opened the mail viewer.")

            # 不用 sleep 去猜请求有没有发出来：紧接着点一次「一定会发请求」的
            # 领取中记录当哨兵，等它的响应渲染出来，就说明上一次点击若真发了
            # 请求也早已记录在案。
            page.click(
                '[data-claim-id="active-claim"][data-action="claim-mail"]'
            )
            page.wait_for_selector("#mailDialog[open]", timeout=5_000)
            wait_for_page_condition(page,
                "() => document.querySelector('#mailPreview')"
                ".textContent.includes('sender@example.test')"
            )
            new_requests = mail_requests[before_released_click:]
            if len(new_requests) != 1 or "/active-claim/" not in new_requests[0]:
                raise AssertionError(
                    f"Released claim triggered a mail request: {new_requests!r}."
                )

            page.wait_for_timeout(200)
            if page.evaluate("() => window.syntheticMailScriptExecuted"):
                raise AssertionError("Repeated sandboxed HTML executed its script.")
            sandbox_diagnostics = [
                error
                for error in browser_errors
                if error == SANDBOX_SCRIPT_BLOCKED_ERROR
            ]
            unexpected_browser_errors = [
                error
                for error in browser_errors
                if error != SANDBOX_SCRIPT_BLOCKED_ERROR
            ]
            if len(sandbox_diagnostics) != 2:
                raise AssertionError(
                    "Expected exactly two sandbox script-block diagnostics, "
                    f"got {sandbox_diagnostics!r} from {browser_errors!r}."
                )
            assert_no_browser_errors(unexpected_browser_errors, "Mail viewer")
            context.close()
            browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)

    print("mail viewer smoke test passed")


if __name__ == "__main__":
    main()
