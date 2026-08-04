#!/usr/bin/env python3
"""
Standalone Slurm worker for admin-triggered dataset size indexing.

Deliberately NOT part of the FastAPI app's request/response cycle — RCAC
policy on Anvil's login nodes is job prep/submission/monitoring only, no
sustained background work, so this has to be a real Slurm job. And because
pelican-ui runs per-user via PUN, having each user's own process submit its
own Slurm job would hit the same "not every user is in the charged
allocation" problem already solved once for the project-folder picker — so
this script is submitted manually, once, by one identity, and keeps itself
alive across Anvil's 96-hour hard walltime cap by resubmitting itself near
the end of each cycle (see _maybe_resubmit_and_exit below) rather than a
human re-running it.

Usage on Anvil: `sbatch scripts/indexing_worker.sbatch` (see that file for
the #SBATCH resource header) starts the first cycle. This script assumes
it's already running inside an allocated job — it never calls sbatch for
its OWN first invocation, only to queue the next cycle.
"""
import asyncio
import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sqlite3

from api.core.config import DB_PATH
from api.core.indexing_queue import (
    claim_next_pending,
    mark_complete,
    mark_failed,
    recover_interrupted,
    update_progress,
)
# Reusing pelican.py's own filesystem-resolution rather than re-implementing
# it here. reset_default_filesystem is the connection-pressure safeguard
# from the 2026-08-04 investigation — see list_path() below for how it's
# used.
from api.routes.pelican import _resolve_filesystem, reset_default_filesystem
# _is_auth_required/_is_connection_error moved here from pelican.py in the
# 2026-08-04 failure-visibility work, alongside the new classify_failure
# that wraps both — see api/core/failure_classification.py's own docstring
# for why. log_unexpected_pelican_error is the same ~/.pelican-ui/last_error.log
# diagnostic api/routes/pelican.py's web-request handlers already write to;
# extending it to this worker's failure path (see main()) gives Branden the
# same no-Anvil-shell-access-needed diagnostic surface for indexing failures
# that already existed for web-request failures.
from api.core.failure_classification import _is_auth_required, _is_connection_error, classify_failure
from api.core.pelican_auth import log_unexpected_pelican_error

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("pelican-ui.indexing-worker")

IDLE_POLL_SECONDS = 5

# Comfortably under Anvil's 96-hour hard cap on the shared partition (see
# scripts/indexing_worker.sbatch's --time). The idle loop costs nothing
# significant, so there's no pressure to cut this closer — 24h just keeps
# the self-renewal cadence infrequent. Not a hard constraint; adjust freely.
WALLTIME_HOURS = 24
# How far before the walltime deadline to stop claiming new work and
# resubmit instead — must be comfortably longer than one indexing run can
# take (the prompt's own benchmark: ~20-40 min for a 500k-800k file
# dataset), so a job claimed just before the margin still has room to finish
# before Slurm kills this cycle.
RENEWAL_MARGIN_MINUTES = 60

SBATCH_SCRIPT = Path(__file__).resolve().parent / "indexing_worker.sbatch"

# Connection-pressure safeguards (2026-08-04 investigation): pelicanfs's own
# _ls_real creates a brand-new aiohttp.ClientSession per .ls() call and
# never reuses one across calls — third-party behavior this worker can't
# change without touching pelicanfs source (out of scope, see that
# investigation's report). Sustained over tens of thousands of calls in one
# continuous multi-hour process, this is consistent with the observed
# "healthy for hours, then a wall" pattern (TCP TIME_WAIT / ephemeral-port /
# file-descriptor pressure building until new connections can't be
# established). Two safeguards mitigate this entirely from pelican-ui's own
# code, without touching pelicanfs/aiowebdav2 — see list_path() in
# _index_dataset for where both are applied:
#   - proactive (PROACTIVE_RESET_CALLS): drop and recreate the shared
#     filesystem singleton every N .ls() calls, well before pressure has a
#     chance to build toward the failure point. The real failure log's
#     first healthy dataset made it 40,200 calls over 3+ hours before any
#     sign of trouble, and the *next* dataset — starting from a process
#     that already carried that accumulated pressure — failed after only
#     ~29 minutes, nowhere near that count on its own. That gap between
#     "still fine at 40,200" and "already struggling well before that on a
#     pressured process" is exactly why this threshold is deliberately an
#     order of magnitude under the first number, not tuned tight against
#     it — the real safe ceiling isn't known, and an unnecessary reset is
#     nearly free (recreating one filesystem object), while resetting too
#     late risks hitting the wall anyway. This is a starting point meant to
#     be adjusted from the real log data Phase 4's logging below produces,
#     not a final tuned value. Counts cumulatively across dataset
#     boundaries within one continuous worker process, not per-dataset —
#     matching how the real degradation compounded across datasets 3 and 4
#     in the same process, not within either one alone.
PROACTIVE_RESET_CALLS = 2000
# Backoff before the one reactive retry, giving a transient DNS/connect
# issue a moment to clear after the reset — same magnitude as
# IDLE_POLL_SECONDS below, not a value with its own special significance.
RETRY_BACKOFF_SECONDS = 5

