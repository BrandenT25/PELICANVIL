import os
import sys
import site

venv_site = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '.venv/lib/python3.11/site-packages'
)
site.addsitedir(venv_site)

sys.path.insert(0, venv_site)

from main import app
from a2wsgi import ASGIMiddleware
application = ASGIMiddleware(app)
