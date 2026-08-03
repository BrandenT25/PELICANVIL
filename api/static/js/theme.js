// Wires the navbar's light/dark toggle button (see templates/partials/navbar.html)
// to the data-theme attribute every stylesheet keys off, and persists the choice.
// The *initial* theme application on page load happens separately, via a small
// blocking inline script at the very top of each template's <head> — that has to
// run before CSS paints to avoid a flash of the wrong theme, before this
// deferred script or the DOM are ready. This file only needs to handle clicks.
(function () {
  var STORAGE_KEY = "pelican-ui-theme";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "light" ? "dark" : "light";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (e) {
        // localStorage unavailable (private browsing, disabled storage) —
        // theme still switches for this page view, just won't persist.
      }
    });
  });
})();
