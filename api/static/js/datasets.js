/*
 *=====================================================================
 * Script for dataset
 *=====================================================================
 * This script handles the search bar along with creating each dataset
 * card that will generate. includes downloading and traversal of
 * dataset directories that lets you select individual files
 *=====================================================================
 */

const user = window.USER;

const rootPaths = {
  home: `/home/${USER}`,
  project: "/anvil/projects",
  scratch: `/anvil/scratch/${USER}`,
};

const snippetTemplates = {
  "python-pfs": 
  `<pre><code class="language-python">
    # pip install pelicanfs 
    from pelicanfs import PelicanFileSystem
    pelfs = PelicanFileSystem("pelican://osg-htc.org")
    pelfs.ls("{path}")
  </code></pre>`,
  "python-osdf": `
  <pre><code class="language-python">
    # pip install pelicanfs
    from pelicanfs import OSDFFileSystem

    osdf = OSDFFileSystem()
    osdf.ls("{path}")
  
  </code></pre>`,
  "python-fsspec-pfs": `<pre><code class="language-python">
    import fsspec

    fs = fsspec.filesystem("pelican")
    fs.ls("{path}")
  
  </code></pre>`,
  "python-fsspec-osdf": `<pre><code class="language-python">
    import fsspec

    fs = fsspec.filesystem("osdf")
    fs.ls("{path}")
  
  </code></pre>`,
  "python-local-storage": `<pre><code class="language-python">
    # pip install pelicanfs
    from pelicanfs import OSDFFileSystem

    osdf = OSDFFileSystem()
    osdf.get("{path}", "/local/destination/path", recursive=True)
  
  </code></pre>`,
  "python-xarray-osdf": `<pre><code class="language-python">
    import xarray as xr

    ds = xr.open_mfdataset("osdf://{path}/*", engine="zarr")
  
  </code></pre>`,
  "python-xarray-map": `<pre><code class="language-python">
    # pip install pelicanfs
    import xarray as xr
    from pelicanfs import PelicanFileSystem, PelicanMap

    pelfs = PelicanFileSystem("pelican://osg-htc.org")
    file = PelicanMap("{path}", pelfs)
    ds = xr.open_dataset(file, engine="zarr")
  
  </code></pre>`,
  "python-pandas": `<pre><code class="language-python">
    import fsspec
    import pandas as pd

    fs = fsspec.filesystem("osdf")
    with fs.open("{path}", "r") as f:
    df = pd.read_csv(f)
  
  </code></pre>`,
  "python-pytorch-list": `<pre><code class="language-python">
    # pip install torchdata
    import torch
    torch.utils.data.datapipes.utils.common.DILL_AVAILABLE = torch.utils._import_utils.dill_available()
    from torchdata.datapipes.iter import IterableWrapper

    dp = IterableWrapper(["osdf://{path}"]).list_files_by_fsspec()
    print(list(dp))
  
  </code></pre>`,
  "python-pytorch-stream": `<pre><code class="language-python">
  import torch
  torch.utils.data.datapipes.utils.common.DILL_AVAILABLE = torch.utils._import_utils.dill_available()
  from torchdata.datapipes.iter import IterableWrapper

  dp = IterableWrapper(["osdf://{path}"]).open_files_by_fsspec()
  for file_path, filestream in dp:
      print(file_path, filestream)

  </code></pre>`,
  "pelican-cli": `<pre><code class="language-bash">
    pelican object get "osdf://{path}" /local/destination/path
  </code></pre>`,
};

const snippetDescriptions = {
  "python-pfs": "Mounts the Pelican federation as a filesystem-like interface, letting you list, open, and read files as if they were local paths.",
  "python-osdf": "Same filesystem-style interface as PelicanFileSystem, pointed at the Open Science Data Federation instead of the general Pelican federation.",
  "python-fsspec-pfs": "Registers Pelican as an fsspec backend, so any fsspec-aware library (pandas, xarray, Dask, etc.) can read straight from the federation.",
  "python-fsspec-osdf": "Registers OSDF as an fsspec backend, giving fsspec-aware libraries direct read access to Open Science Data Federation paths.",
  "python-local-storage": "Downloads the file(s) to a local destination path using the OSDF filesystem's get method, including nested directories.",
  "python-xarray-osdf": "Opens the dataset directly into an xarray Dataset over OSDF for multi-dimensional array analysis.",
  "python-xarray-map": "Wraps the dataset in a PelicanMap so xarray can open it lazily as a Zarr-backed Dataset without downloading it first.",
  "python-pandas": "Streams a CSV file into a pandas DataFrame without downloading it to disk first.",
  "python-pytorch-list": "Lists the files under a path using a torchdata IterableWrapper, useful for building a PyTorch dataset pipeline.",
  "python-pytorch-stream": "Streams file contents directly into a PyTorch data pipeline, opening each file without a local download.",
  "pelican-cli": "Downloads the file(s) to local disk from the terminal using the Pelican command-line client — no Python required.",
};

/**
 * Fetches datasets from datasets.json and for each datasets makes a new card
 * @returns {Promise<void}
 */
