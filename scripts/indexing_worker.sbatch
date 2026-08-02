#!/bin/bash
# Submits one cycle of the dataset-size indexing worker (indexing_worker.py).
# Submitted manually once to start the self-renewing chain; after that,
# indexing_worker.py resubmits this same script itself near the end of each
# cycle's walltime — see its _resubmit_self()/RENEWAL_MARGIN_MINUTES.
#
# I/O-bound (pelicanfs listing calls, one small sqlite write at the end),
# not CPU-bound — 1 core / 1-2GB is intentionally modest.
#SBATCH --job-name=pelican-ui-indexing
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=2G
#SBATCH --time=24:00:00
#SBATCH --account=x-cda090008
#SBATCH --output=/anvil/projects/x-cda090008/anvil_reu26_pj4/pelican-ui-shared/indexing_worker_%j.log

set -euo pipefail

# Same venv location passenger_wsgi.py uses for the web app itself, so this
# worker runs against the identical installed dependencies (pelicanfs,
# aiowebdav2, etc.) rather than risking a second, drifting environment.
APP_DIR="$HOME/ondemand/dev/pelican-ui"
VENV_PYTHON="$APP_DIR/.venv/bin/python"

cd "$APP_DIR"
exec "$VENV_PYTHON" scripts/indexing_worker.py
