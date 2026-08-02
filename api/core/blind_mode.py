from pathlib import Path

from api.core.config import BLIND_MODE_PATH

_FLAG_PATH = Path(BLIND_MODE_PATH)


def is_blind_mode() -> bool:
    """Presence of the flag file is the on/off state — simplest possible
    representation for a boolean that just needs to survive across
    requests/processes. No content to parse, no format to get wrong."""
    return _FLAG_PATH.exists()


def set_blind_mode(enabled: bool) -> None:
    if enabled:
        _FLAG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _FLAG_PATH.touch()
    else:
        _FLAG_PATH.unlink(missing_ok=True)
