from fastapi import APIRouter, HTTPException
from pelicanfs import OSDFFileSystem
import fsspec, os, json, shutil, logging, sqlite3
from pathlib import Path
from urllib.parse import quote
from collections import defaultdict
from api.core.config import DB_PATH
from api.core.pelican_auth import get_token_for_namespace, log_unexpected_pelican_error
from api.core.failure_classification import _is_auth_required, classify_failure
osdf = OSDFFileSystem(direct_reads=False)

logger = logging.getLogger("pelican-ui.pelican")

pelicanRouter = APIRouter()
ROOTPATH = Path.cwd()
DATASET_PATH = os.path.join(ROOTPATH, "data", "datasets.json")
USER = os.environ.get("USER")
SCRATCH_PATH = os.path.join("/anvil", "scratch", USER)


def _resolve_filesystem(namespace: str) -> OSDFFileSystem:
    """Most calls reuse the shared module-level `osdf` instance (fine — it's
    unauthenticated). When a token has been saved for this namespace (see
    api/routes/token_auth.py), build a one-off instance carrying it instead:
    pelicanfs's own token discovery is a single global value and can't
    represent different tokens for different namespaces, and the shared
    `osdf` instance can't have its headers swapped per-call safely since
    requests against other namespaces may be in flight concurrently.
    """
    token = get_token_for_namespace(namespace)
    if token:
        return OSDFFileSystem(direct_reads=False, headers={"Authorization": f"Bearer {token}"})
    return osdf


def reset_default_filesystem() -> None:
    """Drops the shared module-level `osdf` singleton and replaces it with a
    fresh OSDFFileSystem, so the next _resolve_filesystem() call for any
    unauthenticated namespace gets a brand-new instance — and, transitively,
    whatever internal aiohttp session/connector/DNS-resolver state pelicanfs
    holds on the old one is dropped instead of carried forward.

    Written for scripts/indexing_worker.py's connection-pressure safeguards
    (see its PROACTIVE_RESET_CALLS / list_path) — a single-process, 24h+
    Slurm job making tens of thousands of sequential .ls() calls is the one
    caller shape actually exposed to the degrade-over-time failure found by
    the 2026-08-04 investigation (a brand-new aiohttp.ClientSession gets
    created per .ls() call inside pelicanfs's own get_webdav_client, never
    reused — third-party behavior, not something pelican-ui's call site can
    change without touching pelicanfs source, which is out of scope). The
    per-user PUN web process wasn't found to be meaningfully exposed to the
    same failure (see that investigation's Phase 5 conclusion — a request
    makes at most a handful of calls, nowhere near the volume needed, and
    Passenger's own process recycling is already a coarser version of the
    same mitigation) so nothing here is wired into pelicanlistPath or
    download_one_file; this function just lives here, next to osdf itself,
    since resetting it is squarely pelican.py's own responsibility.

    Safe to call at any time — it only affects *future* _resolve_filesystem()
    calls. A caller that already holds a reference to the old instance (e.g.
    mid-request) keeps using it uninterrupted; nothing here reaches into or
    cancels an in-flight call.
    """
    global osdf
    osdf = OSDFFileSystem(direct_reads=False)


def _encode_path_segment(path: str) -> str:
    """Percent-encodes a path's special characters (space, +, #, %, &, =,
    non-ASCII, etc.) while leaving '/' as a literal path separator —
    defensive pre-encoding for every fs.ls()/fs.get() call, not a
    general-purpose URL helper. Apply this right before the call, not
    earlier — everything else in this app (DB storage, staging tables,
    JSON responses, error messages, _resolve_filesystem's token lookup)
    keeps using the raw, human-readable path unchanged.

    Exists because of a real bug in aiowebdav2 (0.6.2), confirmed by
    reading its source (aiowebdav2/urn.py): Urn.__init__ correctly
    percent-encodes the path it's given (`self._path = quote(path)`), but
    Client.get_url() then calls Urn.path(), which unconditionally
    *unquotes* it again before building the actual request URL — the two
    cancel out, so every .ls() call currently sends the raw, unescaped
    path onto the wire regardless of what's passed in. Confirmed directly
    against the installed library:
        Urn('Measurement+1').path() == '/Measurement+1'   (unescaped!)
    This is the root cause of the 2026-08-04 bug report (a folder named
    "Measurement+1" 404ing while its "Measurement1" sibling worked) — the
    origin most likely received (or misinterpreted) a literal/ambiguous
    '+' instead of the folder's real name.

    Also verified directly that pre-encoding survives that exact
    round-trip intact — Urn's own quote()-then-unquote() only cancels ONE
    level, so a value already percent-encoded once when it enters Urn
    comes out the other side exactly as encoded:
        Urn(quote('Measurement+1')).path() == '/Measurement%2B1'  (correct)
    A path with no special characters is unaffected — quote()'s default
    safe set already covers every character a normal path needs.

    .get()/downloads don't go through aiowebdav2's Urn at all (a
    different pelicanfs code path — get_origin_url/get_working_cache,
    built with urllib.parse.urljoin, which never encodes OR decodes), so
    a raw special character reaches the wire unencoded there too, just
    via "never gets encoded in the first place" rather than a cancelling
    round-trip. Same fix, same call-site shape, applied at every place
    this app actually calls fs.ls()/fs.get(): here (download_one_file,
    pelicanlistPath) and scripts/indexing_worker.py's own fs.ls() call,
    which imports this function from here rather than duplicating it.

    Deliberately does not touch pelicanfs/aiowebdav2 source, matching the
    project's existing convention (see reset_default_filesystem above) —
    this encodes defensively at the boundary, in pelican-ui's own code,
    before a path ever reaches either library.
    """
    return quote(path, safe="/")