async function fetchDatasets() {
  const categoryEmptyBox = document.querySelector(".dataset-category-empty");
  try {
    const [datasetResponse, categoryResponse] = await Promise.all([
      fetch(`${window.ROOT_PATH}/retrieve-datasets`),
      fetch(`${window.ROOT_PATH}/retrieve-categories`),
    ]);
    if (!datasetResponse.ok) {
      throw new Error(`HTTP error! status ${datasetResponse.status} `);
    }
    const datasets = await datasetResponse.json();
    // categories are only used to label the tags datasets already carry —
    // if this fetch fails, filtering by file type/streamable still works fine
    const categories = categoryResponse.ok ? await categoryResponse.json() : [];

    let visibleCount = 0;
    const renderedDatasets = [];
    datasets.forEach((dataset) => {
      // no CATEGORY set (the /datasets/search landing) => render every
      // dataset, so the shared search filter below decides what shows
      if (!window.CATEGORY || dataset["tags"].some((tag) => tag == window.CATEGORY)) {
        addDatasetCard(dataset);
        renderedDatasets.push(dataset);
        visibleCount += 1;
      }
    });
    initDatasetSearch();
    initDatasetFilters(renderedDatasets, categories);
    // only the plain "this category has nothing in it" case, not a search
    // with 0 matches — that's handled by applyDatasetFilter's own empty box
    const searchParam = new URLSearchParams(window.location.search).get("search");
    if (visibleCount === 0 && !searchParam && categoryEmptyBox) {
      categoryEmptyBox.style.display = "block";
    }
  } catch (error) {
    console.log("fetch operation failed", error);
    showToast("Something went wrong loading these datasets. Try again.", "error");
    if (categoryEmptyBox) {
      categoryEmptyBox.textContent = "Something went wrong loading datasets.";
      categoryEmptyBox.style.display = "block";
    }
  }
}

/**
 * shows only cards whose name/description contains the search box text AND
 * that satisfy the three dropdown filters (file type, category, streamable),
 * re-run on every keystroke and every dropdown change
 */
function applyDatasetFilter() {
  const input = document.querySelector(".dataset-search-input");
  const formatSelect = document.querySelector("#dataset-filter-format");
  const categorySelect = document.querySelector("#dataset-filter-category");
  const streamableSelect = document.querySelector("#dataset-filter-streamable");

  const cleanedQuery = input ? input.value.trim().toLowerCase() : "";
  const formatValue = formatSelect ? formatSelect.value : "";
  const categoryValue = categorySelect ? categorySelect.value : "";
  const streamableValue = streamableSelect ? streamableSelect.value : "";

  let visibleCount = 0;
  document.querySelectorAll(".dataset-card").forEach((card) => {
    const matchesSearch = !cleanedQuery || card.dataset.searchText.includes(cleanedQuery);
    const matchesFormat = !formatValue || card.dataset.format === formatValue;
    const cardTags = card.dataset.tags ? card.dataset.tags.split("|") : [];
    const matchesCategory = !categoryValue || cardTags.includes(categoryValue);
    const matchesStreamable = !streamableValue || card.dataset.streamable === streamableValue;

    const matches = matchesSearch && matchesFormat && matchesCategory && matchesStreamable;
    card.style.display = matches ? "" : "none";
    if (matches) {
      visibleCount += 1;
    }
  });
  const emptyBox = document.querySelector(".dataset-search-empty");
  const emptyBoxClear = emptyBox.querySelector(".dataset-search-empty-clear");
  const status = document.querySelector(".dataset-search-status");
  emptyBox.style.display = visibleCount === 0 ? "block" : "none";
  // only worth offering "clear search" when there was actually a query to clear,
  // and not when the "Showing results for" banner is already showing its own
  // clear control (arriving from a Categories-page search) — otherwise both render
  const statusVisible = status.style.display === "flex";
  emptyBoxClear.style.display = visibleCount === 0 && cleanedQuery && !statusVisible ? "block" : "none";
}

/**
 * wires the search input, pre-fills it from a ?search= URL parameter
 * (set when arriving from the Categories page search), and hooks up
 * the "Showing results for" status row and its clear button
 */
function initDatasetSearch() {
  const input = document.querySelector(".dataset-search-input");
  const status = document.querySelector(".dataset-search-status");
  const statusText = document.querySelector(".dataset-search-status-text");
  const clearButton = document.querySelector(".dataset-search-clear");
  const emptyBoxClear = document.querySelector(".dataset-search-empty-clear");
  const searchParam = new URLSearchParams(window.location.search).get("search");

  if (searchParam) {
    input.value = searchParam;
    statusText.textContent = `Showing results for "${searchParam}"`;
    status.style.display = "flex";
    applyDatasetFilter();
  }

  input.addEventListener("input", () => {
    status.style.display = "none";
    applyDatasetFilter();
  });

  function clearSearch() {
    input.value = "";
    status.style.display = "none";
    applyDatasetFilter();
    const url = new URL(window.location);
    url.searchParams.delete("search");
    window.history.replaceState({}, "", url);
  }

  clearButton.addEventListener("click", clearSearch);
  emptyBoxClear.addEventListener("click", clearSearch);
}

/**
 * populates the three filter dropdowns (file type, category, streamable)
 * from whichever values are actually present across the rendered datasets,
 * and wires each one to re-run applyDatasetFilter on change.
 *
 * Field mapping used, based on the actual dataset row shape returned by
 * /retrieve-datasets (api/routes/dataset.py): "file type" -> dataset.format,
 * "streamable or not" -> dataset.streamable (bool). There's no first-class
 * "category" column on a dataset — categories are a separate table
 * (name/url via /retrieve-categories) and a dataset belongs to one if its
 * freeform "tags" array happens to contain that category's url, the same
 * lookup /datasets/catalog already does server-side. So the category
 * dropdown is built from real categories, restricted to ones actually
 * used by a tag on a rendered dataset (no dead options).
 * @param {Array<Object>} datasets
 * @param {Array<Object>} categories
 */
function initDatasetFilters(datasets, categories) {
  const formatSelect = document.querySelector("#dataset-filter-format");
  const categorySelect = document.querySelector("#dataset-filter-category");
  const streamableSelect = document.querySelector("#dataset-filter-streamable");
  if (!formatSelect || !categorySelect || !streamableSelect || datasets.length === 0) {
    return;
  }

  const formatValues = new Set();
  const usedCategoryUrls = new Set();
  datasets.forEach((dataset) => {
    if (dataset["format"]) {
      formatValues.add(dataset["format"]);
    }
    (dataset["tags"] || []).forEach((tag) => usedCategoryUrls.add(tag));
  });

  Array.from(formatValues).sort().forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    formatSelect.appendChild(option);
  });

  categories
    .filter((category) => usedCategoryUrls.has(category["url"]))
    .sort((a, b) => a["name"].localeCompare(b["name"]))
    .forEach((category) => {
      const option = document.createElement("option");
      option.value = category["url"];
      option.textContent = category["name"];
      categorySelect.appendChild(option);
    });

  [formatSelect, categorySelect, streamableSelect].forEach((select) => {
    select.addEventListener("change", () => applyDatasetFilter());
  });
}

