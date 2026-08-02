from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sqlite3, os, json, logging
from api.auth import is_authorized
from api.core.config import DB_PATH
from api.core.indexing_queue import enqueue_indexing_request

logger = logging.getLogger("pelican-ui.admin")

USER = os.environ.get("USER", "")

dbRouter = APIRouter()

class DatasetCreate(BaseModel):
    name : str
    description: str
    path: str
    format: str
    streamable: bool
    access: str
    tags: list[str]

class CategoryCreate(BaseModel):
    name: str
    url: str
    icon: str
    description: str

@dbRouter.post("/admin/add-dataset")
async def addDataset(dataset: DatasetCreate):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        new_id = None
        try:
            cur.execute(
                'INSERT INTO datasets (name, description, path, format, streamable, access, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (
                    dataset.name,
                    dataset.description,
                    dataset.path,
                    dataset.format,
                    int(dataset.streamable),
                    dataset.access,
                    json.dumps(dataset.tags)
                )
            )
            con.commit()
            new_id = cur.lastrowid
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f'A dataset with the path "{dataset.path}" already exists.')
    except HTTPException:
        raise
    except Exception:
        logger.exception("addDataset failed")
        raise HTTPException(status_code=500, detail="Save failed. Check server logs.")
    finally:
        con.close()
    # Automatic indexing trigger — new datasets get sized without a separate
    # manual step. Best-effort: a queue-file hiccup here shouldn't fail the
    # dataset creation itself, since the dataset row is already committed.
    try:
        enqueue_indexing_request(new_id, dataset.path, USER)
    except Exception:
        logger.exception("Failed to auto-enqueue indexing for new dataset %s", new_id)
    return {"status": "success", "name": dataset.name}

@dbRouter.post("/admin/remove-dataset")
async def removeDataset(dataset_id: int):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        cur.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))
        con.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="That dataset no longer exists.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("removeDataset failed")
        raise HTTPException(status_code=500, detail="Delete failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success"}

@dbRouter.post("/admin/modify-dataset")
async def modifyDataset(dataset_id: int, dataset: DatasetCreate):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        try:
            cur.execute("UPDATE datasets SET name = ?, description = ?, path = ?, format = ?, streamable = ?, access = ?, tags = ? WHERE id = ?",
                (
                    dataset.name,
                    dataset.description,
                    dataset.path,
                    dataset.format,
                    int(dataset.streamable),
                    dataset.access,
                    json.dumps(dataset.tags),
                    dataset_id,
                )
            )
            con.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f'A dataset with the path "{dataset.path}" already exists.')
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="That dataset no longer exists.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("modifyDataset failed")
        raise HTTPException(status_code=500, detail="Save failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success", "name": dataset.name}

@dbRouter.post("/admin/add-category")
async def addCategory(category: CategoryCreate):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        try:
            cur.execute(
                'INSERT INTO categories (name, url, icon, description) VALUES (?, ?, ?, ?)',
                (
                    category.name,
                    category.url,
                    category.icon,
                    category.description,
                )
            )
            con.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f'A category with the name "{category.name}" or URL slug "{category.url}" already exists.')
    except HTTPException:
        raise
    except Exception:
        logger.exception("addCategory failed")
        raise HTTPException(status_code=500, detail="Save failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success", "name": category.name}

@dbRouter.post("/admin/remove-category")
async def removeCategory(category_url: str):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        cur.execute("DELETE FROM categories WHERE url = ?", (category_url,))
        con.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="That category no longer exists.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("removeCategory failed")
        raise HTTPException(status_code=500, detail="Delete failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success"}


@dbRouter.post("/admin/modify-category")
async def modifyCategory(category_url: str, category: CategoryCreate):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        try:
            cur.execute("UPDATE categories SET name = ?, description = ?, url = ?, icon = ? WHERE url = ?",
                (
                    category.name,
                    category.description,
                    category.url,
                    category.icon,
                    category_url
                )
            )
            con.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f'A category with the name "{category.name}" or URL slug "{category.url}" already exists.')
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="That category no longer exists.")
    except HTTPException:
        raise
    except Exception:
        logger.exception("modifyCategory failed")
        raise HTTPException(status_code=500, detail="Save failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success", "name": category.name}

@dbRouter.post("/admin/add-user")
async def addUser(user: str):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    cleaned = user.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Username can't be empty.")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        try:
            cur.execute("INSERT INTO authorizedUsers (name) VALUES (?)", (cleaned,))
            con.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail=f'"{cleaned}" is already an authorized user.')
    except HTTPException:
        raise
    except Exception:
        logger.exception("addUser failed")
        raise HTTPException(status_code=500, detail="Save failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success", "name": cleaned}

@dbRouter.post("/admin/remove-user")
async def removeUser(user: str):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        cur.execute("DELETE FROM authorizedUsers WHERE name = ?", (user,))
        con.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail=f'"{user}" was not an authorized user.')
    except HTTPException:
        raise
    except Exception:
        logger.exception("removeUser failed")
        raise HTTPException(status_code=500, detail="Delete failed. Check server logs.")
    finally:
        con.close()
    return {"status": "success"}

@dbRouter.get("/admin/retrieve-users")
async def fetchUsers():
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    result = []
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("SELECT * FROM authorizedUsers")
    rows = cur.fetchall()
    for row in rows:
        current_row = {
            "name": row["name"]
        }
        result.append(current_row)
    con.close()
    return result
