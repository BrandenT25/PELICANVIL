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


const quickAccessInput = document.querySelector(".quick-access-input");
const quickAccessSubmit = document.querySelector(".quick-access-submit");
const quickAccessContent = document.querySelector(".quick-access-content");

quickAccessSubmit.addEventListener("click", () =>{
    const path = quickAccessInput.value.trim()
    if(!path) return;
    console.log(path)
    submitQuickAccessPath(path)
})

quickAccessInput.addEventListener("keydown", (event) =>{
    if(event.key === "Enter"){
        const path = quickAccessInput.value.trim()
        console.log(path)
        if(!path) return;
        submitQuickAccessPath(path)
    }
})

async function submitQuickAccessPath(path, isRetry = false){

    const result = await validateQuickAccessPath(path)
    const errorBox = document.querySelector(".quick-access-error")
    if (result.authRequired) {
        errorBox.style.display = "none";
        showTokenAuthModal(
            result.namespace,
            () => submitQuickAccessPath(path, true),
            isRetry ? "That token was rejected. Check it and try again." : "",
        );
        return;
    }
    if(!result.success){
        errorBox.textContent = result.error;
        errorBox.style.display = "block";
        return;
    }
    errorBox.style.display = "none";
    buildQuickAccessTools(result.paths, path)

}

function buildQuickAccessTools(paths, path){
    const quickAccessContent = document.querySelector(".quick-access-content")
    buildSnippets(path)
    buildBrowser(path)







    quickAccessContent.classList.add("show")
}
async function validateQuickAccessPath(path){
    try{
        const response = await fetch(`${window.ROOT_PATH}/datasets/category/list-path?path=${path}`)
            if(!response.ok) {
            if (response.status === 401){
                const namespace = await extractAuthRequiredNamespace(response);
                if (namespace){
                    return { success: false, authRequired: true, namespace };
                }
            }
            if (response.status === 404){
                return { success: false, error: "Path not found. Check the endpoint and try again." };
            }else{
                return { success: false, error: `Something went wrong (status ${response.status}).` };
            }
        }
        const paths = await response.json();
        return { success: true, paths };
    }catch (error){
        console.log("validateQuickAccessPath failed:", error);
        return { success: false, error: "Couldn't reach the server. Try again." };

    }

}