# Running count of .ls() calls made on the *current* filesystem instance,
# since it was last (re)created — module-level and reset to 0 by either
# safeguard firing, not scoped to a single dataset's walk (see
# PROACTIVE_RESET_CALLS' comment on why this has to span dataset
# boundaries).
_ls_call_count = 0


_STAGING_BATCH_SIZE = 200
_STAGING_TABLE_SQL = """CREATE TABLE IF NOT EXISTS dataset_folder_sizes_staging (
    dataset_id INTEGER NOT NULL,
    folder_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    PRIMARY KEY (dataset_id, folder_path)
)"""


def _count_staged(dataset_id: int) -> int:
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute(_STAGING_TABLE_SQL)
        row = con.execute(
            "SELECT COUNT(*) FROM dataset_folder_sizes_staging WHERE dataset_id = ?", (dataset_id,)
        ).fetchone()
        return row[0]
    finally:
        con.close()


def _index_dataset(entry: dict) -> int:
    """Sequentially, recursively lists entry['path'] via pelicanfs, summing
    per-folder byte totals as it goes. Never issues concurrent listing calls
    — per the mentor directive driving this whole design ("we should not use
    Pelican servers for this kind of task" casually), this stays the least
    aggressive option: one namespace, one worker, one listing call in
    flight at a time, always.

    A directory's own `size` from pelicanfs is a meaningless fixed value
    (observed 4096 regardless of contents — there's no filesystem to `du`
    since this is federated, not local), so it's never used here; only file
    sizes and the recursively-computed subtotal of each directory are summed.

    Each completed folder is streamed to a `dataset_folder_sizes_staging`
    table (batched every _STAGING_BATCH_SIZE rows) instead of being kept in
    a path->size dict for the whole walk — that in-memory dict was the OOM
    source on deep datasets like GOES (hundreds of thousands of folders held
    for the entire multi-hour walk). The write buffer bounds memory to a
    fixed size regardless of total folders visited; only the current
    recursion's stack (bounded by directory depth) and the small buffer are
    ever held.

    Resumability: before listing a directory, checks the staging table (not
    memory) for a size already recorded there by a prior crashed run of this
    same dataset_id, and uses it instead of re-listing. walk() only writes a
    folder after all of its children are done (post-order), so a staged
    entry for a path guarantees that path's whole subtree already finished
    before the crash — safe to trust and skip.

    Returns folders_visited_count; per-folder sizes live in the staging
    table for _finalize_folder_sizes to pick up.
    """
    fs = _resolve_filesystem(entry["path"])
    dataset_id = entry["dataset_id"]
    con = sqlite3.connect(DB_PATH)
    con.execute(_STAGING_TABLE_SQL)
    folders_visited = 0
    buffer: list[tuple[int, str, int]] = []

    def flush() -> None:
        if not buffer:
            return
        con.executemany(
            "INSERT OR REPLACE INTO dataset_folder_sizes_staging (dataset_id, folder_path, size_bytes) VALUES (?, ?, ?)",
            buffer,
        )
        con.commit()
        buffer.clear()

    def staged_size(path: str) -> int | None:
        row = con.execute(
            "SELECT size_bytes FROM dataset_folder_sizes_staging WHERE dataset_id = ? AND folder_path = ?",
            (dataset_id, path.rstrip("/")),
        ).fetchone()
        return row[0] if row else None

    def list_path(path: str) -> list:
        """The one place this walk calls fs.ls() — wraps it with the
        connection-pressure safeguards (see the module-level comment above
        PROACTIVE_RESET_CALLS). Reassigns the enclosing fs (nonlocal) on a
        reset so every subsequent call in this walk — including the retry
        below — actually gets the benefit of the fresh instance, not the
        stale one that just got dropped.

        Catches BaseException, not Exception: asyncio.CancelledError (seen
        directly in the real failure logs) isn't an Exception subclass, so
        an `except Exception` here would silently let it skip the
        connection-class check entirely. Anything _is_connection_error
        doesn't recognize (a real 404, an auth requirement, a genuine
        KeyboardInterrupt/SystemExit) is re-raised immediately, unchanged
        from today's behavior — this only ever intercepts the specific
        connection-class types listed in api/routes/pelican.py.
        """
        nonlocal fs
        global _ls_call_count

        try:
            result = fs.ls(path)
        except BaseException as e:
            if not _is_connection_error(e):
                raise
            logger.warning(
                "Reactive filesystem reset for dataset_id=%s: %s after %d calls on this instance"
                " — resetting and retrying %r once",
                dataset_id, type(e).__name__, _ls_call_count, path,
            )
            reset_default_filesystem()
            _ls_call_count = 0
            fs = _resolve_filesystem(entry["path"])
            time.sleep(RETRY_BACKOFF_SECONDS)
            try:
                result = fs.ls(path)  # a second failure here propagates — no second retry
            except asyncio.CancelledError as e2:
                # CancelledError is a BaseException, not an Exception —
                # main()'s except Exception (and this task's own spec: fall
                # through to mark_failed if the retry also fails) needs a
                # real Exception to catch, or a second connection-class
                # failure here would crash the whole worker process instead
                # of just failing this one dataset. Re-raised as a plain
                # RuntimeError carrying the same message so mark_failed
                # still gets something meaningful to report.
                raise RuntimeError(f"{type(e2).__name__}: {e2}") from e2

        _ls_call_count += 1
        if _ls_call_count >= PROACTIVE_RESET_CALLS:
            logger.info(
                "Proactive filesystem reset for dataset_id=%s after %d .ls() calls (threshold=%d)",
                dataset_id, _ls_call_count, PROACTIVE_RESET_CALLS,
            )
            reset_default_filesystem()
            _ls_call_count = 0
            fs = _resolve_filesystem(entry["path"])

        return result

    def walk(path: str) -> int:
        nonlocal folders_visited
        cached = staged_size(path)
        if cached is not None:
            folders_visited += 1
            update_progress(dataset_id, folders_visited)
            return cached

        total = 0
        for item in list_path(path):
            if item["type"] == "directory":
                total += walk(item["name"])
            else:
                total += item.get("size") or 0
        folders_visited += 1
        buffer.append((dataset_id, path.rstrip("/"), total))
        if len(buffer) >= _STAGING_BATCH_SIZE:
            flush()
        update_progress(dataset_id, folders_visited)
        return total

    try:
        walk(entry["path"])
        flush()
    finally:
        con.close()

    return folders_visited


