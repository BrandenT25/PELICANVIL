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
# Reusing pelican.py's own filesystem-resolution and auth-failure detection
# rather than re-implementing it here — see the 2026-08-01 investigation
# that found .ls() raises aiowebdav2's UnauthorizedError/AccessDeniedError,
# not aiohttp's, and fixed _is_auth_required to match. Any future fix to
# that logic (e.g. a similar gap found for a different pelicanfs code path)
# lands in one place and this worker gets it for free.
from api.routes.pelican import _resolve_filesystem, _is_auth_required

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


def _index_dataset(entry: dict) -> tuple[dict[str, int], int]:
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

    Returns (folder_path -> total_size_bytes, folders_visited_count).
    """
    fs = _resolve_filesystem(entry["path"])
    folder_sizes: dict[str, int] = {}
    folders_visited = 0

    def walk(path: str) -> int:
        nonlocal folders_visited
        total = 0
        for item in fs.ls(path):
            if item["type"] == "directory":
                total += walk(item["name"])
            else:
                total += item.get("size") or 0
        folder_sizes[path.rstrip("/")] = total
        folders_visited += 1
        update_progress(entry["dataset_id"], folders_visited)
        return total

    walk(entry["path"])
    return folder_sizes, folders_visited


def _write_folder_sizes(dataset_id: int, folder_sizes: dict[str, int]) -> None:
    """The one write to the catalog db for the whole job — deliberately a
    single transaction at the end, not incremental writes during the walk,
    to minimize contention with the catalog db's other occasional writers
    (the per-user admin CRUD panel, api/routes/database.py). The dataset's
    own total is just the row for its own root path — there's no separate
    "total" column, since Phase 0 found the requirement is genuinely
    per-folder data, and the root-path row already *is* the total.
    """
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        cur.execute(
            """CREATE TABLE IF NOT EXISTS dataset_folder_sizes (
                dataset_id INTEGER NOT NULL,
                folder_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                indexed_at TEXT NOT NULL,
                PRIMARY KEY (dataset_id, folder_path)
            )"""
        )
        cur.execute("DELETE FROM dataset_folder_sizes WHERE dataset_id = ?", (dataset_id,))
        cur.executemany(
            "INSERT INTO dataset_folder_sizes (dataset_id, folder_path, size_bytes, indexed_at) VALUES (?, ?, ?, ?)",
            [(dataset_id, path, size, now) for path, size in folder_sizes.items()],
        )
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
            folder_sizes, folders_visited = _index_dataset(entry)
            _write_folder_sizes(entry["dataset_id"], folder_sizes)
            mark_complete(entry["dataset_id"], folders_visited)
            logger.info("Completed dataset_id=%s (%d folders)", entry["dataset_id"], folders_visited)
        except Exception as e:
            if _is_auth_required(e):
                message = f'"{entry["path"]}" requires an access token and none is stored for it.'
            else:
                message = str(e) or type(e).__name__
            logger.exception("Indexing failed for dataset_id=%s", entry["dataset_id"])
            mark_failed(entry["dataset_id"], message)
            # No re-raise: a failed job must not take the worker process down
            # with it — the loop goes back to idling and stays able to pick
            # up the next queued entry, per Phase 1's failure-handling spec.


if __name__ == "__main__":
    main()
