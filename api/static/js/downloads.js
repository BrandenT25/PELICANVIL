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

function renderFileList(files) {
  if (!files || files.length === 0) return "";
  const rows = files
    .map((file) => {
      const icon = file.status === "succeeded" ? "fa-check" : file.status === "failed" ? "fa-times" : "fa-circle-o";
      return `
        <li class="downloads-entry-file downloads-entry-file-${file.status}" title="${escapeHtml(file.path)}">
          <i class="fa ${icon}"></i>
          <span>${escapeHtml(baseName(file.path))}</span>
        </li>`;
    })
    .join("");
  return /* html */ `
    <details class="downloads-entry-files">
      <summary class="downloads-entry-files-summary">Show files (${files.length})</summary>
      <ul class="downloads-entry-files-list">${rows}</ul>
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

function renderEntry(entry) {
  const card = document.createElement("div");
  card.className = "downloads-entry";

  const itemsLabel = `${entry.item_count} item${entry.item_count === 1 ? "" : "s"}`;
  const showOodLink = entry.status === "complete" || entry.status === "partial";
  const showRestart = entry.status === "failed";

  card.innerHTML = /* html */ `
    <div class="downloads-entry-top">
      <span class="downloads-entry-name">${escapeHtml(entry.name)}</span>
      <div class="downloads-entry-top-right">
        <span class="downloads-entry-status downloads-entry-status-${entry.status}">${statusLabel(entry.status)}</span>
        ${showRestart ? `
        <button class="downloads-entry-restart" title="Restart this failed download" aria-label="Restart download">
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
    ${entry.error_message ? `<div class="downloads-entry-error"><i class="fa fa-exclamation-circle"></i> ${escapeHtml(entry.error_message)}</div>` : ""}
    <div class="downloads-entry-files-slot">${renderFileList(entry.files)}</div>
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
 * Polls a single in-progress card's job status every 2s and swaps in the
 * live per-file list (done/not yet downloaded/failed), sourced from
 * download_jobs via the same status endpoint datasets.js/quick-access.js
 * already poll while starting a download. Stops once the job reaches a
 * terminal state, or as soon as the job 404s (its record was deleted — see
 * deleteDownloadRecord/the delete button above). Only the file disclosure is
 * updated in place — the rest of the card (badge, timestamps, OOD link)
 * still reflects what was true on last page load/Refresh, by design.
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
      const slot = card.querySelector(".downloads-entry-files-slot");
      if (slot) {
        // preserve whether the user had the disclosure open across the swap —
        // otherwise it'd yank itself shut every 2s while being watched
        const wasOpen = slot.querySelector("details")?.open ?? false;
        slot.innerHTML = renderFileList(job.files);
        const details = slot.querySelector("details");
        if (details && wasOpen) details.open = true;
      }
      if (DOWNLOAD_JOB_TERMINAL_STATUSES.includes(job.status)) {
        stopCardPolling(card);
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
