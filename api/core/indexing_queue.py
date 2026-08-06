import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from api.core.config import INDEXING_QUEUE_PATH

try:
    # Real advisory locking — always available on the actual Anvil/Linux
    # deployment target. Guarded because this module is imported both by the
    # FastAPI app (api/routes/indexing.py, hit from every PUN process) and by
    # local Windows dev, where fcntl doesn't exist at all; without this guard
    # the app couldn't even start locally. Without fcntl, reads/writes below
    # just skip locking — a real gap on that platform, acceptable only
    # because it isn't the deployment target.
    import fcntl
except ImportError:
    fcntl = None

logger = logging.getLogger("pelican-ui.indexing_queue")

# Anything under this is routine GPFS/lock jitter, not evidence of
# contention — update_progress() takes the _with_state path once per folder
# on a deep walk (hundreds of thousands of times on GOES-scale datasets), so
# the threshold has to comfortably clear normal noise or every healthy run
# would spam warnings. 5s is far above anything seen in healthy operation but
# well below the tens-of-minutes-to-an-hour stall the 2026-08-06 incident
# showed (worker silent for ~60 minutes with no indication of where it was
# stuck) — chosen so a *building* stall gets flagged early in the normal log
# stream, without needing DEBUG turned on ahead of time.
_SLOW_CALL_THRESHOLD_SECONDS = 5.0


def _log_if_slow(label: str, elapsed: float) -> None:
    """WARNING (always emitted, regardless of configured log level) the
    moment a single call crosses _SLOW_CALL_THRESHOLD_SECONDS; DEBUG
    otherwise — cheap and filtered out by default at normal log levels,
    since logger.debug's %-style args are never formatted unless DEBUG is
    actually enabled. The point: if a future stall happens, the log should
    show exactly which specific call was entered but never returned from,
    not just silence for an hour like 2026-08-06."""
    if elapsed >= _SLOW_CALL_THRESHOLD_SECONDS:
        logger.warning("%s took %.1fs — unusually slow, possible contention/stall", label, elapsed)
    else:
        logger.debug("%s took %.3fs", label, elapsed)


def _empty_state() -> dict:
    # A function, not a module-level dict constant that callers `dict(...)`-
    # copy: `dict(x)` is only a *shallow* copy, so every "fresh empty state"
    # would otherwise share the exact same `queue` list / `history` dict
    # objects by reference. The very first mutator to append/assign into
    # either of those (e.g. enqueue_indexing_request's `state["queue"].append`)
    # would then be mutating that shared object in place, permanently
    # poisoning every subsequent "fresh" empty state for the rest of the
    # process's life — including the corruption-recovery fallback below,
    # which would start silently resurrecting stale ghost entries instead of
    # actually being empty. Found via testing this file's corruption path
    # (2026-08-06): a prior enqueue's entry reappeared after simulating a
    # corrupt read, traced to exactly this.
    return {"queue": [], "current": None, "history": {}}

# Separate from INDEXING_QUEUE_PATH itself — see _with_state's docstring for
# why the lock has to live on a path whose identity never changes, distinct
# from the data file _atomic_write below swaps out from under it.
_LOCK_PATH = INDEXING_QUEUE_PATH + ".lock"


def _parse(raw: str) -> dict:
    """Raises json.JSONDecodeError on unparseable non-empty content —
    callers must handle that loudly (see _safe_parse), not silently. This
    used to swallow a bad parse into a silent _empty_state() here, which
    was the confirmed root cause of the 2026-08-06 incident: Slurm SIGTERM'd
    the worker (job 19689186) mid-write, right after it logged "Partial
    progress preserved for dataset_id=1" and immediately before the
    mark_failed() write that would have persisted that. The successor job's
    very first read silently adopted a pristine empty state, discarding
    every dataset's real history with no trace or log line. A non-empty file
    that fails to parse is corruption, not "never written yet."""
    if not raw.strip():
        return _empty_state()
    state = json.loads(raw)
    state.setdefault("queue", [])
    state.setdefault("current", None)
    history = state.get("history")
    if isinstance(history, list):
        # Migrating a pre-2026-08-06 queue file: history used to be a single
        # shared list capped at the last 20 finish events *across every
        # dataset*, which meant an old, real "complete" record for one
        # dataset silently disappeared the moment 20 other datasets (any
        # dataset, any status) finished after it — reported and confirmed
        # against real production evidence, see this file's per-dataset dict
        # below for the fix. Rebuilding a dict from the old list keeps
        # whatever's still there instead of discarding it outright: iterate
        # oldest-to-newest (the list itself is newest-first, see
        # _finish_current's insert(0, ...)) so each dataset ends up mapped to
        # its most recent surviving entry.
        rebuilt: dict[str, dict] = {}
        for entry in reversed(history):
            rebuilt[str(entry["dataset_id"])] = entry
        history = rebuilt
    state["history"] = history if isinstance(history, dict) else {}
    return state


