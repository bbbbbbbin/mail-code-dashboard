"""Behavior tests for the static server used by browser smoke tests."""

import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR / "scripts"))

from browser_smoke_support import (  # noqa: E402
    STATIC_SECURITY_HEADERS,
    BrowserSmokeHandler,
)

APPROVED_ROUTES = {
    "/": ("text/html", "iCloud 隐藏邮箱收件台"),
    "/mail-code-dashboard.html": ("text/html", "iCloud 隐藏邮箱收件台"),
    "/design-system.html": ("text/html", "设计系统"),
    "/assets/design-system.css": ("text/css", "--brand:"),
    "/assets/dashboard.css": ("text/css", ".inventory-panel"),
    "/assets/design-system.js": ("text/javascript", "global.DS"),
    "/assets/dashboard-state.js": ("text/javascript", "export"),
    "/assets/dashboard-api.js": ("text/javascript", "export"),
    "/assets/dashboard-mail.js": ("text/javascript", "export"),
    "/assets/dashboard-ui.js": ("text/javascript", "export"),
    "/assets/dashboard.js": ("text/javascript", "import"),
}


class BrowserSmokeHandlerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), BrowserSmokeHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, path):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            body = response.read()
            headers = {name.lower(): value for name, value in response.getheaders()}
            return response.status, headers, body
        finally:
            connection.close()

    def assert_security_headers(self, headers):
        for name, expected in STATIC_SECURITY_HEADERS.items():
            self.assertEqual(headers.get(name.lower()), expected, name)

    def test_approved_routes_are_typed_and_never_cached(self):
        for path, (mime, marker) in APPROVED_ROUTES.items():
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertTrue(headers["content-type"].startswith(mime))
                self.assertEqual(headers.get("cache-control"), "no-store")
                self.assertIn(marker, body.decode("utf-8"))
                self.assert_security_headers(headers)

        status, headers, body = self.request("/favicon.ico")
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assert_security_headers(headers)

    def test_private_unknown_and_traversal_paths_are_not_served(self):
        paths = [
            "/server.mjs",
            "/package.json",
            "/unknown.txt",
            "/../server.mjs",
            "/%2e%2e/server.mjs",
            "/assets/../server.mjs",
            "/assets/%2e%2e/server.mjs",
        ]
        for path in paths:
            with self.subTest(path=path):
                status, headers, _body = self.request(path)
                self.assertEqual(status, 404)
                self.assertEqual(headers.get("cache-control"), "no-store")
                self.assert_security_headers(headers)


if __name__ == "__main__":
    unittest.main()
