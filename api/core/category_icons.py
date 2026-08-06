import sqlite3

# Shared by api/routes/database.py (admin upload route), api/routes/dataset.py
# (public serve route), and scripts/migrate_category_icons.py (Phase 3
# one-time migration) — kept here rather than duplicated in each, and
# separate from both routers to avoid a database.py <-> dataset.py import
# cycle (dataset.py doesn't otherwise import from database.py or vice versa).

# PNG/JPEG/WEBP/SVG — the same four raster/vector formats already in real
# use across api/static/img today (confirmed in Phase 0: .png, .webp are
# the two extensions the existing category icon files actually use; JPEG/SVG
# added for normal admin-upload flexibility, not because anything currently
# uses them). Keyed by the client-supplied Content-Type; "image/jpg" isn't a
# real MIME type but browsers/tools send it often enough to accept
# defensively, normalized to the correct "image/jpeg" for storage.
ALLOWED_ICON_CONTENT_TYPES = {
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/webp": "image/webp",
    "image/svg+xml": "image/svg+xml",
}

# 512 KB: the real existing category icons (Phase 0 inventory) range from
# ~3 KB to ~42 KB. 512 KB gives an order-of-magnitude headroom above the
# largest real one for a heavier PNG or an admin's non-ideal export, while
# still firmly rejecting something hero-image-sized that clearly isn't a UI
# icon — these render at a few dozen pixels across (category-card-icon),
# never full-size.
MAX_ICON_BYTES = 512 * 1024


def ensure_icon_columns(con: sqlite3.Connection) -> None:
    """Idempotent lazy migration — same shape as scripts/indexing_worker.py's
    _ensure_unavailable_column: CREATE TABLE IF NOT EXISTS elsewhere already
    guarantees `categories` exists, so this is the actual migration for any
    pre-existing deployment (the real shared pelican.db has been running
    since before this feature). "duplicate column" on a DB that already has
    these (in-process or from an earlier call) is the expected, harmless
    outcome, not an error — same "try ALTER, catch, ignore" convention used
    everywhere else in this codebase for adding a column to a live table.

    icon_data: the actual image bytes (BLOB) — see Phase 1's reasoning in
    the design conversation for why a DB BLOB column was chosen over
    shared-filesystem storage: icons here are small (see MAX_ICON_BYTES)
    and few (a handful of categories), so "one source of truth already
    inside the DB every PUN process already reads" beats coordinating a
    second store for no real benefit at this scale.
    icon_content_type: the validated Content-Type to serve it back with —
    stored per-row since different categories can use different formats.
    icon_updated_at: upload timestamp, for admin-facing "last changed" info
    and to distinguish a freshly-migrated row from one never touched.
    """
    for ddl in (
        "ALTER TABLE categories ADD COLUMN icon_data BLOB",
        "ALTER TABLE categories ADD COLUMN icon_content_type TEXT",
        "ALTER TABLE categories ADD COLUMN icon_updated_at TEXT",
    ):
        try:
            con.execute(ddl)
        except sqlite3.OperationalError:
            pass


def validate_icon_upload(content_type: str, data: bytes) -> str:
    """Raises ValueError with a user-facing message on a bad upload.
    Returns the normalized Content-Type to actually store (see
    ALLOWED_ICON_CONTENT_TYPES' "image/jpg" note) otherwise. No
    image-manipulation/re-encoding here by design — validate and store the
    bytes exactly as uploaded, per this feature's explicit scope."""
    normalized = (content_type or "").split(";")[0].strip().lower()
    if normalized not in ALLOWED_ICON_CONTENT_TYPES:
        raise ValueError(
            f'Unsupported image type "{content_type or "unknown"}". Allowed: PNG, JPEG, WEBP, SVG.'
        )
    if not data:
        raise ValueError("Uploaded file is empty.")
    if len(data) > MAX_ICON_BYTES:
        raise ValueError(
            f"Icon is too large ({len(data)} bytes) — max {MAX_ICON_BYTES // 1024} KB."
        )
    return ALLOWED_ICON_CONTENT_TYPES[normalized]