/**
 * Takes in the dataset card element, makes html, including all listeners to
 * make the file directory browser and checkmarks
 * @param {HTMLElement} dataset
 */

function addDatasetCard(dataset) {
  try {
    const newCard = document.createElement("div");
    const container = document.querySelector(".dataset-card-container");
    newCard.className = "dataset-card";
    newCard.dataset.searchText = `${dataset.name} ${dataset.description}`.toLowerCase();
    newCard.dataset.format = dataset["format"] || "";
    newCard.dataset.streamable = Boolean(dataset["streamable"]);
    newCard.dataset.tags = (dataset["tags"] || []).join("|");
    newCard.innerHTML = /* html */ `
            <div class="dataset-card-top">
                <div class="dataset-card-header">
                    <span class="dataset-card-title-box">${dataset.name}</span>
                    <span class="arrow"></span>
                </div>
                <div class="dataset-meta-row">
                  ${dataset["format"] ? `<span class="dataset-meta-badge dataset-meta-format"><i class="fa fa-file-o"></i>${dataset["format"]}</span>` : ""}
                  <span class="dataset-meta-badge ${dataset["streamable"] ? "dataset-meta-streamable" : "dataset-meta-static"}">
                    <i class="fa ${dataset["streamable"] ? "fa-bolt" : "fa-download"}"></i>${dataset["streamable"] ? "Streamable" : "Download only"}
                  </span>
                  ${dataset["access"] ? `<span class="dataset-meta-badge dataset-meta-access"><i class="fa ${dataset["access"].toLowerCase() === "public" ? "fa-unlock" : "fa-lock"}"></i>${dataset["access"]}</span>` : ""}
                </div>
            </div>
            <div class="dataset-card-content">
              <div class="dataset-description-container">
                <div class="dataset-description-header">
                  <h1>About</h1>
                  <div class="dataset-description-split"></div>
                </div>
                <div class="dataset-description-body">
                  <p class="dataset-description-text">${dataset.description}</p>
                </div>
                <div class="dataset-description-endpoint">
                  <span class="dataset-description-endpoint-label">Endpoint</span>
                  <code class="dataset-description-endpoint-path">${dataset.path}</code>
                </div>
              </div>

              <div class="dataset-snippet-container">
                <div class="dataset-snippet-header">
                  <div class="dataset-snippet-header-text-box">
                    <h1>Snippets</h1>
                    <p class="dataset-snippet-explainer">Ready-to-use code for accessing this dataset with common tools and languages. Select an access pattern below, then copy the snippet into your own script or notebook.</p>
                  </div>
                  <div class ="dataset-snippet-header-split"></div>
                  <div class="dataset-snippet-selector-box">
                    <span class="dataset-snippet-selector-text"></span>
                    <div class="dataset-snippet-selector-arrow"></div>
                  </div>
                  <div class="dataset-snippet-selector-content">

                  </div>
                  <p class="dataset-snippet-option-description"></p>
                  </div>
                <div class="dataset-snippet-wrapper">
                  <div class="fa fa-copy"></div>
                  <div class="dataset-snippet-box"> </div>
                </div>
              </div>
              <div class="file-browser-container">
                    <div class="file-browser-header">
                        <h1>${dataset["name"]}</h1>
                        <div class="file-browser-header-split"></div>
                        <div class="file-browser-breadcrumbs"></div>
                    </div>
                    <label class="file-browser-select-all">
                      <input type="checkbox" class="folder-checkbox file-browser-select-all-checkbox"></input>
                      <span class="folder-checkbox-custom"></span>
                      <span class="file-browser-select-all-label">Select All</span>
                    </label>
                    <div class="file-browser-directory-container"></div>
                    <div class="file-browser-download-container">
                        <div class="file-browser-download-button">
                            <span class="file-browser-download-button-text">Select Folder</span>
                        </div>
                        <div class="file-browser-download-amount"></div>
                        <div class="file-browser-download-clear">
                          <span class="file-browser-download-clear-text">Clear</span>
                        </div>
                    </div>
                </div>
              </div>
        `;
    
    const file_container = newCard.querySelector(
      ".file-browser-directory-container",
    );
    file_container.downloadSize = 0;
    const downloadContainer = newCard.querySelector(".file-browser-download-container")
    const downloadAmount = downloadContainer.querySelector(".file-browser-download-amount")
    const clearButton = downloadContainer.querySelector(".file-browser-download-clear")
    const breadcrumbs = newCard.querySelector(".file-browser-breadcrumbs");
    const download_card = newCard.querySelector(
      ".file-browser-download-amount",
    );
    const download_button = newCard.querySelector(
      ".file-browser-download-button",
    );
    const header = newCard.querySelector(".dataset-card-top");
    const snippets = newCard.querySelector(".dataset-card-content").querySelector(".dataset-snippet-container")
    const selectAllCheckbox = newCard.querySelector(".file-browser-select-all-checkbox");
    file_container.downloadPaths = new Map();
    file_container.downloadAmount = file_container.downloadPaths.size;
    file_container.selectAllCheckbox = selectAllCheckbox;
    download_button.addEventListener("click", (event) => {
      // still need to add path looping for downloading in overlay
      console.log(file_container.downloadPaths);
      download_file(file_container, file_container.downloadPaths, dataset.name);
    });

    selectAllCheckbox.addEventListener("change", (event) => {
      const checked = event.target.checked;
      const rowCheckboxes = file_container.querySelectorAll(".folder-checkbox:not(:disabled)");
      rowCheckboxes.forEach((checkbox) => {
        if (checkbox.checked !== checked) {
          checkbox.checked = checked;
          checkbox.dispatchEvent(new Event("change"));
        }
      });
    });

    
    header.addEventListener("click", (event) => {
      const drop_down = newCard.querySelector(".dataset-card-content");
      const isToggled = newCard.dataset.toggled === "true";
      const arrow = newCard.querySelector(".arrow");
      if (isToggled) {
        drop_down.style.display = "none";
        newCard.dataset.toggled = "false";
        arrow.classList.toggle("flipped");
      } else {
        drop_down.style.display = "flex";
        newCard.dataset.toggled = "true";
        arrow.classList.toggle("flipped");
        if (drop_down.isLoaded !== true) {

          loadDirectory(
            dataset["path"],
            file_container,
            breadcrumbs,
            download_card,
          );
          drop_down.isLoaded = true;
        }
      }
    });
    
    buildSnippets(snippets,dataset)
    
    clearButton.addEventListener("click", ()=>{
      file_container.downloadPaths.clear()
      updateSelectionAmountBox(file_container, downloadAmount)
      file_container.downloadSize = 0
      loadDirectory(
            file_container.currentPath,
            file_container,
            breadcrumbs,
            download_card,
          ); 
    })
          
    container.appendChild(newCard);
  } catch (error) {
    console.log("adding dataset failed with ", error);
  }
}

