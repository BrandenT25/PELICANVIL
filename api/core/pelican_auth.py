import os
from pathlib import Path

# Per-user, same reasoning as DOWNLOADS_DB_PATH in api/core/config.py: PUN
# means $HOME already resolves to this OS user's own home directory, so a
# flat per-namespace file here is already isolated per user with no extra
# identity plumbing needed.
TOKEN_DIR = Path(os.path.expanduser("~")) / ".pelican-ui" / "tokens"


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