function buildSnippets(path){
    console.log("building snippets")
    const snippetWindow = document.querySelector(".quick-access-snippet-wrapper")
    function changeSnippet(snippetId, copyDOM){
        const snippetCodeBox = snippetWindow.querySelector(".dataset-snippet-box")
        snippetCodeBox.innerHTML = ``
        Object.entries(snippetTemplates).forEach(([name, code]) => {
        if(name == snippetId){
            snippetCodeBox.innerHTML = code.replaceAll("{path}", path)
            const codeElement = snippetCodeBox.querySelector("code")
            const codeText = codeElement.textContent
            copyDOM.dataset.copyData = codeText
            hljs.highlightElement(codeElement)
        }
        })
    }   
    snippetWindow.innerHTML = /* html */`
    <div class="dataset-snippet-header">
        <div class="dataset-snippet-header-text-box">
            <h1>Snippets</h1>
            <p class="dataset-snippet-explainer">Ready-to-use code for accessing this path with common tools and languages. Select an access pattern below, then copy the snippet into your own script or notebook.</p>
        </div>
        <div class ="dataset-snippet-header-split"></div>
        <div class="dataset-snippet-selector-box">
            <span class="dataset-snippet-selector-text"></span>
            <div class="dataset-snippet-selector-arrow"></div>
        </div>
        <div class="dataset-snippet-selector-content"></div>
        <p class="dataset-snippet-option-description"></p>
        </div>
            <div class="dataset-snippet-wrapper">
            <div class="fa fa-copy"></div>
            <div class="dataset-snippet-box"> </div>
        </div>
                `
        const snippetHeader = snippetWindow.querySelector(".dataset-snippet-header")
        const snippetSelectorBox = snippetHeader.querySelector(".dataset-snippet-selector-box")
        const snippetSelectorText = snippetSelectorBox.querySelector(".dataset-snippet-selector-text")
        const snippetSelectorArrow = snippetSelectorBox.querySelector(".dataset-snippet-selector-arrow")
        const snippetSelectorContent = snippetHeader.querySelector(".dataset-snippet-selector-content")
        const snippetOptionDescription = snippetHeader.querySelector(".dataset-snippet-option-description")
        const snippetCopy = snippetWindow.querySelector(".fa-copy")
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


function buildBrowser(path){
    const file_container = document.querySelector(".file-browser-directory-container")
    const breadcrumbs = document.querySelector(".file-browser-breadcrumbs")
    const download_card = document.querySelector(".file-browser-download-amount")
    const displayName = path.split("/").filter(Boolean).pop() || path;
    const clearButton = document.querySelector(".file-browser-download-clear")
    const downloadAmount = document.querySelector(".file-browser-download-amount")
    const download_button = document.querySelector(".file-browser-download-button");
    const selectAllCheckbox = document.querySelector(".file-browser-select-all-checkbox");
    file_container.downloadPaths = new Map();
    file_container.downloadAmount = file_container.downloadPaths.size;
    file_container.downloadSize = 0;
    file_container.selectAllCheckbox = selectAllCheckbox;
    loadDirectory(path, file_container, breadcrumbs, download_card)

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
    download_button.addEventListener("click", (event) => {
      console.log(file_container.downloadPaths);
      download_file(file_container, file_container.downloadPaths, displayName);
    });
}

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

async function makeFolderCards(path, container, download_card, breadcrumbs, isRetry = false){
    const paths = await retrieveDirectoryPaths(path);

  if (paths && paths.authRequired) {
    showTokenAuthModal(
      paths.namespace,
      () => makeFolderCards(path, container, download_card, breadcrumbs, true),
      isRetry ? "That token was rejected. Check it and try again." : "",
    );
    return;
  }

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


async function retrieveDirectoryPaths(path) {
  try {
    const response = await fetch(
      `${window.ROOT_PATH}/datasets/category/list-path?path=${path}`,
    );
    if (!response.ok) {
      if (response.status === 401) {
        const namespace = await extractAuthRequiredNamespace(response);
        if (namespace) {
          return { authRequired: true, namespace };
        }
      }
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
 * Reads the {detail: {error: "auth_required", namespace}} body the backend
 * sends for a 401 from /datasets/category/list-path (see pelicanlistPath in
 * api/routes/pelican.py) and pulls out the namespace path, or null if this
 * 401 wasn't actually that shape (a plain auth failure elsewhere, etc).
 * @param {Response} response
 * @returns {Promise<string|null>}
 */
async function extractAuthRequiredNamespace(response) {
  try {
    const body = await response.json();
    if (body && body.detail && body.detail.error === "auth_required") {
      return body.detail.namespace;
    }
  } catch (_) {}
  return null;
}

/**
 * Shows the "this namespace needs a token" modal: explanation, a masked
 * input, a link to Pelican's own token docs, and Submit/Cancel. On submit,
 * POSTs the token to /auth/token then re-runs whatever action triggered the
 * modal (onRetry) — that action's own auth-required handling reopens this
 * modal with an inline error if the token turns out to be bad/expired,
 * rather than this function needing to know what "success" looks like for
 * every possible caller.
 * @param {string} namespace
 * @param {() => (void|Promise<void>)} onRetry
 * @param {string} [initialError]
 */
function showTokenAuthModal(namespace, onRetry, initialError = "") {
  const overlay = document.querySelector(".token-auth-modal-overlay");
  overlay.innerHTML = "";

  const modal = document.createElement("div");
  modal.className = "token-auth-modal";
  modal.innerHTML = /* html */ `
    <div class="token-auth-modal-close-btn"><span>&times;</span></div>
    <div class="token-auth-modal-header">
      <h1>Access Token Required</h1>
      <p class="token-auth-modal-explainer">
        <code class="token-auth-modal-namespace"></code> is a protected namespace and requires an access token to browse or download.
        Get one from your Pelican federation administrator or token issuer, then paste it below.
      </p>
      <a class="token-auth-modal-docs-link" href="https://docs.pelicanplatform.org/getting-data-with-pelican/auth" target="_blank" rel="noopener noreferrer">
        <i class="fa fa-external-link"></i> How to get a token
      </a>
    </div>
    <input type="password" class="token-auth-modal-input" placeholder="Paste your access token" autocomplete="off" />
    <div class="token-auth-modal-error" style="display:none;"></div>
    <div class="token-auth-modal-actions">
      <div class="token-auth-modal-cancel">Cancel</div>
      <div class="token-auth-modal-submit">Submit</div>
    </div>
  `;
  // namespace set via textContent, not template interpolation, so a
  // namespace path can never be interpreted as HTML
  modal.querySelector(".token-auth-modal-namespace").textContent = namespace;

  overlay.appendChild(modal);
  overlay.classList.add("show");

  const closeBtn = modal.querySelector(".token-auth-modal-close-btn");
  const cancelBtn = modal.querySelector(".token-auth-modal-cancel");
  const submitBtn = modal.querySelector(".token-auth-modal-submit");
  const input = modal.querySelector(".token-auth-modal-input");
  const errorBox = modal.querySelector(".token-auth-modal-error");

  if (initialError) {
    errorBox.textContent = initialError;
    errorBox.style.display = "block";
  }

  function close() {
    overlay.classList.remove("show");
    overlay.innerHTML = "";
  }

  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);

  async function submit() {
    const token = input.value.trim();
    if (!token) {
      errorBox.textContent = "Paste a token first.";
      errorBox.style.display = "block";
      return;
    }
    errorBox.style.display = "none";
    submitBtn.classList.add("disabled");

    try {
      const response = await fetch(`${window.ROOT_PATH}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, token }),
      });
      const body = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !body.success) {
        errorBox.textContent = "Couldn't save the token. Try again.";
        errorBox.style.display = "block";
        submitBtn.classList.remove("disabled");
        return;
      }
    } catch (error) {
      console.log("saving token failed", error);
      errorBox.textContent = "Couldn't reach the server. Try again.";
      errorBox.style.display = "block";
      submitBtn.classList.remove("disabled");
      return;
    }

    close();
    await onRetry();
  }

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
}


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
  downloadLocationLabel.textContent = ` Downloading in Folder: ${downloadLocation}`;
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
    const newCard = document.createElement("div");
    newCard.className = "local-directory-cards";

    browseLocalDirectoryContainer.appendChild(newCard);
    newCard.innerHTML = `
            <i class="fa fa-folder-o"></i>
            <span class="local-directory-cards-label">${folder}</span>
        `;
    const newPath = `${path}/${folder}`;
    newCard.addEventListener("click", () => {
      console.log(path);
      makeLocalDirectoryCards(
        root,
        newPath,
        browseLocalDirectoryContainer,
        mediumLabel,
        downloadLocationLabel,
      );
    });
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

  const status = await pollDownloadJob(job.job_id);
  return await resolveDownloadAuth(status, job.history_id, fullPath, oodUrl);
}

/**
 * Polls /datasets/download/status/{jobId} until it reaches a terminal
 * status or DOWNLOAD_POLL_MAX_ATTEMPTS is hit. Split out of downloadFromPath
 * so resolveDownloadAuth below can reuse it for polling a restarted job too.
 * @param {string} jobId
 * @returns {Promise<Object>} the last job status payload received
 */
async function pollDownloadJob(jobId) {
  let status = { status: "pending" };
  for (let attempt = 0; attempt < DOWNLOAD_POLL_MAX_ATTEMPTS; attempt++) {
    if (DOWNLOAD_TERMINAL_STATUSES.includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_POLL_INTERVAL_MS));
    try {
      const response = await fetch(`${window.ROOT_PATH}/datasets/download/status/${jobId}`, { cache: "no-store" });
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
  return status;
}

/**
 * If a finished job has a file that failed because its namespace needs a
 * token (see the auth_required/namespace fields _run_download_job adds in
 * api/routes/downloads.py), shows the same token modal browsing uses and,
 * on submit, retries via the existing "restart failed files" endpoint
 * (POST /downloads/history/{id}/restart) rather than re-implementing
 * "retry only what failed" here. Recurses once on a second auth failure so
 * a bad/expired token reopens the modal with an inline error instead of
 * failing silently.
 * @param {Object} status - a terminal job status payload (has .files)
 * @param {number} [historyId] - from the job's history_id, needed to restart
 * @param {string} fullPath
 * @param {string} oodUrl
 * @param {boolean} [isRetry]
 * @returns {Promise<{succeeded: string[], failed: string[], destination: string, oodUrl: string}>}
 */
async function resolveDownloadAuth(status, historyId, fullPath, oodUrl, isRetry = false) {
  const files = status.files || [];
  const authFailure = files.find((f) => f.status !== "succeeded" && f.auth_required);

  if (authFailure && historyId) {
    return new Promise((resolve) => {
      showTokenAuthModal(
        authFailure.namespace,
        async () => {
          let restartedJobId;
          try {
            const response = await fetch(`${window.ROOT_PATH}/downloads/history/${historyId}/restart`, { method: "POST" });
            if (!response.ok) {
              throw new Error(`HTTP error! status ${response.status}`);
            }
            const restarted = await response.json();
            restartedJobId = restarted.job_id;
          } catch (error) {
            console.log("restarting download after token save failed", error);
            resolve(buildDownloadResult(status, fullPath, oodUrl));
            return;
          }
          const retryStatus = await pollDownloadJob(restartedJobId);
          resolve(await resolveDownloadAuth(retryStatus, historyId, fullPath, oodUrl, true));
        },
        isRetry ? "That token was rejected. Check it and try again." : "",
      );
    });
  }

  return buildDownloadResult(status, fullPath, oodUrl);
}

function buildDownloadResult(status, fullPath, oodUrl) {
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

async function fetchLocalDirectory(path) {
  try {
    const response = await fetch(
      `${window.ROOT_PATH}/datasets/local-browse/list-root?medium=${path}`,
    );
    if (!response.ok) {
      // backend already sends a specific reason (permission denied, folder
      // not found, unknown allocation) — surface that instead of a generic one
      let detail = `HTTP ERROR | STATUS CODE ${response.status}`;
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

function truncateDecimals(number, digits) {
  const multiplier = Math.pow(10, digits);
  return Math.trunc(number * multiplier) / multiplier;
}