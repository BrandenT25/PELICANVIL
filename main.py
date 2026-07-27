from fastapi import FastAPI, Request, HTTPException
import os
from datetime import date
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from api.routes.dataset import datasetRouter, buildCatalog
from api.routes.pelican import pelicanRouter
from api.routes.local import localRouter
from api.routes.database import dbRouter
from api.routes.downloads import downloadsRouter

from api.auth import is_authorized

USER = os.environ.get("USER")


app = FastAPI()
app.include_router(datasetRouter)
app.include_router(pelicanRouter)
app.include_router(localRouter)
app.include_router(dbRouter)
app.include_router(downloadsRouter)

app.mount("/api/static", StaticFiles(directory="api/static"), name="static")
templates = Jinja2Templates(directory="api/templates")




@app.get('/datasets', response_class=HTMLResponse)
async def dataset_page(request: Request):
    return templates.TemplateResponse(request,'categories.html', {"ROOT_URL": request.scope.get('root_path', '')})

@app.get('/', response_class=HTMLResponse)
async def main_page(request: Request):
    # dataset_count/category_count/category_names come from the same
    # dataset<->category tag matching /datasets/catalog already exposes —
    # two small SELECT * queries, cheap enough to run on every homepage
    # load. If the dataset table grows large enough for this to matter,
    # revisit once the separate local-indexing/caching item is built.
    catalog = buildCatalog()
    return templates.TemplateResponse(request, "index.html", {
        "ROOT_URL": request.scope.get('root_path', ''),
        "dataset_count": catalog["dataset_count"],
        "category_count": catalog["category_count"],
        "category_names": catalog["category_names"],
        "today": date.today().strftime("%B %d, %Y"),
    })

@app.get('/quick-access', response_class=HTMLResponse)
async def main_page(request: Request):
    return templates.TemplateResponse(request, "quick-access.html", {"ROOT_URL": request.scope.get('root_path', ''),  "USER": USER})

@app.get('/about', response_class=HTMLResponse)
async def main_page(request: Request):
    return templates.TemplateResponse(request, "about.html", {"ROOT_URL": request.scope.get('root_path', '')})

@app.get('/documentation', response_class=HTMLResponse)
async def documentation_page(request: Request):
    return templates.TemplateResponse(request, "docs.html", {"ROOT_URL": request.scope.get('root_path', '')})

@app.get('/datasets/search', response_class=HTMLResponse)
async def dataset_search_page(request: Request):
    return templates.TemplateResponse(request, "datasets.html", {"ROOT_URL": request.scope.get('root_path', ''), "CATEGORY": "", "USER": USER})

@app.get('/datasets/category/{category}')
async def category_page(category, request: Request):
    return templates.TemplateResponse(request, "datasets.html", {"ROOT_URL": request.scope.get('root_path', ''), "CATEGORY": category, "USER": USER})

@app.get('/admin', response_class=HTMLResponse)
async def admin_page(request: Request):
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    return templates.TemplateResponse(request, "admin.html", {"ROOT_URL": request.scope.get('root_path', ''),  "USER": USER})

@app.get('/downloads', response_class=HTMLResponse)
async def downloads_page(request: Request):
    return templates.TemplateResponse(request, "downloads.html", {"ROOT_URL": request.scope.get('root_path', '')})