/**
 * Takes in path from the dataset along with related HTML DOM elements, reinitialized
 * the directory window with updated path, creates breadcrumbs and directory folder cards
 * @param {string} path
 * @param {HTMLElement} container
 * @param {HTMLElement} breadcrumbs
 * @param {HTMLElement} download_card
 */

function loadDirectory(path, container, breadcrumbs, download_card) {
  container.currentPath = path;
  if (!container.basePath) {
    container.basePath = path;
  }
  
  container.innerHTML = "";
  breadcrumbs.innerHTML = "";
  if (container.selectAllCheckbox) {
    container.selectAllCheckbox.checked = false;
  }

  makeBreadcrumbs(breadcrumbs, container, download_card);
  makeFolderCards(path, container, download_card, breadcrumbs);
}

/**
 * takes in all of the parent attributes to make each folder card, along with ancestor selections,
 * adds all needed event listeners for checkbox, sub directories, and downloading
 * @param {string} path
 * @param {HTMLElement} container
 * @param {HTMLElement} download_card
 * @param {HTMLElement} breadcrumbs
 * @returns {Promise<void>}
 */

async function makeFolderCards(path, container, download_card, breadcrumbs) {
  const paths = await retrieveDirectoryPaths(path);

  if (paths === null) {
    showToast("Couldn't load this folder. Try again.", "error");
    container.innerHTML = /* html */ `<div class="file-browser-empty-state">Something went wrong loading this folder. Try again.</div>`;
    return;
  }
  if (paths.length === 0) {
    container.innerHTML = /* html */ `<div class="file-browser-empty-state">This folder is empty.</div>`;
    return;
  }

  paths.forEach((folder_path) => {
    const cleanedPath = folder_path.name.replace(/\/$/, "");
    const name = cleanedPath.split("/").pop();
    const nameWithBreaks = name.replace(/_/g, "_<wbr>");
    const newCard = document.createElement("div");
    let imageFile;
    let fileSize;
    let fileSizeType;
    let fileBytes = 0
    if (folder_path["type"] === "directory") {
      imageFile = "folder-icon.png";
      fileSizeType = ""
      console.log(folder_path)
      fileSize = ""
    } else {
      fileBytes = folder_path["size"];
      fileSize = folder_path["size"];
      if (fileSize > 1000000000) {
        fileSize = fileSize / 1000000000;
        fileSize = truncateDecimals(fileSize, 1);
        fileSizeType = "Gb"
      } else if (fileSize > 1000000) {
        fileSize = fileSize / 1000000;
        fileSizeType = "Mb"
        fileSize = truncateDecimals(fileSize, 1);
        console.log(fileSize, "MB");
      } else if (fileSize > 1000) {
        fileSize = fileSize / 1000;
        fileSize = truncateDecimals(fileSize, 1);
        fileSizeType = "Kb"
      }
      imageFile = "file-icon.png";
    }

    newCard.className = "file-browser-directory-folder";
    newCard.dataset.path = folder_path.name;
    
    newCard.innerHTML = `
        <label class="folder-checkbox-wrapper">
            <input type="checkbox" class="folder-checkbox"></input>
            <span class="folder-checkbox-custom"></span>
        </label>
        <div class="icon-size-stack">
          <img src="${window.ROOT_PATH}/api/static/img/${imageFile}" alt="folder-icon" height="20"></img>
          ${folder_path["type"] === "directory" ? "" : `<div class="file-size-box">${fileSize}${fileSizeType}</div>`}
        </div>
        <div class="folder-info-stack">
          <div class="folder-name-box" title="${name}">
              ${nameWithBreaks}
          </div>

        </div>
        `;

    const checkBox = newCard.querySelector(".folder-checkbox");

    const fullPath = folder_path.name;
    const isDirectlySelected = container.downloadPaths.has(fullPath);
    const folderName = newCard.querySelector(".folder-name-box");

    let coveringAncestor = null;
    for (const selectedPath of container.downloadPaths.keys()) {
      if (
        fullPath !== selectedPath &&
        fullPath.startsWith(selectedPath.replace(/\/$/, "") + "/")
      ) {
        coveringAncestor = selectedPath;
        break;
      }
    }
    checkBox.checked = isDirectlySelected || Boolean(coveringAncestor);
    checkBox.disabled = Boolean(coveringAncestor) && !isDirectlySelected;
    checkBox.addEventListener("change", (event) => {
      if (event.target.checked) {
        container.downloadPaths.set(folder_path.name, folder_path.type);
        container.downloadSize += fileBytes;
        updateSelectionAmountBox(container, download_card);
      } else {
        container.downloadPaths.delete(folder_path.name);
        container.downloadSize -= fileBytes;
        updateSelectionAmountBox(container, download_card);
      }
    });
    if (folder_path["type"] === "directory") {
      folderName.addEventListener("click", (event) => {
        const newPath = newCard.dataset.path;
        loadDirectory(newPath, container, breadcrumbs, download_card);
        event.stopPropagation();
      });
    }
    container.appendChild(newCard);
  })
    
}