def _recover_from_corruption(raw: str) -> dict:
    """Called when _parse can't make sense of on-disk content that isn't
    just empty. Backs up the unparseable bytes next to the real file
    (timestamped, never overwritten) so a human can inspect/hand-recover it,
    and logs loudly — replacing the previous silent discard that turned one
    interrupted write into an invisible full data-loss incident. There's no
    safe way to auto-recover a truncated/torn JSON write, so this still
    falls back to an empty state; the point is making that loss loud and
    recoverable-from-backup instead of silent."""
    backup_path = f"{INDEXING_QUEUE_PATH}.corrupt-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
    try:
        with open(backup_path, "w", encoding="utf-8") as bf:
            bf.write(raw)
    except OSError:
        logger.exception("Also failed to back up the corrupt queue file to %s", backup_path)
    logger.error(
        "Indexing queue file at %s is corrupt/unparseable (%d bytes) — backed up to %s and"
        " resetting to an empty state. This loses any queue/current/history data that hadn't"
        " been re-confirmed since; inspect the backup to recover anything salvageable.",
        INDEXING_QUEUE_PATH, len(raw), backup_path,
    )
    return _empty_state()


def _safe_parse(raw: str) -> dict:
    try:
        return _parse(raw)
    except json.JSONDecodeError:
        return _recover_from_corruption(raw)


def _read_state() -> dict:
    path = Path(INDEXING_QUEUE_PATH)
    if not path.exists():
        return _empty_state()
    read_start = time.monotonic()
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    _log_if_slow("Queue file read", time.monotonic() - read_start)
    # No lock needed here any more: _atomic_write below guarantees any
    # completed write is atomically visible as a whole (os.replace), so a
    # plain read is never able to observe a partial/torn write the way the
    # old in-place truncate()+write() allowed.
    return _safe_parse(raw)


def _atomic_write(path: Path, state: dict) -> None:
    """Writes to a same-directory temp file and os.replace()s it into place,
    replacing the previous in-place truncate()+write(). That in-place
    approach left a truncated/invalid file on disk for any reader unlucky
    enough to hit the window between truncate() and the write completing —
    exactly what a Slurm SIGTERM mid-write produced on 2026-08-06.
    os.replace() within the same filesystem is atomic: any reader sees
    either the complete old file or the complete new one, never a partial
    write, even if this process is killed at any point up to (and
    including) the replace() call itself. If it's killed before that, the
    orphaned temp file is simply never linked in — harmless, the real path
    is untouched."""
    write_start = time.monotonic()
    tmp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}-{time.monotonic_ns()}")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)
    _log_if_slow("Queue file atomic write", time.monotonic() - write_start)


def _with_state(mutator):
    """Takes an exclusive advisory lock on a dedicated lock file (_LOCK_PATH,
    not INDEXING_QUEUE_PATH itself) for the duration, reads the current
    state, hands it to `mutator` (which returns (new_state, return_value)),
    atomically writes the result back (see _atomic_write), and returns
    return_value. The one place read-modify-write happens, so every mutating
    function below — including concurrent enqueues from different PUN
    processes and the single worker's own claim/update/finish calls — gets
    the same locking guarantee for free instead of re-implementing it.

    The lock lives on a separate, never-replaced file rather than
    INDEXING_QUEUE_PATH itself: flock() locks are tied to the specific inode
    a file descriptor was opened against, not the path. Once _atomic_write
    starts os.replace()-ing new inodes onto INDEXING_QUEUE_PATH, a lock
    taken by opening that path directly would silently stop protecting
    anything the moment another writer's replace() swaps the inode out from
    under it. A lock file whose identity never changes sidesteps that
    entirely."""
    path = Path(INDEXING_QUEUE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(_LOCK_PATH, "a+", encoding="utf-8") as lock_fh:
        if fcntl:
            # fcntl.flock(LOCK_EX) blocks indefinitely by default — no
            # timeout, no LOCK_NB here — so if another holder never releases
            # it (a peer stuck on a GPFS-level stall of its own, say), this
            # call can hang forever with zero indication of where the
            # process actually is. This is the single most likely place the
            # 2026-08-06 ~60-minute silent stall was sitting; log it loudly
            # if it ever takes more than a few seconds again.
            lock_wait_start = time.monotonic()
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
            _log_if_slow("Queue file lock acquisition", time.monotonic() - lock_wait_start)
        try:
            state = _read_state()
            new_state, result = mutator(state)
            _atomic_write(path, new_state)
            return result
        finally:
            if fcntl:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)


