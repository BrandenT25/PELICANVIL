/*
 * downloads.js — the /downloads history page. Fetches the local
 * downloads-history DB once on load (or on manual Refresh click, per the
 * "no live polling needed" scope) and renders it newest-first.
 */

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function formatTimestamp(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function truncateDecimals(number, digits) {
  const multiplier = Math.pow(10, digits);
  return Math.trunc(number * multiplier) / multiplier;
}

// Same helper as datasets.js/quick-access.js (matching this app's existing
// per-page duplication convention rather than sharing a module across
// pages) — decimal (1000-based) divisors, B/KB/MB/GB/TB/PB.
function formatBytes(bytes) {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  const rounded = unitIndex === 0 ? value : truncateDecimals(value, 1);
  return `${rounded}${BYTE_UNITS[unitIndex]}`;
}

/**
 * Same function as datasets.js/quick-access.js's computeDownloadProgress —
 * duplicated here rather than shared, matching this app's established
 * per-page JS duplication convention. Both places derive progress purely
 * from a job status's `files` array (the thing this page and the
 * initiating page's persistent toast both poll from
 * /datasets/download/status/{id}), so this row and that toast are two
 * views of the *same* polled state, not two independently-tracked
 * estimates — confirmed by reading api/routes/downloads.py: DownloadJobStart
 * now carries an optional `sizes` map from the page that started the
 * download, persisted onto each file's own status entry, which is the only
 * reason a totally separate page load like this one can compute the same
 * byte-accurate number the toast does.
 * @param {Array<{path: string, status: string, size?: number}>} files
 * @returns {{percent: number, label: string}}
 */
function computeDownloadProgress(files) {
  const total = files.length || 1;
  const doneCount = files.filter((f) => f.status === "succeeded" || f.status === "failed").length;
  const allSizesKnown = files.length > 0 && files.every((f) => typeof f.size === "number");
  // Files are downloaded strictly one at a time, in order (see
  // api/routes/downloads.py's _run_download_job) — everything before the
  // first non-terminal ("pending" or "retrying") entry has already
  // resolved, so that entry is exactly the one currently in flight. No
  // separate "current file" field from the server needed; this is
  // derivable from the same files array already being polled.
  const current = files.find((f) => f.status === "pending" || f.status === "retrying");
  const currentSuffix = current ? ` — downloading ${baseName(current.path)}` : "";

  if (allSizesKnown) {
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let doneBytes = 0;
    files.forEach((f) => {
      if (f.status === "succeeded" || f.status === "failed") doneBytes += f.size;
    });
    const percent = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;
    return { percent, label: `${formatBytes(doneBytes)} of ${formatBytes(totalBytes)} · ${percent}%${currentSuffix}` };
  }

  const percent = Math.round((doneCount / total) * 100);
  return { percent, label: `${doneCount} of ${total} item${total === 1 ? "" : "s"} (size unavailable for some items)${currentSuffix}` };
}

function renderProgressBar(files) {
  const { percent, label } = computeDownloadProgress(files || []);
  return /* html */ `
    <div class="downloads-entry-progress-wrap">
      <div class="toast-progress-track"><div class="toast-progress-fill" style="width:${percent}%"></div></div>
      <span class="toast-progress-label">${label}</span>
    </div>
  `;
}

function statusLabel(status) {
  switch (status) {
    case "complete": return "Complete";
    case "partial": return "Partially failed";
    case "failed": return "Failed";
    case "in_progress": return "In progress";
    default: return status;
  }
}

// same OOD file-browser URL pattern used by datasets.js/quick-access.js's
// own download-result rendering — this page reconstructs it client-side
// from the stored destination rather than persisting a precomputed URL
function buildOodUrl(destination) {
  return `${window.location.origin}/pun/sys/dashboard/files/fs${destination.split("/").map(encodeURIComponent).join("/")}`;
}

// path -> just the last segment, for a compact per-file label; the full
// path is still available via the title attribute on hover
function baseName(path) {
  return path.split("/").filter(Boolean).pop() || path;
}

/**
 * @param {Array<{path: string, status: string, error?: string}>} files
 * @param {number} [recordId] - the download_history id this file list
 *   belongs to, needed to wire up the per-file restart button below.
 *   Omitted (or the caller not wiring up click handling) just means no
 *   restart buttons render — used for contexts that don't have an id handy.
 */
function renderFileList(files, recordId) {
  if (!files || files.length === 0) return "";
  const rows = files
    .map((file) => {
      // "retrying" (2026-08-04 per-file restart work) is a real fourth
      // state, distinct from "pending" (never attempted) — same spinner
      // treatment as the persistent download toast's in-progress icon, so
      // a file actively being retried reads the same way across surfaces.
      const icon =
        file.status === "succeeded" ? "fa-check" :
        file.status === "retrying" ? "fa-spinner fa-spin" :
        file.status === "failed" ? "fa-times" :
        "fa-circle-o";
      // Classified reason (see api/core/failure_classification.py), shown
      // inline rather than title-only — a hover-only tooltip is exactly the
      // "easy to miss" gap this same work fixed on the admin panel's
      // indexing badge; don't repeat it here.
      const errorLine = file.status === "failed" && file.error
        ? `<span class="downloads-entry-file-error-text">${escapeHtml(file.error)}</span>`
        : "";
      const restartBtn = file.status === "failed" && recordId != null
        ? `<button class="downloads-entry-file-restart" data-path="${escapeHtml(file.path)}" title="Retry this file" aria-label="Retry this file"><i class="fa fa-refresh"></i></button>`
        : "";
      return `
        <li class="downloads-entry-file downloads-entry-file-${file.status}" title="${escapeHtml(file.path)}">
          <i class="fa ${icon}"></i>
          <div class="downloads-entry-file-info">
            <span class="downloads-entry-file-name">${escapeHtml(baseName(file.path))}</span>
            ${errorLine}
          </div>
          ${restartBtn}
        </li>`;
    })
    .join("");
  return /* html */ `
    <details class="downloads-entry-files">
      <summary class="downloads-entry-files-summary">Show files (${files.length})</summary>
      <ul class="downloads-entry-files-list" data-record-id="${recordId != null ? recordId : ""}">${rows}</ul>
    </details>
  `;
}

/**
 * Best-effort DELETE of a download-history record. Best-effort in the same
 * sense as the rest of this page's fetches: the caller decides how to react
 * to failure (a toast), this just normalizes the result shape.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function deleteDownloadRecord(id) {
  try {
    const response = await fetch(`${window.ROOT_PATH}/downloads/history/${id}`, { method: "DELETE" });
    if (!response.ok) {
      let detail = `HTTP error! status ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.detail) detail = body.detail;
      } catch (_) {}
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    console.log("deleting download record failed", error);
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

/**
 * POSTs to restart a failed download record — same normalize-the-result
 * shape as deleteDownloadRecord above.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function restartDownloadRecord(id) {
  try {
    const response = await fetch(`${window.ROOT_PATH}/downloads/history/${id}/restart`, { method: "POST" });
    if (!response.ok) {
      let detail = `HTTP error! status ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.detail) detail = body.detail;
      } catch (_) {}
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    console.log("restarting download record failed", error);
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

/**
 * POSTs to restart one specific failed file within a download record —
 * added 2026-08-04 alongside the per-file restart control in
 * renderFileList, same normalize-the-result shape as restartDownloadRecord.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function restartDownloadFile(id, path) {
  try {
    const response = await fetch(`${window.ROOT_PATH}/downloads/history/${id}/restart-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) {
      let detail = `HTTP error! status ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.detail) detail = body.detail;
      } catch (_) {}
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    console.log("restarting download file failed", error);
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

function renderEntry(entry) {
  const card = document.createElement("div");
  card.className = "downloads-entry";

  const itemsLabel = `${entry.item_count} item${entry.item_count === 1 ? "" : "s"}`;
  const showOodLink = entry.status === "complete" || entry.status === "partial";
  // "failed" (every file failed) and "partial" (some succeeded, some
  // failed) both have failed files worth retrying — the restart endpoint
  // handles both, only retrying the failed subset either way
  const showRestart = entry.status === "failed" || entry.status === "partial";

  card.innerHTML = /* html */ `
    <div class="downloads-entry-top">
      <span class="downloads-entry-name">${escapeHtml(entry.name)}</span>
      <div class="downloads-entry-top-right">
        <span class="downloads-entry-status downloads-entry-status-${entry.status}">${statusLabel(entry.status)}</span>
        ${showRestart ? `
        <button class="downloads-entry-restart" title="Retry the failed files in this download" aria-label="Restart download">
          <i class="fa fa-refresh"></i> Restart
        </button>` : ""}
        <button class="downloads-entry-delete" title="Delete this download from history" aria-label="Delete download record">
          <i class="fa fa-trash"></i>
        </button>
      </div>
    </div>
    <div class="downloads-entry-destination">${escapeHtml(entry.destination)}</div>
    <div class="downloads-entry-meta">
      <span>${itemsLabel}</span>
      <span>Started ${formatTimestamp(entry.started_at)}</span>
      ${entry.finished_at ? `<span>Finished ${formatTimestamp(entry.finished_at)}</span>` : ""}
    </div>
    ${entry.status === "in_progress" ? `<div class="downloads-entry-progress-slot">${renderProgressBar(entry.files)}</div>` : ""}
    ${entry.error_message ? `<div class="downloads-entry-error"><i class="fa fa-exclamation-circle"></i> ${escapeHtml(entry.error_message)}</div>` : ""}
    <div class="downloads-entry-files-slot">${renderFileList(entry.files, entry.id)}</div>
    ${showOodLink ? `<a class="downloads-entry-ood-link" href="${buildOodUrl(entry.destination)}" target="_blank" rel="noopener noreferrer"><i class="fa fa-external-link"></i> Open in File Browser</a>` : ""}
  `;

  const restartBtn = card.querySelector(".downloads-entry-restart");
  if (restartBtn) {
    restartBtn.addEventListener("click", async () => {
      restartBtn.disabled = true;
      const result = await restartDownloadRecord(entry.id);
      if (!result.ok) {
        showToast(result.error || "Couldn't restart this download. Try again.", "error");
        restartBtn.disabled = false;
        return;
      }
      showToast("Download restarted.", "success");
      // the restart happened in place server-side (same history_id, status
      // now in_progress with a fresh job_id) — reload the whole list rather
      // than hand-patching this card's badge/meta/files locally, since a
      // restart changes enough fields (item_count, started_at, files, the
      // job_id backing polling) that reloading is simpler and can't drift
      // from what the server actually did. loadDownloadHistory also already
      // knows to start polling any in_progress row it finds, so the new job
      // picks up live per-file updates same as a fresh download would.
      loadDownloadHistory();
    });
  }

  // One delegated listener for every per-file restart button in this card's
  // file list, rather than one listener per button — renderFileList's
  // markup is rebuilt wholesale on every poll tick while a restart is in
  // flight (see startCardPolling below), so per-button listeners would need
  // re-attaching on every one of those rebuilds; delegating to the
  // never-replaced .downloads-entry-files-slot avoids that entirely.
  const filesSlot = card.querySelector(".downloads-entry-files-slot");
  filesSlot.addEventListener("click", async (event) => {
    const btn = event.target.closest(".downloads-entry-file-restart");
    if (!btn) return;
    const list = btn.closest(".downloads-entry-files-list");
    const recordId = list && list.dataset.recordId;
    if (!recordId) return;
    btn.disabled = true;
    const result = await restartDownloadFile(recordId, btn.dataset.path);
    if (!result.ok) {
      showToast(result.error || "Couldn't restart this file. Try again.", "error");
      btn.disabled = false;
      return;
    }
    showToast("File restarted.", "success");
    // Same reasoning as the whole-record restart handler above: reload
    // rather than hand-patch, since a restart changes item_count,
    // started_at, files, and the job_id backing polling all at once.
    loadDownloadHistory();
  });

  const deleteBtn = card.querySelector(".downloads-entry-delete");
  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    const result = await deleteDownloadRecord(entry.id);
    if (!result.ok) {
      showToast(result.error || "Couldn't delete this download. Try again.", "error");
      deleteBtn.disabled = false;
      return;
    }
    // covers the in_progress case too — the job row backing this card's
    // polling is gone server-side now, so stop polling it here rather than
    // waiting for the next poll's 404 to notice
    stopCardPolling(card);
    card.remove();
    const list = document.querySelector(".downloads-list");
    if (list && list.children.length === 0) {
      const emptyState = document.querySelector(".downloads-empty-state");
      const emptyStateText = emptyState.querySelector(".downloads-empty-state-text");
      emptyStateText.textContent = "No downloads yet. Files you download from Explore Datasets or Quick Access will show up here.";
      emptyState.style.display = "flex";
    }
  });

  return card;
}

