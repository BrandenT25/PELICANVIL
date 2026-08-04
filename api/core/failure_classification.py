"""Shared failure classification for every surface that talks to the
Pelican/OSDF federation: dataset-page downloads and Quick Access (both going
through api/routes/pelican.py's download_one_file, on the per-user PUN web
process) and the standalone Slurm indexing worker (scripts/indexing_worker.py,
a structurally separate long-lived process). One classify_failure() here is
the single place that turns a raised exception — from either aiohttp's
hierarchy (.get()/downloads) or aiowebdav2's (.ls()/listing, per the
2026-08-01 investigation that found it doesn't share aiohttp's exception
types) — into one honest, user-facing reason, so a researcher gets the same
kind of specific answer regardless of which of the three UI surfaces they
hit a failure on.

_is_auth_required and _is_connection_error used to live in
api/routes/pelican.py (the 2026-08-01 and 2026-08-04 investigations that
built them). Moved here, with pelican.py now importing them back, because
this module needs both to build classify_failure and pelican.py's own
download_one_file needs classify_failure — keeping them in pelican.py would
make this module import pelican.py while pelican.py imports this module,
a circular import. Neither function's body changed in the move.
"""
from dataclasses import dataclass

import aiohttp
import asyncio

from aiowebdav2.exceptions import (
    UnauthorizedError,
    AccessDeniedError,
    RemoteResourceNotFoundError,
    NoConnectionError,
    ConnectionExceptionError,
)
from pelicanfs.exceptions import NoCredentialsException


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
    call path that isn't routed through aiowebdav2's wrapping (e.g. a
    download's .get() call, which goes through aiohttp directly).
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


@dataclass(frozen=True)
class FailureCategory:
    """code is the machine-readable category (stable — safe to store, log,
    or branch UI behavior on); message is the honest, user-facing sentence.
    No fabricated specificity: `unknown`'s message is exactly what the
    exception itself says, same "don't invent precision the code doesn't
    have" principle already used for the indexing admin badge's real
    folders-scanned count rather than a guessed percentage."""

    code: str
    message: str


def classify_failure(exc: BaseException) -> FailureCategory:
    """The one place a raised exception becomes a user-facing reason,
    reused by dataset downloads, Quick Access, and the indexing worker
    alike. Order matters — checked most-specific-first:

    1. auth_required — reuses _is_auth_required above.
    2. not_found — the origin is reachable and correctly reporting the
       path doesn't exist (FileNotFoundError from the .get()/download
       path, RemoteResourceNotFoundError from the .ls()/listing path).
    3. permission — a local write failure (PermissionError), not a
       federation-side problem at all.
    4. connection — reuses _is_connection_error above; safe to suggest
       "try again" for, unlike the other categories.
    5. unknown — the honest catch-all. No guessed cause is better than a
       wrong one (see api/routes/pelican.py's prior "Check permissions on
       the destination" toast copy, which was shown even when the real
       cause wasn't permissions at all — exactly what this replaces).
    """
    if _is_auth_required(exc):
        return FailureCategory("auth_required", "This path requires an access token.")
    if isinstance(exc, (FileNotFoundError, RemoteResourceNotFoundError)):
        return FailureCategory("not_found", "This file or folder wasn't found on the federation.")
    if isinstance(exc, PermissionError):
        return FailureCategory("permission", "Permission denied writing to the destination.")
    if _is_connection_error(exc):
        return FailureCategory("connection", "Couldn't reach the federation — a temporary network issue. Try again.")
    message = str(exc) or type(exc).__name__
    return FailureCategory("unknown", message)
