from fastapi import APIRouter
from pydantic import BaseModel
from api.core.pelican_auth import get_token_for_namespace, save_token_for_namespace

tokenAuthRouter = APIRouter()


class TokenSubmit(BaseModel):
    namespace: str
    token: str


@tokenAuthRouter.post("/auth/token")
async def submitToken(payload: TokenSubmit):
    token = payload.token.strip()
    if not token:
        return {"success": False}
    save_token_for_namespace(payload.namespace, token)
    return {"success": True}


@tokenAuthRouter.get("/auth/token/status")
async def tokenStatus(namespace: str):
    return {"has_token": get_token_for_namespace(namespace) is not None}