const DOWNLOAD_JOB_POLL_INTERVAL_MS = 2000;
const DOWNLOAD_JOB_TERMINAL_STATUSES = ["complete", "partial", "failed"];

// setInterval handles for every card currently polling its in-progress job,
// so a Refresh click (which rebuilds the whole list) doesn't leak polls for
// cards that no longer exist in the DOM
let activePollHandles = [];

function stopCardPolling(card) {
  if (card._pollHandle) {
    clearInterval(card._pollHandle);
    activePollHandles = activePollHandles.filter((h) => h !== card._pollHandle);
    card._pollHandle = null;
  }
}

/**
 * Polls a single in-progress card's job status every 2s — the same
 * /datasets/download/status/{id} endpoint datasets.js/quick-access.js's
 * persistent toast also polls while starting a download, so this row and
 * that toast are two views of the same underlying state, not a second
 * independent progress-tracking path. Live-updates the file disclosure and
 * the progress bar (via computeDownloadProgress, shared with the toast's
 * own progress calculation) while in progress. Stops once the job reaches
 * a terminal state, or as soon as the job 404s (its record was deleted —
 * see deleteDownloadRecord/the delete button above).
 *
 * On reaching a terminal state, the whole card is re-rendered via
 * renderEntry rather than just patching the file list — a prior version of
 * this function left the status badge/OOD link/restart button stale until
 * the next manual page load/Refresh (only the file disclosure updated
 * live), which was tolerable when there was no progress bar to visibly
 * reach 100% and then just sit there next to a badge still reading "In
 * progress"; adding one made that staleness a real, visible bug rather
 * than a cosmetic gap.
 * @param {HTMLElement} card
 * @param {string} jobId
 */
