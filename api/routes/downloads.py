from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sqlite3, os, json, threading, uuid, logging
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from api.core.config import DOWNLOADS_DB_PATH
from api.routes.pelican import download_one_file, DownloadError

downloadsRouter = APIRouter()

logger = logging.getLogger("pelican-ui.downloads")

# Serializes all writes to downloads_history.db within this process. SQLite
# only ever allows one writer at a time regardless (readers can proceed
# concurrently under WAL, below) — this lock just avoids threads in this
# process fighting each other for that single writer slot and surfacing
# "database is locked" errors under normal load. It does NOT protect against
# a second OS process (e.g. if Passenger ever runs >1 worker process) writing
# at the same moment; cross-process safety instead relies on the busy_timeout
# set on every connection (see _get_connection), which makes SQLite retry for
# up to 10s instead of failing immediately if the file is locked elsewhere.
_db_write_lock = threading.Lock()

# Caps how many downloads run in the background at once. This is a single-
# user OOD sandbox app, each job already downloads its files sequentially
# internally, and Anvil's shared filesystem/network doesn't benefit from
# many large transfers hammering it in parallel — 3 lets a couple of batches
# overlap without thrashing, while still bounding worst-case resource use.
_job_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="download-job")

VALID_FINISH_STATUSES = ("complete", "partial", "failed")

# sentinel so _update_job can tell "leave error_message alone" apart from
# "set error_message to NULL" (a legitimate value on success)
_UNSET = object()


