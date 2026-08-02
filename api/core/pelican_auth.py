import os
from datetime import datetime, timezone
from pathlib import Path

# Per-user, same reasoning as DOWNLOADS_DB_PATH in api/core/config.py: PUN
# means $HOME already resolves to this OS user's own home directory, so a
# flat per-namespace file here is already isolated per user with no extra
# identity plumbing needed.
TOKEN_DIR = Path(os.path.expanduser("~")) / ".pelican-ui" / "tokens"

# Permanent diagnostic file for whatever still reaches pelicanlistPath's/
# download_one_file's generic exception branch (the one that produces the
# "Couldn't reach the Pelican/OSDF federation" 502) despite the auth-detection
# widening done 2026-08-02. Exists because OOD/Passenger server logs aren't
# easily reachable day-to-day — this makes the next unhandled case debuggable
# by opening one file, no log access needed.
LAST_ERROR_LOG = Path(os.path.expanduser("~")) / ".pelican-ui" / "last_error.log"
_LAST_ERROR_LOG_MAX_LINES = 20


def _encode_namespace(namespace: str) -> str:
    """Namespace path -> filesystem-safe filename. Reversible enough to stay
    debuggable (ls the directory and you can read off the namespace), not
    meant to survive namespaces that legitimately contain an underscore."""
    return namespace.strip("/").replace("/", "_")


def get_token_for_namespace(namespace: str) -> str | None:
    token_path = TOKEN_DIR / _encode_namespace(namespace)
    try:
        token = token_path.read_text().strip()
    except FileNotFoundError:
        return None
    return token or None


def save_token_for_namespace(namespace: str, token: str) -> None:
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TOKEN_DIR, 0o700)
    token_path = TOKEN_DIR / _encode_namespace(namespace)
    token_path.write_text(token.strip())
    os.chmod(token_path, 0o600)


def has_token_for_namespace(namespace: str) -> bool:
    return (TOKEN_DIR / _encode_namespace(namespace)).exists()


def log_unexpected_pelican_error(namespace: str, exc: Exception) -> None:
    """Appends one line describing exc to LAST_ERROR_LOG, keeping only the
    last _LAST_ERROR_LOG_MAX_LINES. Best-effort — a failure here must never
    be the reason a request fails, so any I/O error is swallowed.

    Records exc's module + class name (not just str(exc)) because that's
    exactly the piece _is_auth_required needs and a plain message alone
    doesn't give you: e.g. "Unauthorized access to https://..." doesn't by
    itself tell you it's aiowebdav2.exceptions.UnauthorizedError rather than
    some other library's 401.
    """
    code = None
    for attr in ("status", "code", "status_code"):
        value = getattr(exc, attr, None)
        if value is not None:
            code = value
            break

    line = (
        f"{datetime.now(timezone.utc).isoformat()} "
        f"namespace={namespace!r} "
        f"module={type(exc).__module__} "
        f"class={type(exc).__name__} "
        f"code={code!r} "
        f"message={str(exc)!r}"
    )
    try:
        LAST_ERROR_LOG.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(LAST_ERROR_LOG.parent, 0o700)
        existing = LAST_ERROR_LOG.read_text().splitlines() if LAST_ERROR_LOG.exists() else []
        existing.append(line)
        LAST_ERROR_LOG.write_text("\n".join(existing[-_LAST_ERROR_LOG_MAX_LINES:]) + "\n")
    except OSError:
        pass
