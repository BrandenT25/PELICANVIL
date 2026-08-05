import json
import os
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

_MAX_HISTORY = 20
_EMPTY_STATE = {"queue": [], "current": None, "history": []}


def _parse(raw: str) -> dict:
    if not raw.strip():
        return dict(_EMPTY_STATE)
    try:
        state = json.loads(raw)
    except json.JSONDecodeError:
        return dict(_EMPTY_STATE)
    state.setdefault("queue", [])
    state.setdefault("current", None)
    state.setdefault("history", [])
    return state


def _read_state() -> dict:
    path = Path(INDEXING_QUEUE_PATH)
    if not path.exists():
        return dict(_EMPTY_STATE)
    with open(path, "r", encoding="utf-8") as fh:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_SH)
        try:
            return _parse(fh.read())
        finally:
            if fcntl:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _with_state(mutator):
    """Opens INDEXING_QUEUE_PATH, takes an exclusive advisory lock for the
    duration, hands the current state to `mutator` (which returns
    (new_state, return_value)), writes the result back, and returns
    return_value. The one place read-modify-write happens, so every mutating
    function below — including concurrent enqueues from different PUN
    processes and the single worker's own claim/update/finish calls — gets
    the same locking guarantee for free instead of re-implementing it."""
    path = Path(INDEXING_QUEUE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    # "a+" creates the file if missing without truncating an existing one;
    # both read and write happen through this same handle while locked.
    with open(path, "a+", encoding="utf-8") as fh:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            fh.seek(0)
            state = _parse(fh.read())
            new_state, result = mutator(state)
            fh.seek(0)
            fh.truncate()
            json.dump(new_state, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
            return result
        finally:
            if fcntl:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


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
        state["history"].insert(0, current)
        state["history"] = state["history"][:_MAX_HISTORY]
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
            state["history"].insert(0, current)
            state["history"] = state["history"][:_MAX_HISTORY]
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

    for entry in state["history"]:
        if entry["dataset_id"] == dataset_id:
            return {
                "status": entry["status"],
                "finished_at": entry.get("finished_at"),
                "error_message": entry.get("error_message"),
                "error_category": entry.get("error_category"),
                "folders_done": entry.get("folders_done"),
            }

    return {"status": "never_indexed"}
