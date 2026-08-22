// setInterval handles for every dataset card currently polling its index
// status, mirroring downloads.js's activePollHandles — without this,
// rebuilding datasetWrapper's innerHTML on every displayDataset(true) call
// would leak intervals still firing against now-detached card elements.
let activeIndexPollHandles = []

// Mirrors api/core/category_icons.py's MAX_ICON_BYTES — shown in the
// upload field's label so the size limit isn't a surprise only discovered
// after a failed upload. Kept as a literal (not fetched from the backend)
// since this project has no shared frontend/backend config channel and a
// KB label is cosmetic, not a real client-side enforcement point — the
// backend route is still the actual source of truth/validation.
const MAX_ICON_KB = 512

// Same fallback glyph as api/static/js/categories.js's
// CATEGORY_ICON_FALLBACK (duplicated rather than shared — see that file's
// own comment on why) — shown for editCategory's existing-icon preview
// when a category has no uploaded icon yet.
const CATEGORY_ICON_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='18' height='18' rx='3'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpath d='M21 15l-5-5L5 21'/%3E%3C/svg%3E"

async function displayDataset(toggle){

    if(toggle === true){
        activeIndexPollHandles.forEach(clearInterval)
        activeIndexPollHandles = []
        datasetSelectionButton.classList.add("active")
        datasetWrapper.innerHTML = /* html */ `
            <div class="searchbar-wrapper">
                <input class="admin-search-input" placeholder="Search Datasets by Name"></input>
            </div>
            <div class="card-wrapper">
                <div class="card" id="add-card">
                    <span class="add-card-plus">+</span>
                    <span class="add-card-text">Add Dataset</span>
                </div>
            </div>
        `
        const cardWrapper = datasetWrapper.querySelector(".card-wrapper")
        datasetWrapper.classList.add("show")
        datasets =  await fetchDatasets()
        datasets.forEach((dataset) => {
            const datasetCard = document.createElement("div")
            datasetCard.className = "card"

            dataset.name = dataset["name"]
            dataset.description = dataset["description"]
            dataset.path = dataset["path"]
            dataset.format = dataset["format"]
            dataset.stramable = dataset["streamable"]
            dataset.access = dataset["access"]
            dataset.tags = dataset["tags"]
            datasetCard.id = dataset["id"]

            datasetCard.innerHTML = /* html */ `
                <div class="text-wrapper">
                    <span class="datasetName">${dataset["name"]}</span>
                    <span class="datasetDescription">${dataset["path"]}</span>
                    <div class="index-status-line">
                        <span class="index-status-badge"></span>
                        <span class="staged-tag" style="display:none"></span>
                    </div>
                    <span class="index-status-reason"></span>
                </div>
                <div class="modify-wrapper">
                    <i class="fa fa-stop-circle" id="cancel-index-btn" title="Cancel indexing" style="display:none"></i>
                    <i class="fa fa-refresh" id="reindex-btn" title="Re-index dataset size"></i>
                    <i class="fa fa-edit" id="modify-btn"></i>
                    <i class="fa fa-trash" id="remove-btn"></i>
                </div>

            `
            const modifybtn = datasetCard.querySelector("#modify-btn")
            const removeBtn = datasetCard.querySelector("#remove-btn")
            const reindexBtn = datasetCard.querySelector("#reindex-btn")
            const cancelIndexBtn = datasetCard.querySelector("#cancel-index-btn")
            modifybtn.addEventListener("click", async () =>{
                editDataset(dataset)
                displayDataset(true)
            })
            removeBtn.addEventListener("click", async ()=>{
                const result = await removeDataset(datasetCard.id)
                if (!result.ok) {
                    showToast(result.error, "error")
                    return
                }
                showToast(`"${dataset.name}" deleted.`, "success")
                displayDataset(true)

            })
            reindexBtn.addEventListener("click", async () => {
                reindexBtn.classList.add("disabled")
                const result = await triggerReindex(dataset.id)
                if (!result.ok) {
                    showToast(result.error, "error")
                    reindexBtn.classList.remove("disabled")
                    return
                }
                showToast(`Re-indexing "${dataset.name}" queued.`, "success")
                refreshIndexStatus(datasetCard, dataset.id)
            })
            cancelIndexBtn.addEventListener("click", async () => {
                // Destructive-ish against real in-progress work — a simple
                // confirm is enough per this feature's own scope, no need
                // for a full modal like the delete-dataset flow uses.
                if (!confirm(`Cancel indexing for "${dataset.name}"? Progress so far will be kept and resumed on the next re-index.`)) {
                    return
                }
                cancelIndexBtn.classList.add("disabled")
                const result = await cancelIndexing(dataset.id)
                if (!result.ok) {
                    showToast(result.error, "error")
                    cancelIndexBtn.classList.remove("disabled")
                    return
                }
                showToast(`Cancelling "${dataset.name}"…`, "success")
                // Reuses the exact same status-poll refresh the Re-index
                // button already triggers — the worker notices the cancel
                // flag within roughly one folder's latency (see
                // scripts/indexing_worker.py's IndexingCancelled), so the
                // badge is likely still "Indexing…" for a moment; the
                // existing 3s poll (already running, since the status is
                // still in_progress) picks up the transition to
                // "cancelled" on its own, same as it would for any other
                // status change — no new polling logic needed here.
                refreshIndexStatus(datasetCard, dataset.id)
            })
            cardWrapper.appendChild(datasetCard)
            refreshIndexStatus(datasetCard, dataset.id)
        })
        const addDatasetCard = datasetWrapper.querySelector("#add-card")
        addDatasetCard.addEventListener("click", () =>{
            addDataset()
        })

        return
    }
    datasetWrapper.classList.remove("show")
    datasetSelectionButton.classList.remove("active")
}