def enqueue_indexing_request(dataset_id: int, path: str, requested_by: str) -> None:
    """Called from the admin-panel routes (api/routes/indexing.py), both for
    the automatic trigger on dataset creation and the manual re-index
    button."""

    def mutator(state):
        already_queued = any(e["dataset_id"] == dataset_id for e in state["queue"])
        already_current = state["current"] is not None and state["current"]["dataset_id"] == dataset_id
        if not already_queued and not already_current:
            state["queue"].append(
                {
                    "dataset_id": dataset_id,
                    "path": path,
                    "requested_at": datetime.now(timezone.utc).isoformat(),
                    "requested_by": requested_by,
                }
            )
        return state, None

    _with_state(mutator)


def claim_next_pending() -> dict | None:
    """Called only by the worker script. Atomically pops the oldest queued
    entry and marks it `current`/in-progress under the same lock, so an
    enqueue landing from a PUN process at the same moment can't race with
    the worker claiming a slot. Returns None if nothing is queued or a job
    is already current (single-worker design — see Phase 1's "exactly one
    worker, one in-flight job" scope)."""

    def mutator(state):
        if state["current"] is not None or not state["queue"]:
            return state, None
        entry = state["queue"].pop(0)
        entry["status"] = "in_progress"
        entry["started_at"] = datetime.now(timezone.utc).isoformat()
        entry["folders_done"] = 0
        state["current"] = entry
        return state, dict(entry)

    return _with_state(mutator)


def update_progress(dataset_id: int, folders_done: int) -> bool:
    """Called repeatedly by the worker while walking a dataset, so the admin
    panel's status poll can show live progress. Cheap, small write — this is
    distinct from the catalog db, which only gets written once at the end
    (see scripts/indexing_worker.py's _write_folder_sizes).

    Returns True if a cancel has been requested for this dataset (see
    request_cancel below) since the last check. Piggybacked onto this same
    read-modify-write rather than a separate file read every folder: this
    function is already called once per folder for progress reporting (see
    scripts/indexing_worker.py's walk()), already holds the lock, and
    already has `current` — the exact same entry the cancel flag lives on
    — in hand, so checking it here costs nothing extra and needs no new
    poll loop of its own, per this feature's own design constraint.
    """

    def mutator(state):
        current = state["current"]
        if current is not None and current["dataset_id"] == dataset_id:
            current["folders_done"] = folders_done
            return state, bool(current.get("cancel_requested"))
        return state, False

    return _with_state(mutator)


def request_cancel(dataset_id: int) -> bool:
    """Called from the admin panel's Cancel action (api/routes/indexing.py).
    Sets a flag on the `current` entry rather than a separate
    cancellation-requests list — there's only ever one `current` entry at a
    time in this single-worker design, so a flag on it is the more direct
    fit than a parallel list that would need its own cross-referencing.

    The worker notices this via update_progress's return value above, once
    per folder — not instantly, but within roughly one folder's worth of
    latency, which is the explicit design tradeoff this feature makes
    (rather than hard-interrupting a live network call) — see
    scripts/indexing_worker.py's IndexingCancelled for the rest of that
    reasoning.

    Returns True if a cancel was actually recorded (dataset_id was truly
    the current in-progress entry) so the route can give an honest 409
    instead of a queued-into-the-void 200 for a dataset that isn't
    actually running — mirrors claim_next_pending's same "return whether
    the state-changing part actually happened" shape.
    """

    def mutator(state):
        current = state["current"]
        if current is None or current["dataset_id"] != dataset_id:
            return state, False
        current["cancel_requested"] = True
        return state, True

    return _with_state(mutator)


