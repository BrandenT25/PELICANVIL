#!/bin/bash
# Submits one cycle of the dataset-size indexing worker (indexing_worker.py).
# Submitted manually once to start the self-renewing chain; after that,
# indexing_worker.py resubmits this same script itself near the end of each
# cycle's walltime — see its _resubmit_self()/RENEWAL_MARGIN_MINUTES.
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
#SBATCH --ntasks=64
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

cd "$APP_DIR"
# --bind "$APP_DIR":"$APP_DIR": the container must see this checkout at the
# *same* absolute path it has on the host — indexing_worker.py resolves
# SBATCH_SCRIPT via Path(__file__).resolve().parent for its own
# self-resubmission (_resubmit_self calls the host's real `sbatch` on that
# path), so a path mismatch between host and container would break that.
exec apptainer exec --bind "$APP_DIR":"$APP_DIR" --pwd "$APP_DIR" "$CONTAINER_IMAGE" \
    python scripts/indexing_worker.py