function startCardPolling(card, jobId) {
  const poll = async () => {
    try {
      const response = await fetch(`${window.ROOT_PATH}/datasets/download/status/${jobId}`, { cache: "no-store" });
      if (response.status === 404) {
        stopCardPolling(card);
        return;
      }
      if (!response.ok) return;
      const job = await response.json();

      if (DOWNLOAD_JOB_TERMINAL_STATUSES.includes(job.status)) {
        stopCardPolling(card);
        const finishedEntry = {
          id: job.history_id,
          name: job.name,
          destination: job.destination,
          status: job.status,
          item_count: job.item_count,
          started_at: job.started_at,
          finished_at: job.updated_at,
          error_message: job.error_message,
          files: job.files,
        };
        card.replaceWith(renderEntry(finishedEntry));
        return;
      }

      const slot = card.querySelector(".downloads-entry-files-slot");
      if (slot) {
        // preserve whether the user had the disclosure open across the swap —
        // otherwise it'd yank itself shut every 2s while being watched
        const wasOpen = slot.querySelector("details")?.open ?? false;
        slot.innerHTML = renderFileList(job.files, job.history_id);
        const details = slot.querySelector("details");
        if (details && wasOpen) details.open = true;
      }
      const progressSlot = card.querySelector(".downloads-entry-progress-slot");
      if (progressSlot) {
        progressSlot.innerHTML = renderProgressBar(job.files);
      }
    } catch (error) {
      console.log("polling job status failed for", jobId, error);
    }
  };
  poll();
  card._pollHandle = setInterval(poll, DOWNLOAD_JOB_POLL_INTERVAL_MS);
  activePollHandles.push(card._pollHandle);
}