def _finish_current(dataset_id: int, status: str, error_message: str | None, folders_done: int | None, error_category: str | None = None) -> None:
    def mutator(state):
        current = state["current"]
        if current is None or current["dataset_id"] != dataset_id:
            return state, None
        current["status"] = status
        current["finished_at"] = datetime.now(timezone.utc).isoformat()
        current["error_message"] = error_message
        current["error_category"] = error_category
        if folders_done is not None:
            current["folders_done"] = folders_done
        # Keyed by dataset_id (see _empty_state/_parse) — the *last* result
        # for this specific dataset, replacing any prior one. Deliberately
        # not a capped shared list any more: that design let an unrelated
        # dataset's finish event evict this dataset's own last-known status,
        # which is exactly the "successful index reverts to Not indexed"
        # regression this replaced.
        state["history"][str(dataset_id)] = current
        state["current"] = None
        return state, None

    _with_state(mutator)


def mark_complete(dataset_id: int, folders_done: int) -> None:
    _finish_current(dataset_id, "complete", None, folders_done)


def mark_failed(dataset_id: int, error_message: str, folders_done: int | None = None, error_category: str | None = None) -> None:
    # error_category is the FailureCategory.code from api/core/
    # failure_classification.py's classify_failure (2026-08-04) — lets the
    # admin panel show a consistent, classified reason next to "Index
    # failed" the same way the Downloads page does for failed files,
    # instead of a raw exception string with no machine-readable shape.
    _finish_current(dataset_id, "failed", error_message, folders_done, error_category)


def mark_cancelled(dataset_id: int, folders_done: int | None = None) -> None:
    # A distinct status ("cancelled"), not "failed" — this was a deliberate
    # admin action, not an error, and the admin panel/logs should read that
    # way rather than looking like a crash or a circuit-breaker trip (see
    # scripts/indexing_worker.py's IndexingCancelled).
    _finish_current(dataset_id, "cancelled", "Cancelled by an admin.", folders_done, "cancelled")


def recover_interrupted() -> None:
    """Called once by the worker on startup, before it enters its idle loop.

    If `current` is already non-empty at startup, the previous worker
    process died mid-job — killed, walltime ran out without a clean
    self-renewal handoff, node failure, etc. — without ever reaching
    mark_complete/mark_failed, so that entry would otherwise sit showing
    "in_progress" forever with nothing to correct it.

    There is deliberately no prior pattern in this codebase being reused
    here: api/routes/downloads.py's background download jobs have an
    in-process exception handler for a job that fails *while its own
    process/thread is still running*, but nothing that runs on the next
    process start to close out work left over from a previous one. This
    function is new, built specifically for this worker's restart-chain
    design (see Phase 1's self-resubmission via sbatch) — it follows the
    same never-leave-it-silently-stuck principle as that handler, just at a
    different point in the lifecycle (process start, not exception time).
    """

    def mutator(state):
        if state["current"] is not None:
            current = state["current"]
            current["status"] = "failed"
            current["finished_at"] = datetime.now(timezone.utc).isoformat()
            current["error_message"] = (
                "Worker restarted before this job finished; treat as failed and re-queue if still needed."
            )
            current["error_category"] = "worker_restarted"
            state["history"][str(current["dataset_id"])] = current
            state["current"] = None
        return state, None

    _with_state(mutator)


def get_queue_status(dataset_id: int) -> dict:
    """Read-only — used by GET /admin/datasets/{id}/index-status. Checked in
    order: currently running, queued, most recent history entry, else this
    dataset has never been indexed."""
    state = _read_state()

    if state["current"] is not None and state["current"]["dataset_id"] == dataset_id:
        entry = state["current"]
        return {
            "status": "in_progress",
            "folders_done": entry.get("folders_done", 0),
            "started_at": entry.get("started_at"),
        }

    for entry in state["queue"]:
        if entry["dataset_id"] == dataset_id:
            return {"status": "queued", "requested_at": entry.get("requested_at")}

    entry = state["history"].get(str(dataset_id))
    if entry is not None:
        return {
            "status": entry["status"],
            "finished_at": entry.get("finished_at"),
            "error_message": entry.get("error_message"),
            "error_category": entry.get("error_category"),
            "folders_done": entry.get("folders_done"),
        }

    return {"status": "never_indexed"}