async function displayCategory(toggle){
    if(toggle === true){
        categorySelectionButton.classList.add("active")
        categoryWrapper.innerHTML = /* html */ `
            <div class="searchbar-wrapper">
                <input class="admin-search-input" placeholder="Search Categories by Name"></input>
            </div>
            <div class="card-wrapper">
                <div class="card" id="add-card">

                    <span class="add-card-plus">+</span>
                    <span class="add-card-text">Add Category</span>
                </div>
            </div>
        `
        categoryWrapper.classList.add("show")
        const cardWrapper = categoryWrapper.querySelector(".card-wrapper")
        categories =  await fetchCategories()
        categories.forEach((category) => {
            const categoryCard = document.createElement("div")
            categoryCard.className = "card"

            category.name = category["name"]
            category.description = category["description"]
            category.urlSlug = category["url"]
            category.imgPath = category["icon"]
  

            categoryCard.innerHTML = /* html */ `
                <div class="text-wrapper">
                    <span class="datasetName">${category["name"]}</span>
                    <span class="datasetDescription">${category["url"]}</span>
                </div>
                <div class="modify-wrapper">
                    <i class="fa fa-edit" id="modify-btn"></i>
                    <i class="fa fa-trash" id="remove-btn"></i>
                </div>

            `
            const modifybtn = categoryCard.querySelector("#modify-btn")
            const removeBtn = categoryCard.querySelector("#remove-btn")
            modifybtn.addEventListener("click", async () =>{
                editCategory(category)
                displayCategory(true)
            })
            removeBtn.addEventListener("click", async ()=>{
                const result = await removeCategory(category.urlSlug)
                if (!result.ok) {
                    showToast(result.error, "error")
                    return
                }
                showToast(`"${category.name}" deleted.`, "success")
                displayCategory(true)

            })
            cardWrapper.appendChild(categoryCard)
        })





        const addCategoryCard = categoryWrapper.querySelector("#add-card")
        addCategoryCard.addEventListener("click", () => {
            console.log("test")
            addCategory()
        })
        return
    }
    categoryWrapper.classList.remove("show")
    categorySelectionButton.classList.remove("active")

}

async function displayAuthorizedUsers(toggle){
    if(toggle === true){
        authorizedUsersSelectionButton.classList.add("active")
        authorizedUsersWrapper.innerHTML = /* html */ `
            <div class="searchbar-wrapper">
                <input class="admin-search-input" placeholder="Search Authorized Users by Name"></input>
            </div>
            <div class="card-wrapper">
                <div class="card" id="add-card">
                    <span class="add-card-plus">+</span>
                    <span class="add-card-text">Add User</span>
                </div>
            </div>
            `
        const cardWrapper = authorizedUsersWrapper.querySelector(".card-wrapper")
        const users = await fetchUsers()
        users.forEach((user) => {
            const userCard = document.createElement("div")
            userCard.className = "card"

            userCard.name = user["name"]

            userCard.innerHTML = /* html */ `
                <div class="text-wrapper">
                    <span class="datasetName">${user["name"]}</span>
                </div>
                <div class="modify-wrapper">
                    <i class="fa fa-trash" id="remove-btn"></i>
                </div>
                `


            const removeBtn = userCard.querySelector("#remove-btn")
            removeBtn.addEventListener("click", async ()=>{
                const result = await removeUser(userCard.name)
                if (!result.ok) {
                    showToast(result.error, "error")
                    return
                }
                showToast(`"${userCard.name}" removed.`, "success")
                displayAuthorizedUsers(true)

            })
            cardWrapper.appendChild(userCard)
            })

        const addUserCard = authorizedUsersWrapper.querySelector("#add-card")
        addUserCard.addEventListener("click", () => {
            addUser()
            console.log("Test")
        })
        authorizedUsersWrapper.classList.add("show")
        return
    }
    authorizedUsersWrapper.classList.remove("show")
    authorizedUsersSelectionButton.classList.remove("active")
}

