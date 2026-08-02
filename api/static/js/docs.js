/*
 * docs.js — behavior for the Documentation page only.
 * 1. Scroll-spy: highlights the current heading in the left sidebar.
 * 2. Sidebar group collapse/expand.
 * No fetches, no shared state — everything is local to this page.
 */

function initScrollSpy() {
  const headings = Array.from(
    document.querySelectorAll(".docs-content h2[id], .docs-content h3[id]"),
  );
  const sidebarLinks = document.querySelectorAll(".docs-sidebar-link");

  function setActive(id) {
    sidebarLinks.forEach((link) => {
      link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
    });
  }

  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const atBottom =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 4;
      if (atBottom && headings.length) {
        setActive(headings[headings.length - 1].id);
        return;
      }
      const offset = window.scrollY + 160;
      let current = headings[0];
      headings.forEach((heading) => {
        if (heading.offsetTop <= offset) {
          current = heading;
        }
      });
      if (current) {
        setActive(current.id);
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function initSidebarGroups() {
  document.querySelectorAll(".docs-sidebar-chevron").forEach((chevron) => {
    chevron.addEventListener("click", (event) => {
      event.preventDefault();
      chevron.closest(".docs-sidebar-group").classList.toggle("collapsed");
    });
  });
}

/*
 * Dataset Catalog section — fetches the live catalog from the backend once,
 * then does all sorting/filtering client-side against the cached list so
 * clicking a header or typing in the filter box doesn't refetch.
 */
let catalogDatasets = [];
let catalogSort = { field: null, ascending: true };
let catalogFilterText = "";

function categoryDisplayText(dataset) {
  return dataset.categories.length ? dataset.categories.join(", ") : "Uncategorized";
}

function renderCatalogTable() {
  const tbody = document.querySelector(".docs-catalog-tbody");
  const emptyBox = document.querySelector(".docs-catalog-empty");
  if (!tbody) return;

  const cleanedQuery = catalogFilterText.trim().toLowerCase();
  let visible = cleanedQuery
    ? catalogDatasets.filter((dataset) => dataset.name.toLowerCase().includes(cleanedQuery))
    : catalogDatasets.slice();

  if (catalogSort.field) {
    visible.sort((a, b) => {
      const aValue = catalogSort.field === "name" ? a.name : categoryDisplayText(a);
      const bValue = catalogSort.field === "name" ? b.name : categoryDisplayText(b);
      const result = aValue.toLowerCase().localeCompare(bValue.toLowerCase());
      return catalogSort.ascending ? result : -result;
    });
  }

  tbody.innerHTML = "";
  visible.forEach((dataset) => {
    const row = document.createElement("tr");
    const searchUrl = `${window.ROOT_PATH}/datasets/search?search=${encodeURIComponent(dataset.name)}`;
    row.innerHTML = /* html */ `
      <td><a class="docs-catalog-dataset-link" href="${searchUrl}">${dataset.name}</a></td>
      <td class="${dataset.categories.length ? "" : "docs-catalog-uncategorized"}">${categoryDisplayText(dataset)}</td>
    `;
    tbody.appendChild(row);
  });

  emptyBox.style.display = visible.length === 0 ? "block" : "none";
}

function updateCatalogSortArrows() {
  document.querySelectorAll(".docs-catalog-sortable").forEach((header) => {
    const arrow = header.querySelector(".docs-catalog-sort-arrow");
    if (header.dataset.sortField === catalogSort.field) {
      arrow.classList.add("active");
      arrow.classList.toggle("desc", !catalogSort.ascending);
    } else {
      arrow.classList.remove("active", "desc");
    }
  });
}

function initCatalogSort() {
  document.querySelectorAll(".docs-catalog-sortable").forEach((header) => {
    header.addEventListener("click", () => {
      const field = header.dataset.sortField;
      if (catalogSort.field === field) {
        catalogSort.ascending = !catalogSort.ascending;
      } else {
        catalogSort = { field, ascending: true };
      }
      updateCatalogSortArrows();
      renderCatalogTable();
    });
  });
}

function initCatalogFilter() {
  const input = document.querySelector(".docs-catalog-search-input");
  if (!input) return;
  input.addEventListener("input", () => {
    catalogFilterText = input.value;
    renderCatalogTable();
  });
}

async function initDatasetCatalog() {
  const overview = document.querySelector(".docs-catalog-overview");
  if (!overview) return;
  try {
    const response = await fetch(`${window.ROOT_PATH}/datasets/catalog`);
    if (!response.ok) {
      throw new Error(`HTTP error! status ${response.status}`);
    }
    const data = await response.json();
    catalogDatasets = data.datasets;
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    overview.textContent = `As of ${today}, there are ${data.dataset_count} publicly available datasets across ${data.category_count} categories: ${data.category_names.join(", ")}.`;
    initCatalogSort();
    initCatalogFilter();
    renderCatalogTable();
  } catch (error) {
    overview.textContent = "Couldn't load the dataset catalog right now.";
    console.log("initDatasetCatalog failed:", error);
  }
}

// Each init is independent (scroll-spy, sidebar collapse, dataset catalog
// don't share state) — wrapping each one separately means an exception in
// any single one can never block the others from running. Without this,
// one broken init here silently kills everything registered after it in
// the same handler; that's exactly what happened when a stale cached copy
// of an older version of this file (from before the "On this page" TOC
// column was removed) called a since-deleted buildToc() against the
// current docs.html, which no longer has the element it expected — the
// resulting exception aborted this whole callback before initDatasetCatalog()
// ever ran, leaving the catalog section stuck on its static "Loading
// catalog…" text with no error surfaced anywhere.
function safeInit(name, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`docs.js: ${name} failed to initialize`, error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  safeInit("initScrollSpy", initScrollSpy);
  safeInit("initSidebarGroups", initSidebarGroups);
  safeInit("initDatasetCatalog", initDatasetCatalog);
});