async function loadDownloadHistory() {
  const list = document.querySelector(".downloads-list");
  const emptyState = document.querySelector(".downloads-empty-state");
  const emptyStateText = emptyState.querySelector(".downloads-empty-state-text");
  activePollHandles.forEach(clearInterval);
  activePollHandles = [];
  list.innerHTML = "";
  try {
    const response = await fetch(`${window.ROOT_PATH}/downloads/history`);
    if (!response.ok) {
      throw new Error(`HTTP error! status ${response.status}`);
    }
    const history = await response.json();
    if (history.length === 0) {
      emptyStateText.textContent = "No downloads yet. Files you download from Explore Datasets or Quick Access will show up here.";
      emptyState.style.display = "flex";
      return;
    }
    emptyState.style.display = "none";
    history.forEach((entry) => {
      const card = renderEntry(entry);
      list.appendChild(card);
      if (entry.status === "in_progress" && entry.job_id) {
        startCardPolling(card, entry.job_id);
      }
    });
  } catch (error) {
    console.log("loading download history failed", error);
    showToast("Couldn't load download history. Try again.", "error");
    emptyStateText.textContent = "Something went wrong loading download history.";
    emptyState.style.display = "flex";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadDownloadHistory();
  document.querySelector(".downloads-refresh-button").addEventListener("click", loadDownloadHistory);
});