def _attach_folder_sizes(entries: list) -> list:
    """Annotates each directory entry in a .ls() result with real_size (an
    int, from the indexing worker's dataset_folder_sizes table) when known,
    else None. Keyed purely by path, not dataset id — quick-access.js's file
    browser has no dataset entity at all (just a pasted path), so a
    dataset-scoped lookup wouldn't work for it; this is the one place both
    datasets.js's and quick-access.js's file browsers get real folder sizes
    from, since both already call this same route.

    Batches into a single query rather than one per directory entry. Table
    may not exist yet on a fresh deployment (the worker creates it lazily on
    its first successful run, see scripts/indexing_worker.py) — that's not
    an error, it just means nothing is indexed yet, so every entry gets
    real_size: None.
    """
    dir_paths = [e["name"].rstrip("/") for e in entries if e.get("type") == "directory"]
    if not dir_paths:
        return entries

    sizes: dict[str, int] = {}
    try:
        con = sqlite3.connect(DB_PATH)
        try:
            placeholders = ",".join("?" * len(dir_paths))
            cur = con.cursor()
            cur.execute(
                f"SELECT folder_path, size_bytes FROM dataset_folder_sizes WHERE folder_path IN ({placeholders})",
                dir_paths,
            )
            sizes = dict(cur.fetchall())
        finally:
            con.close()
    except sqlite3.OperationalError:
        # table doesn't exist yet (nothing has ever finished indexing) —
        # every entry just stays real_size: None below, not an error
        pass

    for entry in entries:
        if entry.get("type") == "directory":
            entry["real_size"] = sizes.get(entry["name"].rstrip("/"))
    return entries


class DownloadError(Exception):
    """Raised by download_one_file instead of HTTPException. This is called
    from background job threads (api/routes/downloads.py), not just request
    handlers, and HTTPException only makes sense when there's an active
    request to attach a status code to.

    category carries the FailureCategory.code classify_failure produced
    (see below) — api/routes/downloads.py's _run_download_job stores this
    alongside the message on each failed file, so the frontend gets a
    stable machine-readable reason too, not just prose to display verbatim.
    Defaults to "unknown" for DownloadAuthRequiredError, which doesn't go
    through classify_failure (it's already unambiguous by construction).
    """

    def __init__(self, message: str, category: str = "unknown"):
        self.category = category
        super().__init__(message)


class DownloadAuthRequiredError(DownloadError):
    """Same "needs a token" case as the 401 branch in pelicanlistPath below,
    just surfaced through DownloadError's channel since download_one_file
    runs on a background job thread with no request to attach a status code
    to (see downloads.py's _run_download_job, which reads .namespace off
    this to flag the failed file for the frontend's retry-with-token flow)."""

    def __init__(self, namespace: str):
        self.namespace = namespace
        super().__init__(f'"{namespace}" requires an access token.', "auth_required")


def download_one_file(filepath: str, storage_location: str) -> None:
    # The actual transfer mechanism (fsspec/pelicanfs streaming 5MB chunks
    # straight to disk) is unchanged and correct. What used to be wrong was
    # invoking this synchronously inside a request handler: this app runs
    # under Passenger via a2wsgi (see passenger_wsgi.py), which pins one
    # worker for the full duration of whatever request it's handling — so a
    # large/slow transfer here held a worker (and, for the browser, a
    # connection) open for as long as the transfer took, long enough to hit
    # reverse-proxy timeouts. This function is now only ever called from a
    # background thread (api/routes/downloads.py's job worker), never from
    # directly inside a request handler.
    path = filepath.rstrip("/")
    fs = _resolve_filesystem(path)
    try:
        fs.get(_encode_path_segment(path), storage_location, recursive=True)
    except Exception as e:
        if _is_auth_required(e):
            raise DownloadAuthRequiredError(path) from None
        category = classify_failure(e)
        if category.code == "unknown":
            # Only the genuinely unclassified case gets logged loudly and
            # written to last_error.log — auth/not_found/permission/
            # connection are all already-understood, expected shapes of
            # failure with an honest message of their own; logging those as
            # if they were surprising would just be noise.
            logger.exception("download_one_file failed for %s -> %s", filepath, storage_location)
            log_unexpected_pelican_error(path, e)
        raise DownloadError(category.message, category.code) from (e if category.code == "unknown" else None)


@pelicanRouter.get("/datasets/category/list-path")
def pelicanlistPath(path: str):
    fs = _resolve_filesystem(path)
    try:
        return _attach_folder_sizes(fs.ls(_encode_path_segment(path)))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f'Path "{path}" was not found on the federation.')
    except Exception as e:
        if _is_auth_required(e):
            raise HTTPException(
                status_code=401,
                detail={
                    "error": "auth_required",
                    "namespace": path,
                    "message": f'"{path}" requires an access token.',
                },
            ) from None
        logger.exception("pelicanlistPath failed for %s", path)
        log_unexpected_pelican_error(path, e)
        raise HTTPException(status_code=502, detail="Couldn't reach the Pelican/OSDF federation. Try again.")


@pelicanRouter.get("datasets/")
def giveSize():
    return
