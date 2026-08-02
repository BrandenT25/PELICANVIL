from fastapi import APIRouter, HTTPException
from pelicanfs import OSDFFileSystem
from pelicanfs.exceptions import NoCredentialsException
from aiowebdav2.exceptions import UnauthorizedError, AccessDeniedError
import aiohttp
import fsspec, os, json, shutil, logging
from pathlib import Path
from collections import defaultdict
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
        return fs.ls(path)
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