const datasetWrapper = document.querySelector(".dataset-wrapper")
const categoryWrapper = document.querySelector(".category-wrapper")
const authorizedUsersWrapper = document.querySelector(".user-authorization-wrapper")

const datasetSelectionButton = document.querySelector("#dataset-selection")
const categorySelectionButton = document.querySelector("#category-selection")
const authorizedUsersSelectionButton = document.querySelector("#auth-users-selection")

datasetSelectionButton.addEventListener("click", () =>{
    displayDataset(true)
    displayCategory(false)
    displayAuthorizedUsers(false)
})

categorySelectionButton.addEventListener("click", () =>{
    displayDataset(false)
    displayCategory(true)
    displayAuthorizedUsers(false)
})

authorizedUsersSelectionButton.addEventListener("click", () =>{
    displayDataset(false)
    displayCategory(false)
    displayAuthorizedUsers(true)
})

function editCategory(originalCategory){
    const overlay = document.querySelector(".modal-overlay")
    overlay.innerHTML = /* html */ `
        <div class="add-dataset-modal">
            <div class="add-dataset-close-btn">
                <span>&times;</span>
            </div>
            <div class="add-dataset-header-wrapper">
                <span>Edit Category</span>
            </div>
            <div class="header-split"></div>
            <div class="add-dataset-inputs-wrapper">
                <div class="form-field">
                    <label for="category-name">Name</label>
                    <input type="text" id="category-name">
                </div>

                <div class="form-field">
                    <label for="category-description">Description</label>
                    <textarea id="category-description"></textarea>
                </div>

                <div class="form-field">
                    <label for="url-slug">URL slug</label>
                    <input type="text" id="url-slug">
                </div>

                <div class="form-field">
                    <label for="category-icon">Icon (PNG, JPEG, WEBP, or SVG — max ${MAX_ICON_KB} KB)</label>
                    <img id="category-icon-preview" class="category-icon-preview" alt="Current icon" src="${window.ROOT_PATH}/categories/${originalCategory.url}/icon" onerror="this.onerror=null;this.src=CATEGORY_ICON_FALLBACK;">
                    <input type="file" id="category-icon" accept="image/png,image/jpeg,image/webp,image/svg+xml">
                </div>

            </div>
            <div class="submit-btn-wrapper">
                <div class="submit-btn"><span>Submit</span></div>
            </div>
        </div>
    `

    document.querySelector('#category-name').value = originalCategory.name
    document.querySelector('#category-description').value = originalCategory.description
    document.querySelector('#url-slug').value = originalCategory.url

    const iconInput = document.querySelector('#category-icon')
    const iconPreview = document.querySelector('#category-icon-preview')
    iconInput.addEventListener("change", () => {
        const file = iconInput.files[0]
        if (file) iconPreview.src = URL.createObjectURL(file)
    })

    const closeBtn = document.querySelector(".add-dataset-close-btn")
    const submitButton = document.querySelector(".submit-btn")

    submitButton.addEventListener("click", async () => {
        const category = {
            name: document.querySelector('#category-name').value,
            description: document.querySelector('#category-description').value,
            url: document.querySelector('#url-slug').value,
        }
        const result = await submitCategoryChange(category, originalCategory.url)
        if (!result.ok) {
            showToast(result.error, "error")
            return
        }
        // Icon upload is a separate call (see uploadCategoryIcon) — only
        // fired if the admin actually picked a new file; a category-only
        // edit shouldn't touch the existing icon at all. Failure here
        // doesn't roll back the category save above (already committed) —
        // reported as its own toast so it's clear which half didn't land.
        const file = iconInput.files[0]
        if (file) {
            const iconResult = await uploadCategoryIcon(category.url, file)
            if (!iconResult.ok) {
                showToast(`Category saved, but icon upload failed: ${iconResult.error}`, "error")
                toggleOverlay(false)
                displayCategory(true)
                return
            }
        }
        showToast(`Category "${category.name}" updated.`, "success")
        toggleOverlay(false)
        displayCategory(true)
    })

    closeBtn.addEventListener("click", () => {
        toggleOverlay(false)
    })

    toggleOverlay(true)
}


