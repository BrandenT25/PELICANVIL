/*
 * auth-token-modal.js — shared "this dataset requires an access token" modal.
 * datasets.js and quick-access.js both trigger the exact same flow (POST
 * /auth/token, then redo whatever browse/download call hit a 401/403), so
 * this lives once here rather than as a third copy of the datasets.js /
 * quick-access.js file-browser-style duplication — unlike that duplication,
 * there's no page-specific behavior here for a copy to diverge around.
 */
(function () {
  function ensureOverlay() {
    let overlay = document.querySelector(".auth-token-modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "auth-token-modal-overlay";
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  /**
   * @param {string} namespace - path that requires a token, shown to the user
   * @param {{
   *   onSubmit: (token: string) => Promise<boolean>,
   *   onCancel?: () => void
   * }} handlers
   *   onSubmit receives the entered token; it must save it and retry the
   *   original action, resolving true to close the modal or false to reopen
   *   it with an inline error (bad/expired token). onCancel fires if the user
   *   dismisses the modal without submitting.
   */
  window.showAuthRequiredModal = function (namespace, handlers) {
    const { onSubmit, onCancel } = handlers || {};
    const overlay = ensureOverlay();
    overlay.innerHTML = /* html */ `
      <div class="auth-token-modal">
        <div class="auth-token-modal-close-btn"><span>&times;</span></div>
        <h3 class="auth-token-modal-title">Access token required</h3>
        <p class="auth-token-modal-body">
          <span class="auth-token-modal-namespace"></span> is in a protected namespace and needs an access token before it can be browsed or downloaded.
        </p>
        <a class="auth-token-modal-link" href="https://docs.pelicanplatform.org/getting-data-with-pelican/auth" target="_blank" rel="noopener">How do I get a token?</a>
        <input type="password" class="auth-token-modal-input" placeholder="Paste your access token" autocomplete="off">
        <div class="auth-token-modal-error" style="display:none;"></div>
        <div class="auth-token-modal-actions">
          <button type="button" class="auth-token-modal-cancel">Cancel</button>
          <button type="button" class="auth-token-modal-submit">Submit</button>
        </div>
      </div>
    `;
    overlay.querySelector(".auth-token-modal-namespace").textContent = namespace;

    const input = overlay.querySelector(".auth-token-modal-input");
    const errorBox = overlay.querySelector(".auth-token-modal-error");
    const submitBtn = overlay.querySelector(".auth-token-modal-submit");
    const cancelBtn = overlay.querySelector(".auth-token-modal-cancel");
    const closeBtn = overlay.querySelector(".auth-token-modal-close-btn");

    function close() {
      overlay.classList.remove("show");
      overlay.innerHTML = "";
    }

    function cancel() {
      close();
      if (onCancel) onCancel();
    }

    cancelBtn.addEventListener("click", cancel);
    closeBtn.addEventListener("click", cancel);

    async function submit() {
      const token = input.value.trim();
      if (!token) {
        errorBox.textContent = "Enter a token first.";
        errorBox.style.display = "block";
        return;
      }
      errorBox.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      try {
        const response = await fetch(`${window.ROOT_PATH}/auth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace, token }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.success) {
          errorBox.textContent = "Couldn't save that token. Try again.";
          errorBox.style.display = "block";
          return;
        }
        const succeeded = onSubmit ? await onSubmit(token) : true;
        if (succeeded) {
          close();
        } else {
          errorBox.textContent = "That token was rejected. Check it and try again.";
          errorBox.style.display = "block";
          input.value = "";
          input.focus();
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
      }
    }

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    overlay.classList.add("show");
    input.focus();
  };
})();