def _finalize_folder_sizes(dataset_id: int) -> None:
    """The one write to the *real* catalog table for the whole job —
    deliberately a single transaction at the end, copying the dataset's
    now-complete staged rows over and clearing staging, to minimize
    contention with the catalog db's other occasional writers (the per-user
    admin CRUD panel, api/routes/database.py). Everything that happened
    during the walk itself went to the separate staging table, not this one.
    The dataset's own total is just the row for its own root path — there's
    no separate "total" column, since Phase 0 found the requirement is
    genuinely per-folder data, and the root-path row already *is* the total.
    """
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute(
            """CREATE TABLE IF NOT EXISTS dataset_folder_sizes (
                dataset_id INTEGER NOT NULL,
                folder_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                indexed_at TEXT NOT NULL,
                PRIMARY KEY (dataset_id, folder_path)
            )"""
        )
        con.execute(_STAGING_TABLE_SQL)
        con.execute("DELETE FROM dataset_folder_sizes WHERE dataset_id = ?", (dataset_id,))
        con.execute(
            """INSERT INTO dataset_folder_sizes (dataset_id, folder_path, size_bytes, indexed_at)
               SELECT dataset_id, folder_path, size_bytes, ?
               FROM dataset_folder_sizes_staging WHERE dataset_id = ?""",
            (now, dataset_id),
        )
        con.execute("DELETE FROM dataset_folder_sizes_staging WHERE dataset_id = ?", (dataset_id,))
        con.commit()
    finally:
        con.close()


