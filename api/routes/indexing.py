from fastapi import APIRouter, HTTPException
import os
import sqlite3

from api.auth import is_authorized
from api.core.config import DB_PATH
from api.core.indexing_queue import enqueue_indexing_request, get_queue_status, request_cancel

indexingRouter = APIRouter()
USER = os.environ.get("USER", "")


def _get_dataset_path(dataset_id: int) -> str:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        cur = con.cursor()
        cur.execute("SELECT path FROM datasets WHERE id = ?", (dataset_id,))
        row = cur.fetchone()
    finally:
        con.close()
    if row is None:
        raise HTTPException(status_code=404, detail="That dataset no longer exists.")
    return row["path"]


@indexingRouter.post("/admin/datasets/{dataset_id}/reindex")
async def reindexDataset(dataset_id: int):
    # Same auth gate as every other /admin/* route in api/routes/database.py
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    path = _get_dataset_path(dataset_id)
    enqueue_indexing_request(dataset_id, path, USER)
    return {"status": "queued"}


@indexingRouter.get("/admin/datasets/{dataset_id}/index-status")
async def datasetIndexStatus(dataset_id: int):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    return get_queue_status(dataset_id)


@indexingRouter.post("/admin/datasets/{dataset_id}/cancel-index")
async def cancelIndexDataset(dataset_id: int):
    # Same auth gate as every other /admin/* route in api/routes/database.py
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    # request_cancel only sets the flag when dataset_id is truly the
    # current in-progress entry (see its own docstring) — a False here
    # means there's nothing running to cancel (already finished, or was
    # never started), which is a real error to report rather than a
    # silent no-op 200, since the frontend only shows this button for a
    # dataset it believes is in_progress and a stale/racing click deserves
    # an honest answer.
    if not request_cancel(dataset_id):
        raise HTTPException(status_code=409, detail="This dataset isn't currently being indexed.")
    return {"status": "cancel_requested"}