/**
 * fetches sub directories from a path
 * @param {string} path
 * @returns {Promise<Array<Object>>}
 */
async function retrieveDirectoryPaths(path) {
  try {
    const response = await fetch(
      `${window.ROOT_PATH}/datasets/category/list-path?path=${path}`,
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status ${response.status} `);
    }

    const paths = await response.json();
    return paths;
  } catch (error) {
    console.log("error with", error);
    return null;
  }
}

/**
 * updates the box that lets you see how many files selected
 * @param {HTMLElement} container
 * @param {HTMLElement} download_card
 */
function updateSelectionAmountBox(container, download_card) {
  container.downloadAmount = container.downloadPaths.size;
  let fileSize = container.downloadSize
  let fileSizeType = ""
  if (fileSize > 1000000000) {
    fileSize = fileSize / 1000000000;
    fileSize = truncateDecimals(fileSize, 1);
    fileSizeType = "Gb"
  } else if (fileSize > 1000000) {
    fileSize = fileSize / 1000000;
    fileSizeType = "Mb"
    fileSize = truncateDecimals(fileSize, 1);
    console.log(fileSize, "MB");
  } else if (fileSize > 1000) {
    fileSize = fileSize / 1000;
    fileSize = truncateDecimals(fileSize, 1);
    fileSizeType = "Kb"
  }
  if (container.downloadAmount === 0){
    download_card.innerHTML = ``
  } else if (container.downloadAmount === 1) {
    download_card.innerHTML = `
        <span>${container.downloadAmount} item selected | ${fileSize}${fileSizeType}</span>
    `;
  } else {
    download_card.innerHTML = `
        <span>${container.downloadAmount} items selected | ${fileSize}${fileSizeType}</span>
    `;
  }
}

/**
 * makes breadcrumbs to allow you to go back folders
 * @param {HTMLElement} breadcrumbs
 * @param {HTMLElement} container
 * @param {HTMLElement} download_card
 */
function makeBreadcrumbs(breadcrumbs, container, download_card) {
  const baseLength = container.basePath.split("/").filter(Boolean).length;
  const parts = container.currentPath.split("/").filter(Boolean);
  breadcrumbsMakeRootLabel(container, breadcrumbs, download_card);
  parts.forEach((path, index) => {
    const subPath = "/" + parts.slice(0, index + 1).join("/");
    const newCard = document.createElement("div");

    if (index < baseLength) {
      return;
    }

    if (index > baseLength) {
      const separator = document.createElement("span");
      separator.textContent = "/";
      separator.className = "breadcrumb-separator";
      breadcrumbs.appendChild(separator);
    }

    newCard.className = "part-card";
    newCard.innerHTML = `
            <span style="cursor:pointer;">${path}</span>    
        `;

    newCard.addEventListener("click", (event) => {
      event.stopPropagation();
      loadDirectory(subPath, container, breadcrumbs, download_card);
    });

    breadcrumbs.appendChild(newCard);
  });
}

/**
 * creates the clickable rootlabel for the breadcrumbs
 * @param {HTMLElement} container
 * @param {HTMLElement} breadcrumbs
 * @param {HTMLElement} download_card
 */
function breadcrumbsMakeRootLabel(container, breadcrumbs, download_card) {
  const baseParts = container.basePath.split("/").filter(Boolean);
  const newCard = document.createElement("div");

  newCard.className = "part-card";
  newCard.innerHTML = `<span style="cursor:pointer;">${baseParts[baseParts.length - 1]} </span>`;

  newCard.addEventListener("click", (event) => {
    event.stopPropagation();
    loadDirectory(container.basePath, container, breadcrumbs, download_card);
  });

  const separator = document.createElement("span");
  separator.textContent = "/";
  separator.className = "breadcrumb-separator";

  breadcrumbs.appendChild(newCard);
  breadcrumbs.appendChild(separator);
}

/**
 * just reaches fastapi endpoint to download a file
 * will add selection for where to store
 * @param {string} path
 * @returns {Promise<void>}
 */
function download_file(container, download_paths, sourceName) {
  try {
    let selectedMedium = "";
    function closeSelector(fileSelectorOverlay) {
      fileSelectorOverlay.classList.remove("show");
    }
    function changeMedium(medium, selectDownloadMedium, selectedMediumLabel, selectedMedium, downloadLocationLabel,){
      selectedMedium.dataset.currentMedium = medium;
      makeLocalDirectoryCards(
        selectedMedium.dataset.currentMedium,
        medium,
        selectedMedium,
        selectedMediumLabel,
        downloadLocationLabel,
      );
      selectDownloadMediumContent.style.display = "none";
      arrow.classList.toggle("flipped");
      selectDownloadMedium.dataset.toggled = "false";
    }
    const fileSelectorOverlay = document.querySelector(
      ".download-file-selector-overlay",
    );
    const fileSelector = document.createElement("div");
    fileSelectorOverlay.innerHTML = ``;
    fileSelector.className = "download-file-selector";
    fileSelector.innerHTML = `
            <div class="download-file-selector-close-btn">
                <span>&times;</span>
            </div>
            <div class="select-static-mediums-wrapper">
                <div class="download-modal-header">
                    <div class="download-directory-back-btn">
                        <i class="fa fa-arrow-left"></i>
                        <span class="download-directory-back-btn-text">Back</span>
                    </div>
                    <div class="select-static-mediums-group">
                        <div class="select-static-mediums">
                            <span class="selected-static-medium">Choose a location</span>
                            <span class="select-static-mediums-arrow"></span>
                        </div>
                        <div class="select-static-mediums-content">
                            <div class="medium-selection-wrapper">
                                <div class="medium-selection-card" id="home"><i class="fa fa-home"></i><span class="medium-selection-card-label">/Home</span></div>
                                <div class="medium-selection-card" id="project"><i class="fa fa-folder"></i><span class="medium-selection-card-label">/Project</span></div>
                                <div class="medium-selection-card" id="scratch"><i class="fa fa-clock-o"></i><span class="medium-selection-card-label">/Scratch</span></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="browse-medium-directory"></div>
                <div class="directory-download-container">
                    <div class="directory-download-info">
                        <div class="directory-download-container-location"></div>
                        <div class="directory-download-container-amount"></div>
                    </div>
                    <div class="directory-download-button"><span>Download</span></div>
                </div>
                <div class="directory-download-result" style="display:none;"></div>
            </div>
        `;

    const staticMediumWrapper = fileSelector.querySelector(
      ".select-static-mediums-wrapper",
    );
    const download_card = staticMediumWrapper.querySelector(
      ".directory-download-container",
    );
    const downloadResult = staticMediumWrapper.querySelector(
      ".directory-download-result",
    );
    const downloadButton = download_card.querySelector(
      ".directory-download-button",
    );
    const downloadLocation = download_card.querySelector(
      ".directory-download-container-location",
    );
    const download_card_amount = download_card.querySelector(
      ".directory-download-container-amount",
    );
    const selectDownloadMedium = staticMediumWrapper.querySelector(
      ".select-static-mediums",
    );
    const arrow = selectDownloadMedium.querySelector(
      ".select-static-mediums-arrow",
    );
    const closeBtn = fileSelector.querySelector(
      ".download-file-selector-close-btn",
    );
    const selectDownloadMediumContent = staticMediumWrapper.querySelector(
      ".select-static-mediums-content",
    );
    const mediumSelectionWrapper = selectDownloadMediumContent.querySelector(
      ".medium-selection-wrapper",
    );
    const selectHome = mediumSelectionWrapper.querySelector("#home");
    const selectProject = mediumSelectionWrapper.querySelector("#project");
    const selectScratch = mediumSelectionWrapper.querySelector("#scratch");
    const selectedMediumLabel = selectDownloadMedium.querySelector(
      ".selected-static-medium",
    );
    const mediumDirectory = staticMediumWrapper.querySelector(
      ".browse-medium-directory",
    );
    const backButton = staticMediumWrapper.querySelector(
      ".download-directory-back-btn",
    );

    updateSelectionAmountBox(container, download_card_amount);

    selectDownloadMedium.addEventListener("click", (event) => {
      const isToggled = selectDownloadMedium.dataset.toggled === "true";
      if (isToggled) {
        selectDownloadMediumContent.style.display = "none";
        arrow.classList.toggle("flipped");
        selectDownloadMedium.dataset.toggled = "false";
      } else {
        console.log("toggled");
        arrow.classList.toggle("flipped");
        selectDownloadMedium.dataset.toggled = "true";
        selectDownloadMediumContent.style.display = "block";
      }
    });

    selectHome.addEventListener("click", () =>
      changeMedium(
        "home",
        selectDownloadMedium,
        selectedMediumLabel,
        mediumDirectory,
        downloadLocation,
      ),
    );
    selectProject.addEventListener("click", () =>
      changeMedium(
        "project",
        selectDownloadMedium,
        selectedMediumLabel,
        mediumDirectory,
        downloadLocation,
      ),
    );
    selectScratch.addEventListener("click", () =>
      changeMedium(
        "scratch",
        selectDownloadMedium,
        selectedMediumLabel,
        mediumDirectory,
        downloadLocation,
      ),
    );
    backButton.addEventListener("click", () => {
      const path = mediumDirectory.downloadPath;
      const parts = path.split("/").filter(Boolean);
      const root = parts[0];
      parts.pop();
      const newPath = parts.join("/");
      if (mediumDirectory.dataset.currentMedium == root && parts.length < 1) {
        return;
      } else {
        makeLocalDirectoryCards(
          mediumDirectory.dataset.currentMedium,
          newPath,
          mediumDirectory,
          selectedMediumLabel,
          downloadLocation,
        );
      }
    });
    closeBtn.addEventListener("click", () =>
      closeSelector(fileSelectorOverlay),
    );
    downloadButton.addEventListener("click", async () => {
      if (!mediumDirectory.downloadPath) {
        showToast("Choose a destination folder first.", "error");
        return;
      }
      if (download_paths.size === 0) {
        showToast("Select at least one file or folder first.", "error");
        return;
      }

      // hand off immediately rather than making the user babysit this modal —
      // the download keeps running in the background and reports its outcome
      // via a second toast (from renderDownloadResult below) when it's done
      closeSelector(fileSelectorOverlay);
      showToast("Download started.", "success", 6000, {
        action: { label: "View Downloads", href: `${window.ROOT_PATH}/downloads` },
      });

      const result = await downloadFromPath(mediumDirectory.downloadPath, download_paths, sourceName);
      renderDownloadResult(downloadResult, result);
    });
    fileSelectorOverlay.appendChild(fileSelector);
    fileSelectorOverlay.classList.add("show");
  } catch (error) {
    console.log("error with", error);
  }
}

async function makeLocalDirectoryCards(root, path = "", browseLocalDirectoryContainer, mediumLabel, downloadLocationLabel){
  browseLocalDirectoryContainer.downloadPath = path;
  browseLocalDirectoryContainer.innerHTML = ``;
  const textParts = path.split("/").filter(Boolean);
  let firstPart = textParts[0] || "";
  const downloadLocation = textParts[textParts.length - 1];
  firstPart = firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
  const subParts = textParts.slice(1);
  const displayText =
    subParts.length > 2
      ? `${firstPart} / … / ${subParts[subParts.length - 1]}`
      : [firstPart, ...subParts].join(" / ");
  mediumLabel.textContent = displayText;
  downloadLocationLabel.textContent = `Downloading in Folder: ${downloadLocation}`;
  const folders = await fetchLocalDirectory(path);

  if (folders === null) {
    browseLocalDirectoryContainer.innerHTML = /* html */ `<div class="local-directory-empty-state">Couldn't load this folder.</div>`;
    return;
  }
  if (folders.length === 0) {
    browseLocalDirectoryContainer.innerHTML = /* html */ `<div class="local-directory-empty-state">No subfolders here.</div>`;
    return;
  }

  folders.forEach((folder) => {
    const isEntryObject = typeof folder === "object" && folder !== null;
    const name = isEntryObject ? folder.name : folder;
    const accessible = isEntryObject ? folder.accessible : true;

    const newCard = document.createElement("div");
    newCard.className = "local-directory-cards";
    if (!accessible) {
      newCard.classList.add("local-directory-cards-disabled");
    }

    browseLocalDirectoryContainer.appendChild(newCard);
    newCard.innerHTML = `
      <i class="fa fa-folder-o"></i>
      <span class="local-directory-cards-label">${name}</span>
      ${!accessible ? '<i class="fa fa-lock local-directory-cards-denied" title="You don\'t have permission to access this allocation"></i>' : ""}
      `

    if (accessible) {
      const newPath = `${path}/${name}`;
      newCard.addEventListener("click", () => {
      makeLocalDirectoryCards(
        root,
        newPath,
        browseLocalDirectoryContainer,
        mediumLabel,
        downloadLocationLabel,
      );
    });
  }
});

}

async function fetchLocalDirectory(path) {
  try {
    const response = await fetch(
      `${window.ROOT_PATH}/datasets/local-browse/list-root?medium=${path}`,
    );
    if (!response.ok) {
      // backend already sends a specific reason (permission denied, folder
      // not found, unknown allocation) — surface that instead of a generic one
      let detail = `HTTP error! status ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.detail) detail = body.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const paths = await response.json();
    return paths;
  } catch (error) {
    console.log(error);
    showToast(error.message || "Couldn't load that folder. Try again.", "error");
    return null;
  }
}

function buildSnippets(snippetBox, dataset){
  function changeSnippet(snippetId, copyDOM){
    const snippetCodeBox = snippetBox.querySelector(".dataset-snippet-box")
    snippetCodeBox.innerHTML = ``
    Object.entries(snippetTemplates).forEach(([name, code]) => {
      if(name == snippetId){
        snippetCodeBox.innerHTML = code.replaceAll("{path}", dataset.path)
        const codeElement = snippetCodeBox.querySelector("code")
        const codeText = codeElement.textContent
        copyDOM.dataset.copyData = codeText
        hljs.highlightElement(codeElement)
      }
    })
  }
  const snippetHeader = snippetBox.querySelector(".dataset-snippet-header")
  const snippetSelectorBox = snippetHeader.querySelector(".dataset-snippet-selector-box")
  const snippetSelectorText = snippetSelectorBox.querySelector(".dataset-snippet-selector-text")
  const snippetSelectorArrow = snippetSelectorBox.querySelector(".dataset-snippet-selector-arrow")
  const snippetSelectorContent = snippetHeader.querySelector(".dataset-snippet-selector-content")
  const snippetOptionDescription = snippetHeader.querySelector(".dataset-snippet-option-description")
  const snippetCopy = snippetBox.querySelector(".fa-copy")
  snippetCopy.dataset.copyData = ""
  snippetSelectorText.textContent = "None"
  snippetSelectorContent.innerHTML =  /* html */`
    <div class="snippet-selector-card" id="python-pfs"><i class="fa fa-code"></i>Python - PelicanFileSystem</div>
    <div class="snippet-selector-card" id="python-osdf"><i class="fa fa-code"></i>Python - OSDFFileSystem</div>
    <div class="snippet-selector-card" id="python-fsspec-pfs"><i class="fa fa-code"></i>Python - Fsspec - PelicanFileSystem</div>
    <div class="snippet-selector-card" id="python-fsspec-osdf"><i class="fa fa-code"></i>Python - Fsspec - OSDFFileSystem</div>
    <div class="snippet-selector-card" id="python-local-storage"><i class="fa fa-code"></i>Python - Local Storage</div>
    <div class="snippet-selector-card" id="python-xarray-osdf"><i class="fa fa-code"></i>Python - xarray-OSDFFileSystem</div>
    <div class="snippet-selector-card" id="python-xarray-map"><i class="fa fa-code"></i>Python - xarray - PelicanMap</div>
    <div class="snippet-selector-card" id="python-pandas"><i class="fa fa-code"></i>Python - pandas</div>
    <div class="snippet-selector-card" id="python-pytorch-list"><i class="fa fa-code"></i>Python - Pytorch List</div>
    <div class="snippet-selector-card" id="python-pytorch-stream"><i class="fa fa-code"></i>Python - Pytorch Stream</div>
    <div class="snippet-selector-card" id="pelican-cli"><i class="fa fa-terminal"></i>Pelican Command Line</div>
  `
  const snippetSelectors = snippetSelectorContent.querySelectorAll(".snippet-selector-card");
  snippetSelectors.forEach((snippetSelector) => {
    const id = snippetSelector.id;
    const name = snippetSelector.textContent
    snippetSelector.addEventListener("click", (event) =>{
      snippetSelectorArrow.classList.toggle("flipped")
      snippetSelectorBox.dataset.toggled === 'true'
      snippetSelectorContent.classList.toggle("show")
      snippetSelectorText.textContent = name
      snippetOptionDescription.textContent = snippetDescriptions[id] || ""
      changeSnippet(id, snippetCopy)

    })
  })
  snippetCopy.addEventListener("click", () =>{
    navigator.clipboard.writeText(snippetCopy.dataset.copyData)
  })


  snippetSelectorBox.addEventListener("click", () =>{
    const toggled = snippetSelectorBox.dataset.toggled === 'true'
    if(toggled){
      snippetSelectorArrow.classList.toggle("flipped")
      snippetSelectorBox.dataset.toggled === 'false'
      snippetSelectorContent.classList.toggle("show")
      console.log("toggled on")
    }else{
      snippetSelectorArrow.classList.toggle("flipped")
      snippetSelectorBox.dataset.toggled === 'true'
      snippetSelectorContent.classList.toggle("show")
    }
  })
}
/**
 * just reads DOM window refresh and calls functions that need to be generates at start of window
 */
function main() {
  document.addEventListener("DOMContentLoaded", (event) => {
    fetchDatasets();
  });
}

// How often to poll the job-status endpoint, and a hard cap on attempts so
// the UI always eventually resolves even if a job hangs forever (e.g. the
// Passenger worker running its background thread got recycled mid-transfer —
// see the note on downloadFromPath below). 1.5s * 800 =~ 20 minutes.
const DOWNLOAD_POLL_INTERVAL_MS = 1500;
const DOWNLOAD_POLL_MAX_ATTEMPTS = 800;
const DOWNLOAD_TERMINAL_STATUSES = ["complete", "partial", "failed"];

/**
 * Starts a background download job on the server and polls its status until
 * it finishes, instead of holding a single request open for the whole
 * transfer (the server now returns from /datasets/download/start almost
 * immediately — the actual osdf.get() work happens on a background thread,
 * see api/routes/downloads.py). This is what fixes large/multi-file batches
 * failing with a NetworkError: no request is held open long enough to hit a
 * proxy/timeout limit regardless of file size or batch size.
 *
 * Known tradeoff of running this as an in-process background thread rather
 * than an external job queue: if the Passenger worker process running the
 * job thread gets recycled mid-transfer, the thread dies with it and the job
 * is left stuck at "in_progress" with a partial file on disk. The poll loop
 * below still resolves for the user (via DOWNLOAD_POLL_MAX_ATTEMPTS), just
 * reporting whatever finished as succeeded and the rest as failed.
 * @param {string} file - medium + subfolder path, e.g. "project/x-abc/data"
 * @param {Map<string,string>} paths - path -> type, from container.downloadPaths
 * @param {string} [sourceName] - human-readable name of what's being downloaded
 * @returns {Promise<{succeeded: string[], failed: string[], destination: string, oodUrl: string}>}
 */
async function downloadFromPath(file, paths, sourceName) {
  const parts = file.split("/");
  const root = parts[0];
  const resolved_root = rootPaths[root];
  parts[0] = resolved_root;
  const fullPath = parts.join("/");
  const oodUrl = `${window.location.origin}/pun/sys/dashboard/files/fs${fullPath.split("/").map(encodeURIComponent).join("/")}`;
  const pathList = Array.from(paths.keys());

  let job;
  try {
    const response = await fetch(`${window.ROOT_PATH}/datasets/download/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sourceName || fullPath, destination: fullPath, paths: pathList }),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status ${response.status}`);
    }
    job = await response.json();
  } catch (error) {
    console.log("starting download job failed", error);
    return { succeeded: [], failed: pathList, destination: fullPath, oodUrl };
  }

  let status = job;
  for (let attempt = 0; attempt < DOWNLOAD_POLL_MAX_ATTEMPTS; attempt++) {
    if (DOWNLOAD_TERMINAL_STATUSES.includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_POLL_INTERVAL_MS));
    try {
      const response = await fetch(`${window.ROOT_PATH}/datasets/download/status/${job.job_id}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP error! status ${response.status}`);
      }
      status = await response.json();
    } catch (error) {
      // transient hiccup while polling — the job may still be completing
      // fine server-side, so keep trying rather than giving up on it
      console.log("polling download job failed", error);
    }
  }

  const files = status.files || [];
  const succeeded = files.filter((f) => f.status === "succeeded").map((f) => f.path);
  const failed = files.filter((f) => f.status !== "succeeded").map((f) => f.path);

  return { succeeded, failed, destination: fullPath, oodUrl };
}

/**
 * Renders the outcome of downloadFromPath into the download modal and
 * raises a toast — success gets a link to open the destination in OOD's
 * file browser, failures get a specific-as-possible message.
 * @param {HTMLElement} container
 * @param {{succeeded: string[], failed: string[], destination: string, oodUrl: string}} result
 */
function renderDownloadResult(container, result) {
  container.style.display = "flex";
  const total = result.succeeded.length + result.failed.length;
  const ood = /* html */ `
    <a class="download-result-ood-link" href="${result.oodUrl}" target="_blank" rel="noopener noreferrer">
      <i class="fa fa-external-link"></i> Open in File Browser
    </a>
  `;

  if (result.failed.length === 0) {
    container.innerHTML = /* html */ `
      <div class="download-result download-result-success">
        <i class="fa fa-check-circle"></i>
        <span>Downloaded ${result.succeeded.length} item${result.succeeded.length === 1 ? "" : "s"} to ${result.destination}.</span>
      </div>
      ${ood}
    `;
    showToast(`Download complete — ${result.succeeded.length} item${result.succeeded.length === 1 ? "" : "s"} saved.`, "success");
  } else if (result.succeeded.length === 0) {
    container.innerHTML = /* html */ `
      <div class="download-result download-result-error">
        <i class="fa fa-exclamation-circle"></i>
        <span>All ${result.failed.length} item${result.failed.length === 1 ? "" : "s"} failed to download. Check permissions on the destination and try again.</span>
      </div>
    `;
    showToast("Download failed. Check permissions on the destination and try again.", "error");
  } else {
    container.innerHTML = /* html */ `
      <div class="download-result download-result-error">
        <i class="fa fa-exclamation-circle"></i>
        <span>${result.succeeded.length} of ${total} items downloaded — ${result.failed.length} failed.</span>
      </div>
      ${ood}
    `;
    showToast(`${result.failed.length} of ${total} items failed to download.`, "error");
  }
}

/**
 * Just a basic function to set to a decimal place
 * @param {int} number
 * @param {int} digits
 */

function truncateDecimals(number, digits) {
  const multiplier = Math.pow(10, digits);
  return Math.trunc(number * multiplier) / multiplier;
}

main();
