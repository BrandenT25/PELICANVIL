from fastapi import APIRouter
import json, os
from pathlib import Path
import sqlite3 
from api.core.config import DB_PATH

ROOTPATH = Path.cwd()
DATASET_PATH = os.path.join(ROOTPATH, "data", "datasets.json")
CATEGORY_PATH = os.path.join(ROOTPATH, "data", "categories.json")
datasetRouter = APIRouter()

def _indexed_sizes_by_path() -> dict:
    """dataset.path -> total size in bytes, from the indexing worker's
    dataset_folder_sizes table — a dataset's own row (folder_path == its own
    root path) already *is* the recursive total, see
    scripts/indexing_worker.py's _finalize_folder_sizes. Table may not exist
    yet on a fresh deployment (created lazily on the worker's first
    successful run) — that's not an error, just "nothing indexed yet"."""
    try:
        con = sqlite3.connect(DB_PATH)
        try:
            cur = con.cursor()
            cur.execute("SELECT folder_path, size_bytes FROM dataset_folder_sizes")
            return dict(cur.fetchall())
        finally:
            con.close()
    except sqlite3.OperationalError:
        return {}


@datasetRouter.get("/retrieve-datasets")
async def serveDatasets():
    result = []
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute('SELECT * FROM datasets')
    rows = cur.fetchall()
    con.close()
    indexed_sizes = _indexed_sizes_by_path()
    for row in rows:
        current_row = {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "path": row["path"],
            "format": row["format"],
            "streamable": bool(row["streamable"]),
            "access": row["access"],
            "tags" : json.loads(row["tags"]),
            "indexed_size_bytes": indexed_sizes.get(row["path"].rstrip("/")),
        }
        result.append(current_row)
    return result

def buildCatalog():
    """
    Shared by /datasets/catalog and the homepage overview section — both need
    the same dataset_count / category_count / category_names derived from the
    same tag<->category.url matching, so this is the one place that logic lives.
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute('SELECT * FROM datasets')
    dataset_rows = cur.fetchall()
    cur.execute('SELECT * FROM categories')
    category_rows = cur.fetchall()
    con.close()

    # tags aren't a foreign key — a dataset's category membership is whichever
    # of its freeform tags happens to match a categories.url, same lookup
    # datasets.js already does client-side for the per-category pages
    category_name_by_url = {row["url"]: row["name"] for row in category_rows}

    catalog = []
    category_names_used = set()
    for row in dataset_rows:
        tags = json.loads(row["tags"])
        matched_categories = [category_name_by_url[tag] for tag in tags if tag in category_name_by_url]
        category_names_used.update(matched_categories)
        catalog.append({
            "id": row["id"],
            "name": row["name"],
            "path": row["path"],
            "categories": matched_categories,
        })

    return {
        "dataset_count": len(catalog),
        "category_count": len(category_names_used),
        "category_names": sorted(category_names_used),
        "datasets": catalog,
    }

@datasetRouter.get("/datasets/catalog")
async def serveCatalog():
    return buildCatalog()

@datasetRouter.get("/retrieve-categories")
async def serveCategories():
    result = []
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute('SELECT * FROM categories')
    rows = cur.fetchall()
    con.close()
    for row in rows:
        current_row = {
            "name": row["name"],
            "url": row["url"],
            "icon": row["icon"],
            "description": row["description"],
        }
        result.append(row)
    return result
    





