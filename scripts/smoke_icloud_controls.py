import os

from browser_smoke_support import (
    assert_no_browser_errors,
    capture_browser_errors,
)
from playwright.sync_api import sync_playwright


def main():
    url = os.environ.get("DASHBOARD_URL", "http://localhost:4173/")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        browser_errors = capture_browser_errors(page)
        page.goto(url, wait_until="networkidle", timeout=15_000)
        sync_button = page.get_by_role("button", name="同步 iCloud")
        count = sync_button.count()
        prefix_value = page.locator("#icloudPrefix").get_attribute("value")
        assert_no_browser_errors(browser_errors, "iCloud controls")
        browser.close()

    if count != 1:
        raise AssertionError(f"expected one visible sync iCloud button, got {count}")
    if prefix_value == "changsheng":
        raise AssertionError("default iCloud prefix should not be hard-coded to changsheng")

    print("icloud controls smoke test passed")


if __name__ == "__main__":
    main()
