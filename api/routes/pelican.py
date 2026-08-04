from fastapi import APIRouter, HTTPException
from pelicanfs import OSDFFileSystem
from pelicanfs.exceptions import NoCredentialsException
from aiowebdav2.exceptions import UnauthorizedError, AccessDeniedError, NoConnectionError, ConnectionExceptionError
import aiohttp
import asyncio
import fsspec, os, json, shutil, logging, sqlite3
from pathlib import Path
from collections import defaultdict
from api.core.config import DB_PATH
from api.core.pelican_auth import get_token_for_namespace, log_unexpected_pelican_error
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


# Genuine network/session failures — as opposed to a data-class exception
# like RemoteResourceNotFoundError, where the origin is reachable and
# correctly reporting the path doesn't exist. See _is_connection_error's
# own docstring for why each of these is included.
_CONNECTION_ERROR_TYPES = (
    NoConnectionError,
    ConnectionExceptionError,
    aiohttp.ClientConnectionError,
    TimeoutError,
    asyncio.CancelledError,
)


def _is_connection_error(exc: BaseException) -> bool:
    """True if exc represents a genuine connection/session-level failure —
    the kind scripts/indexing_worker.py's reactive safeguard should reset
    the filesystem singleton and retry for — rather than a data-class
    failure (a real 404, an auth requirement, a genuine server error
    response) that a reset can't fix and shouldn't delay handling.

    NoConnectionError: aiowebdav2's own wrapper around aiohttp's
    ClientConnectionError, raised by execute_request() when the underlying
    .request() call itself fails (see aiowebdav2/client.py) — covers
    ClientConnectorError, ServerTimeoutError, ConnectionTimeoutError,
    ServerDisconnectedError, etc. by inheritance, so catching the aiohttp
    base class below is partly redundant with this, but .ls() calls go
    through aiowebdav2, which re-wraps these before pelican-ui's code ever
    sees them — keeping both covers whichever layer a given pelicanfs call
    path happens to surface the exception from.
    ConnectionExceptionError: aiowebdav2's wrapper around an unexpected
    aiohttp.ClientResponseError raised directly from the request call
    itself (not a normal status-code response) — same network-failure
    shape as NoConnectionError, just a different aiowebdav2 wrapper.
    aiohttp.ClientConnectionError: the direct aiohttp exception, for any
    call path that isn't routed through aiowebdav2's wrapping (e.g. if a
    future call site uses .get()/download instead of .ls()).
    TimeoutError: covers both Python's builtin TimeoutError (which
    asyncio.TimeoutError is an alias for since 3.11, and which fsspec's own
    FSTimeoutError subclasses) and aiohttp's ServerTimeoutError/
    ConnectionTimeoutError (both already covered above via
    ClientConnectionError, included again here for the case where a
    timeout surfaces as a bare TimeoutError instead).
    asyncio.CancelledError: seen directly in the real failure logs' later,
    near-instant failures (aiohappyeyeballs' DNS/connect racing hitting
    CancelledError) — a BaseException, not an Exception, so it needs its
    own explicit inclusion; a caller checking this function needs to catch
    BaseException, not just Exception, to ever see one to classify.
    """
    return isinstance(exc, _CONNECTION_ERROR_TYPES)


def _is_auth_required(exc: Exception) -> bool:
    """True if exc means "this namespace needs a token" rather than some
    other failure (network issue, genuine 404/500, etc).

    pelicanfs doesn't use one HTTP layer consistently, so this has to cover
    both: `.get()` (download_one_file) goes through fsspec's HTTPFileSystem,
    a real aiohttp.ClientResponseError from raise_for_status(). `.ls()`
    (pelicanlistPath) goes through a *different* library entirely —
    aiowebdav2's WebDAV client — which maps 401/403 to its own
    UnauthorizedError/AccessDeniedError (see aiowebdav2/client.py's request
    method), never touching aiohttp.ClientResponseError at all. Confirmed by
    reading both installed packages' source, not assumed from docs — see
    2026-08-01 investigation notes. NoCredentialsException covers the third
    case: pelicanfs's own token-generation step finding no credential at all
    before any HTTP request goes out.
    """
    if isinstance(exc, NoCredentialsException):
        return True
    if isinstance(exc, (UnauthorizedError, AccessDeniedError)):
        return True
    return isinstance(exc, aiohttp.ClientResponseError) and exc.status in (401, 403)


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
    request to attach a status code to."""


class DownloadAuthRequiredError(DownloadError):
    """Same "needs a token" case as the 401 branch in pelicanlistPath below,
    just surfaced through DownloadError's channel since download_one_file
    runs on a background job thread with no request to attach a status code
    to (see downloads.py's _run_download_job, which reads .namespace off
    this to flag the failed file for the frontend's retry-with-token flow)."""

    def __init__(self, namespace: str):
        self.namespace = namespace
        super().__init__(f'"{namespace}" requires an access token.')


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
        fs.get(path, storage_location, recursive=True)
    except FileNotFoundError:
        raise DownloadError(f'"{filepath}" was not found on the federation.') from None
    except PermissionError:
        raise DownloadError(f"You don't have permission to write to {storage_location}.") from None
    except Exception as e:
        if _is_auth_required(e):
            raise DownloadAuthRequiredError(path) from None
        logger.exception("download_one_file failed for %s -> %s", filepath, storage_location)
        log_unexpected_pelican_error(path, e)
        raise DownloadError("Download failed. Check server logs.") from e


@pelicanRouter.get("/datasets/category/list-path")
def pelicanlistPath(path: str):
    fs = _resolve_filesystem(path)
    try:
        return _attach_folder_sizes(fs.ls(path))
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
