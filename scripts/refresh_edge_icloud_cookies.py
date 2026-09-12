import base64
import json
import os
import secrets
import sqlite3
import sys
from pathlib import Path

import win32crypt
from Crypto.Cipher import AES

EDGE_USER_DATA = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Edge" / "User Data"
# POLYGLOT_COOKIE_CONTRACT: this tuple is intentionally duplicated in server.mjs
# and the Edge extension; cookie-refresh-scripts.test.mjs compares all three.
SYNCED_COOKIE_NAMES = (
    "X-APPLE-DS-WEB-SESSION-TOKEN",
    "X-APPLE-WEBAUTH-TOKEN",
    "X-APPLE-WEBAUTH-PCS-Mail",
    "X-APPLE-WEBAUTH-HSA-TRUST",
    "X-APPLE-WEBAUTH-LOGIN",
    "X-APPLE-WEBAUTH-USER",
)
CANONICAL_COOKIE_NAMES = {name.casefold(): name for name in SYNCED_COOKIE_NAMES}
REQUIRED_COOKIES = ("X-APPLE-DS-WEB-SESSION-TOKEN", "X-APPLE-WEBAUTH-TOKEN")
# Edge 127+ re-encrypts cookies with app-bound encryption. The blob is tagged
# `v20` and its key lives in `os_crypt.app_bound_encrypted_key`, which only the
# browser process itself may unwrap — DPAPI from another process cannot.
APP_BOUND_PREFIX = b"v20"
# The guest profile never holds a signed-in session, so scanning it only makes
# the "which profile did we look at" message noisier.
SKIPPED_PROFILES = ("Guest Profile", "System Profile")
PAYLOAD_FLAG = "--payload"


def decrypt_master_key():
    local_state_path = EDGE_USER_DATA / "Local State"
    state = json.loads(local_state_path.read_text(encoding="utf-8"))
    encrypted_key = base64.b64decode(state["os_crypt"]["encrypted_key"])
    if encrypted_key.startswith(b"DPAPI"):
        encrypted_key = encrypted_key[5:]
    return win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]


def decrypt_cookie_value(encrypted_value, master_key):
    if not encrypted_value:
        return ""
    if encrypted_value.startswith(b"v10") or encrypted_value.startswith(b"v11"):
        nonce = encrypted_value[3:15]
        ciphertext = encrypted_value[15:-16]
        tag = encrypted_value[-16:]
        cipher = AES.new(master_key, AES.MODE_GCM, nonce=nonce)
        return cipher.decrypt_and_verify(ciphertext, tag).decode("utf-8")
    return win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode("utf-8")


def candidate_profiles():
    """Profiles to search, most likely first.

    The iCloud session is not necessarily in `Default` — hardcoding that name
    made this script report "cookies not found" on machines where the operator
    signed in from a secondary profile.
    """
    override = os.environ.get("EDGE_PROFILE", "").strip()
    if override:
        return [override]
    if not EDGE_USER_DATA.is_dir():
        return ["Default"]
    names = [
        entry.name
        for entry in sorted(EDGE_USER_DATA.iterdir())
        if entry.is_dir() and entry.name not in SKIPPED_PROFILES and (entry / "Network" / "Cookies").exists()
    ]
    return names or ["Default"]


def lazy_master_key():
    """Unwrap the Edge master key at most once, and only if a blob needs it.

    An app-bound (v20) profile never reaches the AES path, so paying for the
    DPAPI round trip up front would only turn a precise diagnosis into a
    "CryptUnprotectData failed" on machines where the key is unreadable.
    """
    cache = []

    def get():
        if not cache:
            cache.append(decrypt_master_key())
        return cache[0]

    return get


def read_profile_cookies(profile, master_key):
    """Return (ordered name/value pairs, count of undecryptable blobs)."""
    cookies_db = EDGE_USER_DATA / profile / "Network" / "Cookies"
    if not cookies_db.exists():
        raise FileNotFoundError(f"Edge cookie DB not found: {cookies_db}")

    db_uri = cookies_db.resolve().as_uri()
    conn = sqlite3.connect(f"{db_uri}?mode=ro&immutable=1", uri=True)
    try:
        rows = conn.execute(
            """
            SELECT host_key, name, value, encrypted_value
            FROM cookies
            WHERE host_key LIKE '%icloud.com'
               OR host_key LIKE '%apple.com'
               OR host_key LIKE '%apple.com.cn'
            """
        ).fetchall()
    finally:
        conn.close()

    deduped = {}
    order = []
    app_bound = 0
    undecryptable = 0
    for _host, name, value, encrypted in rows:
        canonical_name = CANONICAL_COOKIE_NAMES.get(name.casefold())
        if canonical_name is None:
            continue
        decoded = value
        if not decoded:
            if encrypted and encrypted.startswith(APP_BOUND_PREFIX):
                app_bound += 1
                continue
            try:
                decoded = decrypt_cookie_value(encrypted, master_key())
            except Exception:
                undecryptable += 1
                continue
        if not decoded:
            continue
        # Keep the newest value for duplicate names while preserving first-seen order.
        if canonical_name not in deduped:
            order.append(canonical_name)
        deduped[canonical_name] = decoded
    return [(name, deduped[name]) for name in order], app_bound, undecryptable