function editDataset(originalDataset){
    const overlay = document.querySelector(".modal-overlay")
    overlay.innerHTML = /* html */ `
        <div class="add-dataset-modal">
            <div class="add-dataset-close-btn">
                <span>&times;</span>
            </div>
            <div class="add-dataset-header-wrapper">
                <span>Edit Dataset</span>
            </div>
            <div class="header-split"></div>
            <div class="add-dataset-inputs-wrapper">
                <div class="form-field">
                    <label for="dataset-name">Name</label>
                    <input type="text" id="dataset-name">
                </div>

                <div class="form-field">
                    <label for="dataset-description">Description</label>
                    <textarea id="dataset-description"></textarea>
                </div>

                <div class="form-field">
                    <label for="dataset-path">Path</label>
                    <input type="text" id="dataset-path">
                </div>

                <div class="form-field">
                    <label for="dataset-format">Format</label>
                    <input type="text" id="dataset-format">
                </div>

                <div class="form-field">
                    <label for="dataset-access">Access</label>
                    <input type="text" id="dataset-access">
                </div>
                <div class="form-field">
                    <label>Categories</label>
                    <div class="category-checklist" id="dataset-tags">
    
                    </div>
                </div>
                <div class="form-field checkbox-field">
                    <input type="checkbox" id="dataset-streamable">
                    <label for="dataset-streamable">Streamable</label>
                </div>
            </div>
            <div class="submit-btn-wrapper">
                <div class="submit-btn"><span>Submit</span></div>
            </div>
        </div>
    `
    


    document.querySelector('#dataset-name').value = originalDataset.name
    document.querySelector('#dataset-description').value = originalDataset.description
    document.querySelector('#dataset-path').value = originalDataset.path
    document.querySelector('#dataset-format').value = originalDataset.format
    document.querySelector('#dataset-access').value = originalDataset.access
    document.querySelector('#dataset-streamable').checked = originalDataset.streamable
    populateCategoryDropdown().then(() => {
        document.querySelectorAll('#dataset-tags input[type="checkbox"]').forEach(checkbox => {
            if (originalDataset.tags.includes(checkbox.value)) {
                checkbox.checked = true
            }
        })
    })
    const closeBtn = document.querySelector(".add-dataset-close-btn")
    const submitButton = document.querySelector(".submit-btn")
    submitButton.addEventListener("click", async () =>{
        const tags = Array.from(document.querySelectorAll('#dataset-tags input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
        const dataset = {
        name: document.querySelector('#dataset-name').value,
        description: document.querySelector('#dataset-description').value,
        path: document.querySelector('#dataset-path').value,
        format: document.querySelector('#dataset-format').value,
        streamable: document.querySelector('#dataset-streamable').checked,
        access: document.querySelector('#dataset-access').value,
        tags: tags
    }
        const result = await submitDatasetChange(dataset, originalDataset.id)
        if (!result.ok) {
            showToast(result.error, "error")
            return
        }
        showToast(`Dataset "${dataset.name}" updated.`, "success")
        toggleOverlay(false)
        displayDataset(true)
    })
    closeBtn.addEventListener("click", () =>{
        toggleOverlay(false)
    })


    toggleOverlay(true)
}

function addDataset(){
    const overlay = document.querySelector(".modal-overlay")
    overlay.innerHTML = /* html */ `
        <div class="add-dataset-modal">
            <div class="add-dataset-close-btn">
                <span>&times;</span>
            </div>
            <div class="add-dataset-header-wrapper">
                <span>Add Dataset</span>
            </div>
            <div class="header-split"></div>
            <div class="add-dataset-inputs-wrapper">
                <div class="form-field">
                    <label for="dataset-name">Name</label>
                    <input type="text" id="dataset-name">
                </div>

                <div class="form-field">
                    <label for="dataset-description">Description</label>
                    <textarea id="dataset-description"></textarea>
                </div>

                <div class="form-field">
                    <label for="dataset-path">Path</label>
                    <input type="text" id="dataset-path">
                </div>

                <div class="form-field">
                    <label for="dataset-format">Format</label>
                    <input type="text" id="dataset-format">
                </div>

                <div class="form-field">
                    <label for="dataset-access">Access</label>
                    <input type="text" id="dataset-access">
                </div>
                <div class="form-field">
                    <label>Categories</label>
                    <div class="category-checklist" id="dataset-tags">
    
                    </div>
                </div>
                <div class="form-field checkbox-field">
                    <input type="checkbox" id="dataset-streamable">
                    <label for="dataset-streamable">Streamable</label>
                </div>
            </div>
            <div class="submit-btn-wrapper">
                <div class="submit-btn"><span>Submit</span></div>
            </div>
        </div>
    `
    populateCategoryDropdown() 
   
    const closeBtn = document.querySelector(".add-dataset-close-btn")
    const submitButton = document.querySelector(".submit-btn")
    submitButton.addEventListener("click", async () =>{
        const tags = Array.from(document.querySelectorAll('#dataset-tags input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
        const dataset = {
        name: document.querySelector('#dataset-name').value,
        description: document.querySelector('#dataset-description').value,
        path: document.querySelector('#dataset-path').value,
        format: document.querySelector('#dataset-format').value,
        streamable: document.querySelector('#dataset-streamable').checked,
        access: document.querySelector('#dataset-access').value,
        tags: tags
    }
        const result = await submitDataset(dataset)
        if (!result.ok) {
            showToast(result.error, "error")
            return
        }
        showToast(`Dataset "${dataset.name}" added.`, "success")
        toggleOverlay(false)
        displayDataset(true)
        displayCategory(false)
        displayAuthorizedUsers(false)
    })
    closeBtn.addEventListener("click", () =>{
        toggleOverlay(false)
    })


    toggleOverlay(true)
}

function addCategory(){
    const overlay = document.querySelector(".modal-overlay")
    overlay.innerHTML = /* html */ `
        <div class="add-dataset-modal">
            <div class="add-dataset-close-btn">
                <span>&times;</span>
            </div>
            <div class="add-dataset-header-wrapper">
                <span>Add Category</span>
            </div>
            <div class="header-split"></div>
            <div class="add-dataset-inputs-wrapper">
                <div class="form-field">
                    <label for="category-name">Name</label>
                    <input type="text" id="category-name">
                </div>

                <div class="form-field">
                    <label for="category-description">Description</label>
                    <textarea id="category-description"></textarea>
                </div>

                <div class="form-field">
                    <label for="url-slug">URL SLUG</label>
                    <input type="text" id="url-slug">
                </div>

                <div class="form-field">
                    <label for="category-icon">Icon (PNG, JPEG, WEBP, or SVG — max ${MAX_ICON_KB} KB)</label>
                    <input type="file" id="category-icon" accept="image/png,image/jpeg,image/webp,image/svg+xml">
                </div>

            </div>
            <div class="submit-btn-wrapper">
                <div class="submit-btn"><span>Submit</span></div>
            </div>
        </div>
    `
    populateCategoryDropdown()
    const closeBtn = document.querySelector(".add-dataset-close-btn")
    const submitButton = document.querySelector(".submit-btn")
    const iconInput = document.querySelector('#category-icon')
    submitButton.addEventListener("click", async () =>{
        const category = {
        name: document.querySelector('#category-name').value,
        description: document.querySelector('#category-description').value,
        url: document.querySelector('#url-slug').value,
    }
        const result = await submitCategory(category)
        if (!result.ok) {
            showToast(result.error, "error")
            return
        }
        // See editCategory's own comment on why this is a separate call —
        // same reasoning applies to a brand-new category.
        const file = iconInput.files[0]
        if (file) {
            const iconResult = await uploadCategoryIcon(category.url, file)
            if (!iconResult.ok) {
                showToast(`Category added, but icon upload failed: ${iconResult.error}`, "error")
                toggleOverlay(false)
                displayCategory(true)
                return
            }
        }
        showToast(`Category "${category.name}" added.`, "success")
        toggleOverlay(false)
        displayCategory(true)

    })
    closeBtn.addEventListener("click", () =>{
        toggleOverlay(false)
    })


    toggleOverlay(true)
}

function addUser(){
    const overlay = document.querySelector(".modal-overlay")
    overlay.innerHTML = /* html */ `
        <div class="add-user-modal">
            <div class="add-dataset-close-btn">
                <span>&times;</span>
            </div>
            <div class="add-user-header-wrapper">
                <span>Add User</span>
            </div>
            <div class="header-split"></div>
            <div class="add-user-inputs-wrapper">
                <div class="form-field">
                    <label for="user-name">Name</label>
                    <input type="text" id="user-name">
                </div>
            </div>

              
            <div class="submit-btn-wrapper">
                <div class="submit-btn"><span>Submit</span></div>
            </div>
        </div>
    `
    const closeBtn = document.querySelector(".add-dataset-close-btn")
    const submitButton = document.querySelector(".submit-btn")
    submitButton.addEventListener("click", async () =>{
        const name = overlay.querySelector('#user-name').value
        const result = await submitUser(name)
        if (!result.ok) {
            showToast(result.error, "error")
            return
        }
        showToast(`"${name}" added as an authorized user.`, "success")
        toggleOverlay(false)
        displayAuthorizedUsers(true)
    })

    closeBtn.addEventListener("click", () =>{
        toggleOverlay(false)
    })


    toggleOverlay(true)
}

/**
 * Single shared fetch wrapper for every admin mutation/read below — reads
 * the JSON body either way so a failed request can surface the backend's
 * specific `detail` message (validation error, duplicate name, etc.)
 * instead of a generic "something went wrong."
 * @returns {Promise<{ok: boolean, data: any, error: string|null}>}
 */
async function adminRequest(url, options){
    try{
        const response = await fetch(url, options)
        let data = null
        try{ data = await response.json() }catch(_){}
        if(!response.ok){
            const detail = (data && data.detail) ? data.detail : `Request failed (status ${response.status}).`
            return { ok: false, data, error: detail }
        }
        return { ok: true, data, error: null }
    }catch(error){
        console.log(error)
        return { ok: false, data: null, error: "Couldn't reach the server. Check your connection and try again." }
    }
}

async function fetchDatasets(){
    const result = await adminRequest(`${window.ROOT_PATH}/retrieve-datasets`)
    if(!result.ok){
        showToast(result.error, "error")
        return []
    }
    return result.data
}

async function fetchCategories(){
    const result = await adminRequest(`${window.ROOT_PATH}/retrieve-categories`)
    if(!result.ok){
        showToast(result.error, "error")
        return []
    }
    return result.data
}

async function fetchUsers(){
    const result = await adminRequest(`${window.ROOT_PATH}/admin/retrieve-users`)
    if(!result.ok){
        showToast(result.error, "error")
        return []
    }
    return result.data
}

async function submitUser(user){
    return adminRequest(`${window.ROOT_PATH}/admin/add-user?user=${encodeURIComponent(user)}`, {
        method: "POST",
    })
}
async function removeUser(user){
    return adminRequest(`${window.ROOT_PATH}/admin/remove-user?user=${encodeURIComponent(user)}`, {
        method: "POST",
    })
}

document.addEventListener("DOMContentLoaded", (event) => {
    displayDataset(true);
    initBlindModeToggle();
})

/**
 * Wires the small, unlabeled corner switch (see .admin-misc-toggle in
 * admin.css) to POST /admin/blind-mode/toggle. No confirmation dialog, no
 * toast beyond a brief one — this is meant to be quick to flip on/off
 * repeatedly while taking screenshots, not a deliberate one-time action
 * like the dataset/category mutations elsewhere on this page.
 */
function initBlindModeToggle(){
    const input = document.querySelector(".admin-misc-toggle-input")
    if (!input) return
    input.addEventListener("change", async () => {
        const result = await adminRequest(`${window.ROOT_PATH}/admin/blind-mode/toggle`, { method: "POST" })
        if (!result.ok) {
            showToast(result.error, "error")
            input.checked = !input.checked
            return
        }
        showToast(result.data.enabled ? "Blind mode on." : "Blind mode off.", "success", 2500)
    })
}

function toggleOverlay(toggle){
    const overlay = document.querySelector(".modal-overlay")
    if(toggle === true){
        overlay.classList.add("show")
        return
    }
    overlay.classList.remove("show")
    overlay.innerHTML = ``
}

async function populateCategoryDropdown(){
    const categories = await fetchCategories();
    const container = document.querySelector('#dataset-tags');

    container.innerHTML = '';

    categories.forEach(category => {
        const row = document.createElement('div');
        row.className = 'category-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = category.url;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = category.name;

        row.appendChild(checkbox);
        row.appendChild(nameSpan);


        row.addEventListener('click', (e) => {
            if (e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }
        });

        container.appendChild(row);
    });
}

async function submitDataset(dataset){
    return adminRequest(`${window.ROOT_PATH}/admin/add-dataset`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(dataset),
    })
}

async function removeDataset(id){
    return adminRequest(`${window.ROOT_PATH}/admin/remove-dataset?dataset_id=${id}`, {
        method: "POST",
    })
}

async function submitDatasetChange(dataset, id){
    return adminRequest(`${window.ROOT_PATH}/admin/modify-dataset?dataset_id=${id}`, {
        method: "POST",
        headers: {
            "Content-Type" : "application/json"
        },
        body: JSON.stringify(dataset)
    })
}

async function submitCategory(category){
    return adminRequest(`${window.ROOT_PATH}/admin/add-category`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(category),
    })
}
async function removeCategory(url){
    return adminRequest(`${window.ROOT_PATH}/admin/remove-category?category_url=${encodeURIComponent(url)}`, {
        method: "POST",
    })
}

async function uploadCategoryIcon(url, file){
    // Raw file body with its own Content-Type, not multipart/form-data —
    // matches api/routes/database.py's uploadCategoryIcon, which reads the
    // request body directly rather than requiring the python-multipart
    // dependency FastAPI's File()/UploadFile() need. Browsers can POST a
    // File object directly as fetch's body.
    return adminRequest(`${window.ROOT_PATH}/admin/categories/${encodeURIComponent(url)}/icon`, {
        method: "POST",
        headers: {
            "Content-Type": file.type
        },
        body: file,
    })
}

const INDEX_STATUS_LABELS = {
    never_indexed: "Not indexed",
    queued: "Queued",
    in_progress: "Indexing…",
    complete: "Indexed",
    failed: "Index failed",
    cancelled: "Cancelled",
}
// Only these two are worth polling — everything else is a resting state
// until the manual Re-index button or auto-enqueue-on-create fires again.
const INDEX_POLLING_STATUSES = ["queued", "in_progress"]
const INDEX_STATUS_POLL_INTERVAL_MS = 3000

async function fetchIndexStatus(datasetId){
    return adminRequest(`${window.ROOT_PATH}/admin/datasets/${datasetId}/index-status`)
}

async function triggerReindex(datasetId){
    return adminRequest(`${window.ROOT_PATH}/admin/datasets/${datasetId}/reindex`, {
        method: "POST",
    })
}

async function cancelIndexing(datasetId){
    return adminRequest(`${window.ROOT_PATH}/admin/datasets/${datasetId}/cancel-index`, {
        method: "POST",
    })
}

/**
 * Renders the status badge on one dataset card and, for the two "still
 * working" statuses, starts polling (same shape as downloads.js's
 * startCardPolling/stopCardPolling for the downloads-tab progress
 * indicators) until it reaches a resting state.
 * @param {HTMLElement} datasetCard
 * @param {number} datasetId
 */
// "still running" and "stuck" used to be visually indistinguishable — this
// just formats the gap between the queue entry's own started_at (already
// returned by GET /admin/datasets/{id}/index-status, see
// api/core/indexing_queue.py's get_queue_status) and now. Minutes/hours
// only, not seconds — this is meant to answer "has this been running for a
// suspiciously long time," not to be a stopwatch.
function formatElapsed(startedAtIso){
    if (!startedAtIso) return ""
    const startedMs = new Date(startedAtIso).getTime()
    if (Number.isNaN(startedMs)) return ""
    const elapsedMin = Math.max(0, Math.round((Date.now() - startedMs) / 60000))
    if (elapsedMin < 1) return "just started"
    if (elapsedMin < 60) return `${elapsedMin}m elapsed`
    const hours = Math.floor(elapsedMin / 60)
    const minutes = elapsedMin % 60
    return `${hours}h ${minutes}m elapsed`
}

function renderIndexBadge(datasetCard, status){
    const badge = datasetCard.querySelector(".index-status-badge")
    if (!badge) return
    const reason = datasetCard.querySelector(".index-status-reason")
    // The worker (scripts/indexing_worker.py) discovers folder structure by
    // walking it — there's no total folder count known upfront, only a
    // running count of how many have been visited so far (folders_done,
    // already returned by GET /admin/datasets/{id}/index-status). So this
    // shows real progress ("340 folders scanned for this run") rather than
    // a fabricated "340/812" or percentage — an honest count, not invented
    // precision. "for this run" is explicit because folders_done resets to
    // 0 on every fresh claim (claim_next_pending) — the cumulative total
    // across every attempt lives in the separate .staged-tag pill below,
    // not this number.
    if (status.status === "in_progress" && typeof status.folders_done === "number") {
        const elapsed = formatElapsed(status.started_at)
        badge.textContent = `${INDEX_STATUS_LABELS.in_progress} ${status.folders_done} folder${status.folders_done === 1 ? "" : "s"} scanned for this run${elapsed ? ` · ${elapsed}` : ""}`
    } else {
        badge.textContent = INDEX_STATUS_LABELS[status.status] || status.status
    }
    badge.className = `index-status-badge index-status-badge-${status.status}`
    badge.title = status.status === "failed" && status.error_message ? status.error_message : ""
    // Visible, not hover-only — a native title tooltip was the whole gap
    // this was added to fix (2026-08-04): the real reason was already
    // there, just invisible until a user thought to hover. Mirrors the
    // Downloads page's same-purpose inline error text
    // (.downloads-entry-file-error-text in downloads.js/downloads.css).
    if (reason) {
        reason.textContent = status.status === "failed" && status.error_message
            ? status.error_message
            : ""
        reason.style.display = reason.textContent ? "" : "none"
    }
    // Separate pill (not folded into the status badge's own text), but kept
    // on the same visual line via CSS (.index-status-line, a row flexbox in
    // admin.css) rather than stacked below — the two numbers read as one
    // fact ("here's where this dataset's indexing stands"), not two.
    //
    // staged_count is the cumulative folder-row total in
    // dataset_folder_sizes_staging across every attempt ever made on this
    // dataset (crashed/restarted runs included), and it already INCLUDES
    // this run's own progress — walk() in scripts/indexing_worker.py
    // increments folders_done for every folder touched this run, whether
    // newly walked or resumed-from-staging (staged_size() cache hit), and
    // every newly-walked folder is itself written into that same staging
    // table as it completes. So staged_count is always >= folders_done; the
    // badge's own "for this run" wording above is what disambiguates the
    // two numbers, so this pill just states the cumulative fact plainly.
    // Shown for queued/in_progress/complete (the statuses get_queue_status()
    // computes/carries a staged_count for) and only when nonzero — for
    // complete specifically, staged_count is the finished walk's own final
    // folders_done, the same total that ended up in dataset_folder_sizes.
    const stagedTag = datasetCard.querySelector(".staged-tag")
    if (stagedTag) {
        if (typeof status.staged_count === "number" && status.staged_count > 0) {
            stagedTag.textContent = `${status.staged_count.toLocaleString()} folder${status.staged_count === 1 ? "" : "s"} already indexed`
            stagedTag.style.display = ""
        } else {
            stagedTag.textContent = ""
            stagedTag.style.display = "none"
        }
    }
    // Cancel only ever makes sense against a dataset that's actually
    // running right now — see this feature's own out-of-scope note (no
    // cancelling a queued-but-not-started or already-resting entry). Only
    // the visibility is driven from here (this function runs on every
    // poll tick and is the one place that knows the *current* status);
    // the "disabled" class deliberately isn't touched here — the click
    // handler manages that itself (disables on click, re-enables only on
    // a failed request), so a successful cancel stays disabled for the
    // ~1-folder-latency window until the badge actually leaves
    // in_progress and the button disappears, instead of re-enabling and
    // inviting a redundant second click on every 3s poll in between.
    const cancelBtn = datasetCard.querySelector("#cancel-index-btn")
    if (cancelBtn) {
        cancelBtn.style.display = status.status === "in_progress" ? "" : "none"
    }
}

function stopIndexPolling(datasetCard){
    if (datasetCard._indexPollHandle) {
        clearInterval(datasetCard._indexPollHandle)
        activeIndexPollHandles = activeIndexPollHandles.filter((h) => h !== datasetCard._indexPollHandle)
        datasetCard._indexPollHandle = null
    }
}

/**
 * Fetches this dataset's current index status once, renders the badge, and
 * — only if not already polling — starts a steady interval for as long as
 * the status stays "queued"/"in_progress", stopping itself once it reaches
 * a resting state. Safe to call repeatedly (e.g. right after the Re-index
 * button fires) without stacking duplicate intervals.
 * @param {HTMLElement} datasetCard
 * @param {number} datasetId
 */
async function refreshIndexStatus(datasetCard, datasetId){
    const result = await fetchIndexStatus(datasetId)
    if (!result.ok) {
        renderIndexBadge(datasetCard, { status: "never_indexed" })
        return
    }
    renderIndexBadge(datasetCard, result.data)
    if (!INDEX_POLLING_STATUSES.includes(result.data.status)) {
        stopIndexPolling(datasetCard)
        return
    }
    if (datasetCard._indexPollHandle) return
    datasetCard._indexPollHandle = setInterval(async () => {
        const polled = await fetchIndexStatus(datasetId)
        if (!polled.ok) return
        renderIndexBadge(datasetCard, polled.data)
        if (!INDEX_POLLING_STATUSES.includes(polled.data.status)) {
            stopIndexPolling(datasetCard)
        }
    }, INDEX_STATUS_POLL_INTERVAL_MS)
    activeIndexPollHandles.push(datasetCard._indexPollHandle)
}

async function submitCategoryChange(category, url){
    return adminRequest(`${window.ROOT_PATH}/admin/modify-category?category_url=${encodeURIComponent(url)}`, {
        method: "POST",
        headers: {
            "Content-Type" : "application/json"
        },
        body: JSON.stringify(category)
    })
}