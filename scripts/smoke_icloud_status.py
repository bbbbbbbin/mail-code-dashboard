"""iCloud 登录态接口冒烟测试。

用固定的合成 cookie 文件拉起一个临时端口上的 server.mjs，验证
`/api/icloud/status` 在只有 session + webauth cookie 时报告已登录，
且不会谎称拿到了 Mail PCS cookie。

`/api/*` 全部强制 `X-API-Key`，所以子进程用 `MAIL_DASHBOARD_API_KEY`
固定一个测试密钥，请求再带上同一个头 —— 不通过关闭鉴权来绕过。
"""

import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API_KEY = "synthetic-icloud-status-smoke-key"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url, api_key):
    request = Request(url, headers={"X-API-Key": api_key} if api_key else {})
    with urlopen(request, timeout=1) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_status(url, process):
    """轮询到服务就绪为止，但只对「还没起来」重试。

    连接层的失败（拒绝连接、读超时）说明服务还在启动，值得重试；HTTP 层的
    失败（例如鉴权 401）说明服务已经在监听并明确拒绝了请求，必须立刻抛出，
    不能被重试循环吞掉再伪装成启动超时。
    """
    last_error = None
    for _ in range(40):
        if process.poll() is not None:
            raise RuntimeError(
                f"server exited before becoming ready (code {process.returncode})"
            )
        try:
            return get_json(url, API_KEY)
        except HTTPError as exc:
            body = exc.read().decode("utf-8", "replace").strip()
            raise RuntimeError(
                f"server rejected {url} with HTTP {exc.code} {exc.reason}: {body}"
            ) from exc
        except OSError as exc:
            # URLError / TimeoutError / ConnectionError 都是 OSError 的子类，
            # 这些都属于「服务还没开始监听」，继续等。
            last_error = exc
            time.sleep(0.25)
    raise RuntimeError(f"server did not become ready: {last_error}")


def assert_key_is_enforced(url):
    """没有密钥必须被拒，证明上面的 200 是带对了头、而不是鉴权被关掉了。"""
    try:
        get_json(url, None)
    except HTTPError as exc:
        if exc.code != 401:
            raise AssertionError(
                f"unauthenticated request should be 401, got {exc.code}"
            ) from exc
        return
    raise AssertionError("unauthenticated request should have been rejected")


def main():
    root = Path(__file__).resolve().parents[1]
    port = free_port()

    with tempfile.TemporaryDirectory() as tmp:
        cookie_file = Path(tmp) / "cookies.txt"
        cookie_file.write_text(
            "X-APPLE-DS-WEB-SESSION-TOKEN=session;X-APPLE-WEBAUTH-TOKEN=webauth",
            encoding="utf-8",
        )

        env = {
            **os.environ,
            "PORT": str(port),
            "HME_COOKIE_FILE": str(cookie_file),
            "MAIL_DASHBOARD_API_KEY": API_KEY,
            # 状态文件也隔离到临时目录，避免和常驻服务抢同一份 runtime 状态。
            "MAIL_DASHBOARD_STATE_PATH": str(Path(tmp) / "dashboard-state.json"),
            "MAIL_DASHBOARD_BACKUP_DIR": str(Path(tmp) / "backups"),
            "MAIL_LIFECYCLE_LOG_PATH": str(Path(tmp) / "lifecycle.log"),
        }
        process = subprocess.Popen(
            ["node", "server.mjs"],
            cwd=root,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            url = f"http://127.0.0.1:{port}/api/icloud/status"
            status = wait_for_status(url, process)
            assert_key_is_enforced(url)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    if not status.get("ok"):
        raise AssertionError(f"session + webauth cookies should be enough for login status: {status}")
    if status.get("hasMailPcs"):
        raise AssertionError(f"test fixture should not include Mail PCS cookie: {status}")

    print("icloud status smoke test passed")


if __name__ == "__main__":
    main()
