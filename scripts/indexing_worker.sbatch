#!/bin/bash
# Submits one cycle of the dataset-size indexing worker (indexing_worker.py).
# Submitted manually once to start the self-renewing chain; after that, THIS
# SCRIPT resubmits itself near the end of each cycle's walltime (see the
# RESUBMIT_EXIT_CODE check below), not indexing_worker.py directly — that
# script runs inside the Apptainer container (see CONTAINER_IMAGE below),
# which deliberately carries no `sbatch` binary, so it can't call `sbatch`
# itself any more (2026-08-24 incident: it tried, got FileNotFoundError,
# and the whole indexing chain silently stopped the next time a job hit its
# walltime). indexing_worker.py's RESUBMIT_EXIT_CODE/RENEWAL_MARGIN_MINUTES
# is what decides *when*; this script is what actually calls `sbatch`, since
# only the host (not the container) has that binary.
#
# I/O-bound (pelicanfs listing calls, batched sqlite writes to a staging
# table during the walk, one small finalize write at the end), not
# CPU-bound — 1 core is intentionally modest. Mem bumped from 2G to 4G as a
# safety margin on top of the streaming-writes fix in indexing_worker.py's
# _index_dataset (2026-08-03) — deep, huge datasets like GOES are the
# exception in this catalog, not the norm, so this is headroom, not a
# substitute for that fix.
#SBATCH --job-name=pelican-ui-indexing
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks=32
#SBATCH --cpus-per-task=1
# #SBATCH --mem=4G
#SBATCH --time=96:00:00
#SBATCH --account=cda090008
#SBATCH --output=/anvil/projects/x-cda090008/anvil_reu26_pj4/pelican-ui-shared/indexing_worker_%j.log
#SBATCH --error=/anvil/projects/x-cda090008/anvil_reu26_pj4/pelican-ui-shared/indexing_worker_%j.err

set -euo pipefail

# Resolved relative to this script's own location, not $HOME — sbatch
# copies/reads this file from wherever it's submitted, so this always
# points at the checkout it was actually submitted from, regardless of
# which account ran `sbatch`.
# APP_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
APP_DIR="$HOME/ondemand/dev/pelicanvil"

CONTAINER_IMAGE="/anvil/projects/x-cda090008/anvil_reu26_pj4/pelican-ui-shared/indexing_worker.sif"

# RESUBMIT_EXIT_CODE (indexing_worker.py) — the one exit code from the
# container run this script must inspect and handle itself, so it can't be
# under `set -e`. Everything before/after this block still is.
RESUBMIT_EXIT_CODE=75

cd "$APP_DIR"
set +e
# --bind "$APP_DIR":"$APP_DIR": the container must see this checkout at the
# *same* absolute path it has on the host — the queue/db paths
# (api/core/config.py's DB_PATH etc.) are absolute and shared with the
# non-containerized web app, so a path mismatch between host and container
# would have this job reading/writing a different location than intended.
apptainer exec --bind "$APP_DIR":"$APP_DIR" --pwd "$APP_DIR" "$CONTAINER_IMAGE" \
    python scripts/indexing_worker.py
exit_code=$?
set -e

if [ "$exit_code" -eq "$RESUBMIT_EXIT_CODE" ]; then
    # Resolved via $APP_DIR, not $0 — Slurm runs a batch script from a copy
    # in its own spool directory, so $0 there isn't reliably this repo's
    # actual scripts/indexing_worker.sbatch path.
    echo "Walltime approaching — resubmitting the next cycle."
    sbatch "$APP_DIR/scripts/indexing_worker.sbatch"
    exit 0
fi

exit "$exit_code"