def load_icloud_cookies():
    profiles = candidate_profiles()
    explicit_profile = bool(os.environ.get("EDGE_PROFILE", "").strip())
    master_key = lazy_master_key()
    scanned = []
    valid_sessions = []
    read_errors = []
    app_bound_total = 0
    undecryptable_total = 0
    for profile in profiles:
        try:
            pairs, app_bound, undecryptable = read_profile_cookies(profile, master_key)
        except FileNotFoundError:
            continue
        except (OSError, sqlite3.Error) as exc:
            # A stale/locked/corrupt secondary profile must not hide a valid
            # session in another profile. Keep diagnostics deliberately free of
            # the exception message: sqlite and OSError messages commonly embed
            # the operator's full User Data path.
            read_errors.append((profile, type(exc).__name__))
            continue
        scanned.append(profile)
        app_bound_total += app_bound
        undecryptable_total += undecryptable
        names = [name for name, _ in pairs]
        available_names = {name.casefold() for name in names}
        if all(required.casefold() in available_names for required in REQUIRED_COOKIES):
            header = ";".join(f"{name}={value}" for name, value in pairs)
            valid_sessions.append((profile, header, names))

    if explicit_profile and valid_sessions:
        return valid_sessions[0]
    if len(valid_sessions) == 1:
        return valid_sessions[0]
    if len(valid_sessions) > 1:
        names = ", ".join(profile for profile, _header, _names in valid_sessions)
        raise RuntimeError(
            f"multiple Edge profiles contain valid iCloud sessions ({names}); "
            "set EDGE_PROFILE explicitly to avoid switching Apple identities"
        )

    if not scanned and not read_errors:
        raise FileNotFoundError(f"Edge cookie DB not found for profile(s) {', '.join(profiles)}")

    where = ", ".join(scanned)
    if app_bound_total:
        raise RuntimeError(
            f"Edge stores its cookies with app-bound encryption (v20) in profile(s) {where}; "
            "DPAPI cannot decrypt them from outside the browser. "
            "Use the iCloud Cookie Bridge extension or the CDP bridge instead."
        )
    if undecryptable_total:
        raise RuntimeError(
            f"found {undecryptable_total} iCloud cookie(s) in profile(s) {where} but none could be "
            "decrypted; the Edge encryption key no longer matches this profile."
        )
    if read_errors:
        details = ", ".join(f"{profile} ({error_type})" for profile, error_type in read_errors)
        raise RuntimeError(
            f"could not read the Edge cookie DB for profile(s) {details}; "
            "close Edge if the database is locked, or set EDGE_PROFILE to a readable profile"
        )
    raise RuntimeError(
        f"required iCloud session cookies not found in Edge profile(s) {where}; "
        "sign in to icloud.com in Edge (set EDGE_PROFILE if the session lives in another profile)"
    )


def write_secret_file_atomic(output_path, contents):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.parent / (f".{output_path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    descriptor = None
    try:
        descriptor = os.open(
            temporary_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        stream = os.fdopen(descriptor, "w", encoding="utf-8")
        descriptor = None
        with stream:
            stream.write(contents)
        os.replace(temporary_path, output_path)
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)
        raise


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing output path"}))
        return 2
    payload_only = sys.argv[1] == PAYLOAD_FLAG
    output_path = None if payload_only else Path(sys.argv[1])
    try:
        profile, header, names = load_icloud_cookies()
        if output_path is not None:
            write_secret_file_atomic(output_path, header)
        result = {
            "ok": True,
            "profile": profile,
            "count": len(names),
            "hasMailPcs": "X-APPLE-WEBAUTH-PCS-Mail" in names,
        }
        if payload_only:
            result["cookieHeader"] = header
        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
