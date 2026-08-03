import os
from pathlib import Path

# ~/.pelican-ui/ is already the established location for per-user local state
# on this PUN-per-user deployment (see DOWNLOADS_DB_PATH in config.py) — tokens
# live alongside it rather than in a database, since $HOME isolation already
# gives per-user separation and a user-identity column would be redundant.
TOKENS_DIR = Path(os.path.expanduser("~")) / ".pelican-ui" / "tokens"


def _encode_namespace(namespace: str) -> str:
    # Reversible enough to stay debuggable (ls the directory, swap _ back to
    # / by eye) without needing a separate manifest file.
    return namespace.lstrip("/").replace("/", "_")


def _token_path(namespace: str) -> Path:
    return TOKENS_DIR / _encode_namespace(namespace)


def get_token_for_namespace(namespace: str) -> str | None:
    path = _token_path(namespace)
    if not path.is_file():
        return None
    token = path.read_text().strip()
    return token or None


def has_token_for_namespace(namespace: str) -> bool:
    return _token_path(namespace).is_file()


def save_token_for_namespace(namespace: str, token: str) -> None:
    TOKENS_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TOKENS_DIR, 0o700)
    path = _token_path(namespace)
    path.write_text(token)
    os.chmod(path, 0o600)