def _get_connection():
    os.makedirs(os.path.dirname(DOWNLOADS_DB_PATH), exist_ok=True)
    # timeout=10 makes sqlite3 retry for up to 10s (its busy_timeout) instead
    # of immediately raising "database is locked" if another connection —
    # in this process or, in theory, another one — is mid-write.
    con = sqlite3.connect(DOWNLOADS_DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    # WAL lets reads (e.g. the status-polling endpoint, the /downloads page)
    # proceed without blocking on an in-progress write from a job thread.
    con.execute("PRAGMA journal_mode=WAL")
    return con


def _init_db():
    con = _get_connection()
    cur = con.cursor()
    cur.execute(
        """CREATE TABLE IF NOT EXISTS download_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            destination TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'in_progress',
            item_count INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            error_message TEXT
        )"""
    )
    # files wasn't in the original schema — add it for rows created before
    # this column existed rather than requiring a fresh DB
    existing_columns = {row["name"] for row in cur.execute("PRAGMA table_info(download_history)")}
    if "files" not in existing_columns:
        cur.execute("ALTER TABLE download_history ADD COLUMN files TEXT")

    # download_jobs is the live/in-progress counterpart to download_history:
    # download_history is the finished/historical record (one row written on
    # start, updated once on completion); download_jobs is the row a running
    # background thread updates repeatedly as it works through a batch, and
    # what the status-polling endpoint reads from. A job's terminal state is
    # what gets copied into download_history's finish update.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS download_jobs (
            job_id TEXT PRIMARY KEY,
            history_id INTEGER,
            name TEXT NOT NULL,
            destination TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            item_count INTEGER NOT NULL DEFAULT 0,
            files TEXT,
            error_message TEXT,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    con.commit()
    con.close()


_init_db()


class DownloadJobStart(BaseModel):
    name: str
    destination: str
    paths: list[str]


def _create_history_record(name: str, destination: str, item_count: int) -> int:
    started_at = datetime.now(timezone.utc).isoformat()
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute(
            "INSERT INTO download_history (name, destination, status, item_count, started_at) VALUES (?, ?, 'in_progress', ?, ?)",
            (name, destination, item_count, started_at),
        )
        con.commit()
        new_id = cur.lastrowid
        con.close()
    return new_id


def _finish_history_record(record_id: int, status: str, error_message: str | None, files: list[dict] | None) -> None:
    finished_at = datetime.now(timezone.utc).isoformat()
    files_json = json.dumps(files) if files is not None else None
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute(
            "UPDATE download_history SET status = ?, finished_at = ?, error_message = ?, files = ? WHERE id = ?",
            (status, finished_at, error_message, files_json, record_id),
        )
        con.commit()
        con.close()


def _update_job(job_id: str, status: str | None = None, files: list[dict] | None = None, error_message=_UNSET) -> None:
    updates = ["updated_at = ?"]
    params = [datetime.now(timezone.utc).isoformat()]
    if status is not None:
        updates.append("status = ?")
        params.append(status)
    if files is not None:
        updates.append("files = ?")
        params.append(json.dumps(files))
    if error_message is not _UNSET:
        updates.append("error_message = ?")
        params.append(error_message)
    params.append(job_id)
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute(f"UPDATE download_jobs SET {', '.join(updates)} WHERE job_id = ?", params)
        con.commit()
        con.close()


def _run_download_job(job_id: str, history_id: int, destination: str, paths: list[str]) -> None:
    # Runs on a background thread from _job_executor — this function is what
    # actually replaces the old request-held-open behavior. It reuses
    # download_one_file (api/routes/pelican.py) unchanged; only where it's
    # invoked from has changed.
    _update_job(job_id, status="in_progress")

    files = [{"path": p, "status": "pending"} for p in paths]
    succeeded = []
    failed = []

    for i, path in enumerate(paths):
        try:
            download_one_file(path, destination)
            files[i]["status"] = "succeeded"
            succeeded.append(path)
        except DownloadError as e:
            files[i]["status"] = "failed"
            files[i]["error"] = str(e)
            failed.append(path)
        except Exception:
            # Belt-and-suspenders: download_one_file already wraps unexpected
            # exceptions in DownloadError, but a job thread that dies here
            # with an unhandled exception would leave this job (and its
            # history row) stuck in "in_progress" forever with nothing to
            # report why — worse than recording a generic failure and moving on.
            logger.exception("Unexpected error downloading %s for job %s", path, job_id)
            files[i]["status"] = "failed"
            files[i]["error"] = "Unexpected error. Check server logs."
            failed.append(path)
        _update_job(job_id, files=files)

    if not failed:
        final_status = "complete"
        error_message = None
    elif not succeeded:
        final_status = "failed"
        error_message = f"{len(failed)} of {len(paths)} item(s) failed to download."
    else:
        final_status = "partial"
        error_message = f"{len(failed)} of {len(paths)} item(s) failed to download."

    _update_job(job_id, status=final_status, files=files, error_message=error_message)

    history_files = [{"path": f["path"], "status": "succeeded" if f["status"] == "succeeded" else "failed"} for f in files]
    _finish_history_record(history_id, final_status, error_message, history_files)


def _enqueue_job(history_id: int, name: str, destination: str, paths: list[str]) -> str:
    # Shared by startDownloadJob and restartDownloadRecord below — both boil
    # down to "create a download_jobs row and hand the actual transfer off to
    # a background thread", they just differ in how the history_id/paths they
    # pass in were obtained. Submitting to the pool just enqueues the call and
    # returns immediately — the actual transfer work happens on whichever
    # worker thread picks it up, entirely off the request that called this.
    job_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    files = [{"path": p, "status": "pending"} for p in paths]
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute(
            "INSERT INTO download_jobs (job_id, history_id, name, destination, status, item_count, files, started_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
            (job_id, history_id, name, destination, len(paths), json.dumps(files), now, now),
        )
        con.commit()
        con.close()
    _job_executor.submit(_run_download_job, job_id, history_id, destination, paths)
    return job_id


@downloadsRouter.post("/datasets/download/start")
async def startDownloadJob(payload: DownloadJobStart):
    if not payload.paths:
        raise HTTPException(status_code=400, detail="Select at least one file or folder first.")

    history_id = _create_history_record(payload.name, payload.destination, len(payload.paths))
    job_id = _enqueue_job(history_id, payload.name, payload.destination, payload.paths)

    return {"job_id": job_id, "history_id": history_id, "status": "pending"}


@downloadsRouter.post("/downloads/history/{record_id}/restart")
async def restartDownloadRecord(record_id: int):
    # Retries only the files that actually failed last time, using the same
    # name/destination the original download used — reuses _enqueue_job and
    # _run_download_job unchanged, since the actual transfer logic doesn't
    # need to know or care whether this is a first attempt or a retry.
    #
    # What's genuinely different from startDownloadJob, and why this isn't
    # just a call to it: restarting is expected to update the *same* history
    # entry in place (status flips failed -> in_progress on the entry the
    # user clicked Restart on), not create a second entry while the failed
    # one lingers. startDownloadJob always inserts a fresh history row, so it
    # can't produce that in-place behavior — this endpoint resets the
    # existing row instead of inserting a new one.
    con = _get_connection()
    cur = con.cursor()
    cur.execute("SELECT * FROM download_history WHERE id = ?", (record_id,))
    row = cur.fetchone()
    con.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Download record not found.")
    if row["status"] != "failed":
        raise HTTPException(status_code=400, detail="Only failed downloads can be restarted.")

    files = json.loads(row["files"]) if row["files"] else []
    paths = [f["path"] for f in files if f.get("status") == "failed"]
    if not paths:
        raise HTTPException(status_code=400, detail="No failed files recorded for this download.")

    name = row["name"]
    destination = row["destination"]
    started_at = datetime.now(timezone.utc).isoformat()
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute(
            "UPDATE download_history SET status = 'in_progress', item_count = ?, started_at = ?, finished_at = NULL, error_message = NULL, files = NULL WHERE id = ?",
            (len(paths), started_at, record_id),
        )
        # the finished job row from the original attempt is still sitting
        # there pointed at this history_id — drop it before inserting the new
        # one so /downloads/history's LEFT JOIN doesn't pick up both and
        # duplicate this entry in the list
        cur.execute("DELETE FROM download_jobs WHERE history_id = ?", (record_id,))
        con.commit()
        con.close()

    job_id = _enqueue_job(record_id, name, destination, paths)

    return {"job_id": job_id, "history_id": record_id, "status": "in_progress"}


@downloadsRouter.get("/datasets/download/status/{job_id}")
async def getDownloadJobStatus(job_id: str):
    con = _get_connection()
    cur = con.cursor()
    cur.execute("SELECT * FROM download_jobs WHERE job_id = ?", (job_id,))
    row = cur.fetchone()
    con.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    entry = dict(row)
    entry["files"] = json.loads(entry["files"]) if entry.get("files") else []
    return entry


@downloadsRouter.get("/downloads/history")
async def listDownloadHistory():
    con = _get_connection()
    cur = con.cursor()
    # LEFT JOIN in job_id so the Downloads page can poll
    # /datasets/download/status/{job_id} for any row still in_progress to get
    # live per-file state (download_jobs tracks that; download_history.files
    # is only populated once a job reaches a terminal state).
    cur.execute(
        """SELECT h.*, j.job_id AS job_id
           FROM download_history h
           LEFT JOIN download_jobs j ON j.history_id = h.id
           ORDER BY h.started_at DESC"""
    )
    rows = cur.fetchall()
    con.close()
    result = []
    for row in rows:
        entry = dict(row)
        entry["files"] = json.loads(entry["files"]) if entry.get("files") else []
        result.append(entry)
    return result


@downloadsRouter.delete("/downloads/history/{record_id}")
async def deleteDownloadRecord(record_id: int):
    # Deleting an in_progress entry is allowed, not just terminal ones. The
    # background thread (_run_download_job) has no safe way to be cancelled
    # mid-transfer — Python doesn't support killing a thread from outside it
    # — so it keeps running to completion regardless. What matters is that it
    # stops being able to do anything visible once its row is gone: its job
    # row is deleted here too (not just the history row), so its remaining
    # _update_job/_finish_history_record calls become no-op UPDATEs (0 rows
    # matched, no error) instead of resurrecting a deleted entry, and the
    # status endpoint starts 404ing for that job_id — which the Downloads
    # page's poll loop already treats as "stop polling this card".
    with _db_write_lock:
        con = _get_connection()
        cur = con.cursor()
        cur.execute("DELETE FROM download_jobs WHERE history_id = ?", (record_id,))
        cur.execute("DELETE FROM download_history WHERE id = ?", (record_id,))
        deleted = cur.rowcount
        con.commit()
        con.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Download record not found.")
    return {"status": "success"}
