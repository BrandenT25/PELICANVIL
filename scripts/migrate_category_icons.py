"""One-time (but safely re-runnable) migration: backfills the new
icon_data/icon_content_type DB columns (api/core/category_icons.py) for
every existing category from its legacy static-file icon (the `icon` TEXT
column, e.g. "api/static/img/climate-category-icon.png") — so categories
that already had a real icon keep it with zero manual admin action, per
this feature's explicit requirement (no manual re-upload needed).

Idempotent by design, not by a "skip if already migrated" check: every run
re-reads the static file straight off disk and rewrites icon_data from
those bytes. Same file -> same bytes -> same result, so running this
repeatedly (every app startup — see main.py) never duplicates or corrupts
anything; it also means a corrupted/never-completed prior run self-heals on
the next one rather than needing special-cased recovery logic.

Safe to run with `icon` unset (skipped, not an error — most categories may
never have had a static icon at all) and reports plainly, not silently,
about any icon file in api/static/img that matches the
"*-category-icon.*" naming convention but isn't referenced by any
category's `icon` column — an orphaned file, left in place for a human to
review (no auto-delete, per this task's explicit scope).
"""

import logging
import mimetypes
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from api.core.category_icons import ALLOWED_ICON_CONTENT_TYPES, ensure_icon_columns, validate_icon_upload
from api.core.config import DB_PATH

logger = logging.getLogger("pelican-ui.migrate_category_icons")

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_IMG_DIR = REPO_ROOT / "api" / "static" / "img"

# The naming convention every real category icon file in api/static/img
# actually follows today (confirmed in Phase 0: biology-, climate-,
# genomics-, machine-learning-, physics-category-icon.*) — used only to
# find *candidate* orphan files to flag below, never to guess which
# category a file belongs to (that match is always via the DB's own `icon`
# column value, the actual source of truth, not a re-derived filename
# pattern).
CATEGORY_ICON_GLOB = "*-category-icon.*"


def _content_type_for(path: Path) -> str | None:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed in ALLOWED_ICON_CONTENT_TYPES:
        return ALLOWED_ICON_CONTENT_TYPES[guessed]
    return None


def migrate_category_icons() -> dict:
    """Returns a summary dict ({"migrated": [...], "skipped": [...],
    "failed": [...], "orphaned_files": [...]}) — main.py logs this at
    startup; scripts/migrate_category_icons.py's own __main__ block prints
    it for a manual run."""
    summary = {"migrated": [], "skipped": [], "failed": [], "orphaned_files": []}

    con = sqlite3.connect(DB_PATH)
    try:
        ensure_icon_columns(con)
        cur = con.cursor()
        cur.execute("SELECT url, icon FROM categories")
        rows = cur.fetchall()

        referenced_paths: set[str] = set()
        for url, icon_path in rows:
            if not icon_path:
                summary["skipped"].append({"url": url, "reason": "no icon path set"})
                continue
            referenced_paths.add(icon_path)

            resolved = (REPO_ROOT / icon_path).resolve()
            try:
                # Defends against icon_path escaping api/static/img via
                # "..", the same class of check as any other
                # user/admin-influenced filesystem path in this codebase —
                # icon_path came from the admin-typed legacy text field, not
                # a trusted constant.
                resolved.relative_to(STATIC_IMG_DIR.resolve())
            except ValueError:
                summary["failed"].append({
                    "url": url, "path": icon_path,
                    "reason": "resolves outside api/static/img — refusing to read",
                })
                logger.error("Category %s: icon path %r resolves outside api/static/img", url, icon_path)
                continue

            if not resolved.is_file():
                summary["failed"].append({"url": url, "path": icon_path, "reason": "file not found on disk"})
                logger.error("Category %s: icon file %r not found on disk", url, icon_path)
                continue

            content_type = _content_type_for(resolved)
            if content_type is None:
                summary["failed"].append({
                    "url": url, "path": icon_path,
                    "reason": f"unrecognized/unsupported extension for {resolved.name}",
                })
                logger.error("Category %s: icon file %r has an unsupported type for migration", url, icon_path)
                continue

            data = resolved.read_bytes()
            try:
                validate_icon_upload(content_type, data)
            except ValueError as e:
                summary["failed"].append({"url": url, "path": icon_path, "reason": str(e)})
                logger.error("Category %s: icon file %r failed validation: %s", url, icon_path, e)
                continue

            cur.execute(
                "UPDATE categories SET icon_data = ?, icon_content_type = ?, icon_updated_at = ? WHERE url = ?",
                (data, content_type, datetime.now(timezone.utc).isoformat(), url),
            )
            summary["migrated"].append({"url": url, "path": icon_path, "bytes": len(data), "content_type": content_type})
            logger.info("Migrated icon for category %r from %s (%d bytes, %s)", url, icon_path, len(data), content_type)

        con.commit()

        # Orphan sweep: any file matching the real convention on disk that
        # no category row's `icon` column actually points to. Compares
        # against the *raw* icon column strings, not resolved paths — a
        # mismatch here (different formatting of an equivalent path) would
        # itself be worth surfacing as a mismatch, not silently normalized
        # away.
        if STATIC_IMG_DIR.is_dir():
            for candidate in sorted(STATIC_IMG_DIR.glob(CATEGORY_ICON_GLOB)):
                rel = f"api/static/img/{candidate.name}"
                if rel not in referenced_paths:
                    summary["orphaned_files"].append(rel)
                    logger.warning(
                        "Orphaned category icon file, not referenced by any category: %s"
                        " — left in place, no category row points to it; review manually.",
                        rel,
                    )
    finally:
        con.close()

    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = migrate_category_icons()
    print("Migrated:", result["migrated"])
    print("Skipped (no icon path set):", result["skipped"])
    print("Failed:", result["failed"])
    print("Orphaned files (no matching category):", result["orphaned_files"])
