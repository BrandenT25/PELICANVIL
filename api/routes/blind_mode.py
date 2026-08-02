from fastapi import APIRouter, HTTPException
import os

from api.auth import is_authorized
from api.core.blind_mode import is_blind_mode, set_blind_mode

blindModeRouter = APIRouter()
USER = os.environ.get("USER", "")


@blindModeRouter.get("/admin/blind-mode/status")
async def blindModeStatus():
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    return {"enabled": is_blind_mode()}


@blindModeRouter.post("/admin/blind-mode/toggle")
async def toggleBlindMode():
    # Same auth gate as every other /admin/* route (api/routes/database.py,
    # api/routes/indexing.py) — this endpoint carries no destination-page
    # data of its own, it just flips the flag api.core.blind_mode reads;
    # actually rendering blind mode happens via main.py's context processor
    # on the next page load, not here.
    if not is_authorized(USER):
        raise HTTPException(status_code=403, detail="Not Authorized")
    set_blind_mode(not is_blind_mode())
    return {"enabled": is_blind_mode()}
