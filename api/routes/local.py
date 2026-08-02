from fastapi import APIRouter, HTTPException
from typing import List, Dict
import os
import subprocess

USER = os.environ.get("USER")


def get_user_project_accounts(username, cluster="anvil"):
    """Query Slurm accounting for every project allocation a user belongs to."""
    try:
        result = subprocess.run(
            ["sacctmgr", "-np", "show", "assoc", "user={}".format(username), "cluster={}".format(cluster), "format=Account"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10,
        )
        if result.returncode != 0:
            return []
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []

    # Sub-account suffixes Slurm creates for queue-specific access, not
    # separate storage allocations — stripping them (and de-duping via the
    # set() below) collapses e.g. "x-foo" and "x-foo-gpu" into the one real
    # "x-foo" project entry, same as it always has for -gpu.
    # -ai is the counterpart for Anvil's separate "ai" partition — RCAC's
    # own docs confirm gpu and ai are documented as separate SU-allocated
    # queues, the same relationship -gpu already covers here, but unlike
    # -gpu this wasn't confirmed by actually running sacctmgr against a real
    # account showing one (no Anvil access from this environment) — treat
    # as a well-justified inference pending a quick real-world check, not
    # a tested fact like -gpu was.
    QUEUE_SUB_ACCOUNT_SUFFIXES = ("-gpu", "-ai")

    accounts = set()
    for line in result.stdout.splitlines():
        account = line.strip().rstrip("|")
        if not account or account == "root":
            continue
        for suffix in QUEUE_SUB_ACCOUNT_SUFFIXES:
            if account.endswith(suffix):
                account = account[: -len(suffix)]
                break
        accounts.add(account)
    return sorted(accounts)


def build_project_entries(username):
    entries = []
    for account in get_user_project_accounts(username):
        path = "/anvil/projects/x-{}".format(account)
        entries.append({
            "name": "x-{}".format(account),
            "path": path,
            "accessible": os.access(path, os.R_OK | os.X_OK),
        })
    return entries


PROJECT_ENTRIES = build_project_entries(USER)
SCRATCH_PATH = f"/anvil/scratch/{USER}/"
HOME_PATH = f"/home/{USER}/"

MEDIUMS = {
    "scratch": SCRATCH_PATH,
    "project": PROJECT_ENTRIES,
    "home": HOME_PATH,
}
NOISE_PREFIXES = ("interlink",)

localRouter = APIRouter()


@localRouter.get("/datasets/local-browse/list-root")
def browseStorageMedium(medium: str):
    pathParts = medium.split("/")

    if pathParts[0] == "project":
        if len(pathParts) >= 2:
            allocation = pathParts[1]
            entry = None
            for e in PROJECT_ENTRIES:
                if e["name"] == allocation:
                    entry = e
                    break

            if entry is None:
                raise HTTPException(status_code=404, detail="{} is not one of your allocations".format(allocation))
            if not entry["accessible"]:
                raise HTTPException(status_code=403, detail="You don't have permission to access {}".format(allocation))

            path = entry["path"] + "/"
            for part in pathParts[2:]:
                path += "{}/".format(part)

            try:
                entries = [
                    f for f in os.listdir(path)
                    if os.path.isdir(os.path.join(path, f)) and not f.startswith(NOISE_PREFIXES)
                ]
            except PermissionError:
                raise HTTPException(status_code=403, detail="You don't have permission to access this folder")
            except FileNotFoundError:
                raise HTTPException(status_code=404, detail="Folder not found")

            return [f for f in entries if not f.startswith('.')]

        return [{"name": e["name"], "accessible": e["accessible"]} for e in PROJECT_ENTRIES]

    else:
        root = MEDIUMS[pathParts[0]]
        path = f"{root}/"
        if len(pathParts) > 1:
            for part in pathParts[1:]:
                path += "{}/".format(part)

        try:
            entries = [f for f in os.listdir(path) if os.path.isdir(os.path.join(path, f))]
        except PermissionError:
            raise HTTPException(status_code=403, detail="You don't have permission to access this folder")
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Folder not found")

        return [f for f in entries if not f.startswith('.')]