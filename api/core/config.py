import os

DB_PATH = "/anvil/projects/x-cda090008/anvil_reu26_pj4/pelican-ui-shared/pelican.db"
#DB_PATH = "/anvil/scratch/x-bturner/pelican.db"

# Per-user local downloads history — deliberately separate from DB_PATH above.
# DB_PATH is a single shared, multi-user, admin-managed database; this one is
# single-user/local to whichever account is running this deployment, so it
# lives under that user's home directory instead of the shared project path.
DOWNLOADS_DB_PATH = os.path.join(os.path.expanduser("~"), ".pelican-ui", "downloads_history.db")

# Shared, catalog-wide indexing queue/history for the admin-triggered
# dataset-size Slurm worker (scripts/indexing_worker.py). Deliberately next
# to DB_PATH, not any user's $HOME like DOWNLOADS_DB_PATH above — every PUN
# process needs to see and append to the same queue, and so does the single
# shared worker, unlike per-user download history or per-user auth tokens.
INDEXING_QUEUE_PATH = os.path.join(os.path.dirname(DB_PATH), "indexing_queue.json")
