"""Shared static hosting and browser-error checks for Playwright smokes."""

import json

from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from time import monotonic, sleep
from urllib.parse import urlsplit

PROJECT_DIR = Path(__file__).resolve().parent.parent
STATIC_FILES = {
    "/": PROJECT_DIR / "mail-code-dashboard.html",
    "/mail-code-dashboard.html": PROJECT_DIR / "mail-code-dashboard.html",
    "/design-system.html": PROJECT_DIR / "design-system.html",
    "/assets/design-system.css": PROJECT_DIR / "assets" / "design-system.css",
    "/assets/dashboard.css": PROJECT_DIR / "assets" / "dashboard.css",
    "/assets/design-system.js": PROJECT_DIR / "assets" / "design-system.js",
    "/assets/dashboard-state.js": PROJECT_DIR / "assets" / "dashboard-state.js",
    "/assets/dashboard-api.js": PROJECT_DIR / "assets" / "dashboard-api.js",
    "/assets/dashboard-mail.js": PROJECT_DIR / "assets" / "dashboard-mail.js",
    "/assets/dashboard-ui.js": PROJECT_DIR / "assets" / "dashboard-ui.js",
    "/assets/dashboard.js": PROJECT_DIR / "assets" / "dashboard.js",
}
STATIC_SECURITY_HEADERS = {
    "Content-Security-Policy": "; ".join(
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "frame-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def mock_background_auto_stock(page):
    """Explicit offline fixture for self-hosted UI tests; never calls Apple."""
    state = {"configured": True, "enabled": False, "prefix": "hme",
             "running": False, "nextAttemptAt": "", "pausedReason": "",
             "failureCount": 0, "lastGeneratedAt": "", "targetTotal": 1500}

    def respond(route):
        if route.request.method == "PATCH":
            patch = route.request.post_data_json or {}
            for key in ("enabled", "prefix"):
                if key in patch:
                    state[key] = patch[key]
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"ok": True, "data": state}))

    page.route("**/v1/auto-stock", respond)


class BrowserSmokeHandler(SimpleHTTPRequestHandler):
    """Serve the project with the same browser-facing policy as server.mjs."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIR), **kwargs)

    def do_GET(self):
        self._serve_static(head_only=False)

    def do_HEAD(self):
        self._serve_static(head_only=True)

    def _serve_static(self, *, head_only):
        path = urlsplit(self.path).path
        if path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        file_path = STATIC_FILES.get(path)
        if file_path is None:
            self._send_body(
                404,
                b"Not Found",
                "text/plain; charset=utf-8",
                head_only=head_only,
            )
            return

        try:
            body = file_path.read_bytes()
        except OSError:
            self._send_body(
                404,
                b"Not Found",
                "text/plain; charset=utf-8",
                head_only=head_only,
            )
            return

        content_type = self.extensions_map.get(
            file_path.suffix.lower(),
            "application/octet-stream",
        )
        if content_type.startswith(("text/", "application/javascript")):
            content_type = f"{content_type}; charset=utf-8"
        self._send_body(200, body, content_type, head_only=head_only)

    def _send_body(self, status, body, content_type, *, head_only):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def end_headers(self):
        for name, value in STATIC_SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def log_message(self, _format, *_args):
        return


def capture_browser_errors(page):
    """Return a live list populated by console.error and uncaught page errors."""

    errors = []

    def record_console(message):
        if message.type == "error":
            errors.append(f"console.error: {message.text}")

    page.on("console", record_console)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    return errors


def assert_no_browser_errors(errors, context="Browser"):
    """Fail a smoke at its final checkpoint if the page emitted an error."""

    if errors:
        raise AssertionError(f"{context} emitted browser errors: {errors}")


def wait_for_page_condition(page, expression, timeout=5_000, interval=0.05):
    """Poll through Playwright's isolated evaluator without requiring unsafe-eval."""

    deadline = monotonic() + timeout / 1_000
    last_value = None
    while monotonic() < deadline:
        last_value = page.evaluate(expression)
        if last_value:
            return last_value
        sleep(interval)
    raise AssertionError(
        f"Timed out after {timeout} ms waiting for page condition; "
        f"last value was {last_value!r}."
    )