def _resubmit_self() -> None:
    # Matches api/routes/local.py's existing pattern for shelling out to a
    # Slurm/cluster command (subprocess.run with captured stdout/stderr,
    # universal_newlines, and a timeout) rather than inventing a new style.
    try:
        result = subprocess.run(
            ["sbatch", str(SBATCH_SCRIPT)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=30,
        )
        if result.returncode != 0:
            logger.error("sbatch resubmission failed (exit %s): %s", result.returncode, result.stderr.strip())
        else:
            logger.info("Resubmitted next worker cycle: %s", result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        logger.exception("Could not run sbatch to resubmit — the indexing chain stops here until resubmitted manually")


def main() -> None:
    recover_interrupted()
    deadline = time.monotonic() + WALLTIME_HOURS * 3600 - RENEWAL_MARGIN_MINUTES * 60
    logger.info("Indexing worker started, renewal margin %d min", RENEWAL_MARGIN_MINUTES)

    while True:
        if time.monotonic() >= deadline:
            logger.info("Approaching walltime limit — resubmitting and exiting")
            _resubmit_self()
            return

        entry = claim_next_pending()
        if entry is None:
            time.sleep(IDLE_POLL_SECONDS)
            continue

        logger.info("Indexing dataset_id=%s path=%s", entry["dataset_id"], entry["path"])
        try:
            folders_visited = _index_dataset(entry)
            _finalize_folder_sizes(entry["dataset_id"])
            mark_complete(entry["dataset_id"], folders_visited)
            logger.info("Completed dataset_id=%s (%d folders)", entry["dataset_id"], folders_visited)
        except Exception as e:
            if _is_auth_required(e):
                error_category = "auth_required"
                message = f'"{entry["path"]}" requires an access token and none is stored for it.'
            else:
                # classify_failure instead of the old bare str(e)/type(e).__name__
                # fallback — same honest-categories reasoning as
                # api/routes/pelican.py's download_one_file, so the admin
                # panel gets a consistent, classified reason instead of a
                # raw exception string that happened to differ in shape
                # from what the downloads/Quick Access surfaces show.
                category = classify_failure(e)
                error_category = category.code
                message = category.message
                if category.code == "unknown":
                    # Same "only log the genuinely surprising case" split as
                    # download_one_file — gives Branden the same
                    # no-Anvil-shell-access-needed diagnostic surface for
                    # indexing failures that already existed for web-request
                    # failures via this same log file.
                    log_unexpected_pelican_error(entry["path"], e)
            logger.exception("Indexing failed for dataset_id=%s", entry["dataset_id"])
            # Nothing is lost on a mid-walk crash: every folder finished so
            # far was already streamed to dataset_folder_sizes_staging (see
            # _index_dataset), not held in memory. Surface that here instead
            # of letting it sit as a silent mystery, and leave it in place —
            # the next claim of this dataset_id resumes from it rather than
            # re-walking from scratch.
            partial_count = _count_staged(entry["dataset_id"])
            if partial_count:
                message += (
                    f" ({partial_count} folders already indexed and saved to staging —"
                    " will resume from there on retry.)"
                )
                logger.info(
                    "Partial progress preserved for dataset_id=%s: %d folders staged",
                    entry["dataset_id"], partial_count,
                )
            mark_failed(entry["dataset_id"], message, folders_done=partial_count or None, error_category=error_category)
            # No re-raise: a failed job must not take the worker process down
            # with it — the loop goes back to idling and stays able to pick
            # up the next queued entry, per Phase 1's failure-handling spec.


if __name__ == "__main__":
    main()
