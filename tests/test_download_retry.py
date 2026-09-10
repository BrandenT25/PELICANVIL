"""GitHub issue #6, Part 1: unit-level coverage for download_one_file's
connection-class retry loop (api/routes/pelican.py's _with_connection_retry).

No existing tests/ directory existed before this file — added specifically
to guard against the exact misclassification bug the indexing worker's own
retry loop once had (an unclassified exception wrongly routed into a retry
meant only for connection-class failures). Run with:

    python -m unittest tests/test_download_retry.py -v

Mocks _resolve_filesystem and time.sleep so this runs instantly and offline
— it exercises the retry/backoff/reset control flow itself, not a real
Pelican/OSDF connection.
"""
import time
import unittest
from unittest.mock import MagicMock, patch

import aiohttp

from api.routes import pelican as pelican_module
from api.routes.pelican import DOWNLOAD_RETRY_BACKOFFS, DownloadError, download_one_file


def _connection_error():
    # Same exception type _is_connection_error/classify_failure classify as
    # "connection" — see api/core/failure_classification.py.
    return aiohttp.ClientConnectionError("simulated dead pooled connection")


class WithConnectionRetryTests(unittest.TestCase):
    def setUp(self):
        # Never actually sleep in tests, and count resets without touching
        # the real module-level `osdf` singleton.
        self.sleep_patcher = patch.object(time, "sleep")
        self.mock_sleep = self.sleep_patcher.start()
        self.addCleanup(self.sleep_patcher.stop)

        self.reset_patcher = patch.object(pelican_module, "reset_default_filesystem")
        self.mock_reset = self.reset_patcher.start()
        self.addCleanup(self.reset_patcher.stop)

    def test_connection_class_failure_retries_then_succeeds(self):
        # Fails with a connection-class exception on the first two attempts,
        # succeeds on the third (the last attempt this schedule allows).
        fn = MagicMock(side_effect=[_connection_error(), _connection_error(), "ok"])

        result = pelican_module._with_connection_retry("test call", fn)

        self.assertEqual(result, "ok")
        self.assertEqual(fn.call_count, 3)
        self.assertEqual(self.mock_reset.call_count, 2)
        self.mock_sleep.assert_any_call(DOWNLOAD_RETRY_BACKOFFS[0])
        self.mock_sleep.assert_any_call(DOWNLOAD_RETRY_BACKOFFS[1])

    def test_connection_class_failure_exhausts_retries_and_raises(self):
        # Fails with a connection-class exception on every attempt —
        # confirms it gives up after exactly len(DOWNLOAD_RETRY_BACKOFFS) + 1
        # tries rather than retrying forever.
        fn = MagicMock(side_effect=[_connection_error() for _ in range(10)])

        with self.assertRaises(aiohttp.ClientConnectionError):
            pelican_module._with_connection_retry("test call", fn)

        self.assertEqual(fn.call_count, len(DOWNLOAD_RETRY_BACKOFFS) + 1)

    def test_data_class_failure_is_not_retried(self):
        # The misclassification guard: a data-class exception (here,
        # not_found) must propagate on the very first attempt, unretried —
        # retrying a genuine 404 wouldn't fix it, just delay reporting it.
        fn = MagicMock(side_effect=FileNotFoundError("genuinely does not exist"))

        with self.assertRaises(FileNotFoundError):
            pelican_module._with_connection_retry("test call", fn)

        self.assertEqual(fn.call_count, 1)
        self.mock_reset.assert_not_called()
        self.mock_sleep.assert_not_called()


class DownloadOneFileIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.sleep_patcher = patch.object(time, "sleep")
        self.addCleanup(self.sleep_patcher.stop)
        self.sleep_patcher.start()

        self.reset_patcher = patch.object(pelican_module, "reset_default_filesystem")
        self.addCleanup(self.reset_patcher.stop)
        self.reset_patcher.start()

    def test_download_one_file_recovers_from_transient_connection_blip(self):
        # isdir() fails once with a connection-class error, then succeeds;
        # the eventual fs.get() succeeds outright. Whole call should
        # transparently succeed with no DownloadError raised.
        fake_fs = MagicMock()
        fake_fs.isdir.side_effect = [_connection_error(), False]
        fake_fs.get.return_value = None

        with patch.object(pelican_module, "_resolve_filesystem", return_value=fake_fs) as mock_resolve:
            download_one_file("/namespace/some/file.txt", "/tmp/dest")

        self.assertEqual(fake_fs.isdir.call_count, 2)
        fake_fs.get.assert_called_once()
        self.assertGreaterEqual(mock_resolve.call_count, 2)

    def test_download_one_file_does_not_retry_a_real_404(self):
        # isdir() itself succeeds (returns False -> not a directory), then
        # fs.get() raises FileNotFoundError — a genuine not_found, not a
        # connection blip. Must fail immediately as DownloadError(code=
        # "not_found"), with fs.get() attempted exactly once.
        fake_fs = MagicMock()
        fake_fs.isdir.return_value = False
        fake_fs.get.side_effect = FileNotFoundError("no such path on the federation")

        with patch.object(pelican_module, "_resolve_filesystem", return_value=fake_fs):
            with self.assertRaises(DownloadError) as ctx:
                download_one_file("/namespace/missing/file.txt", "/tmp/dest")

        self.assertEqual(ctx.exception.category, "not_found")
        self.assertEqual(fake_fs.get.call_count, 1)


if __name__ == "__main__":
    unittest.main()
