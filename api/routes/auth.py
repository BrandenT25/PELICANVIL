from fastapi import APIRouter
from pydantic import BaseModel
from api.core.tokens import has_token_for_namespace, save_token_for_namespace

authRouter = APIRouter()


class TokenSubmission(BaseModel):
    namespace: str
    token: str


@authRouter.post("/auth/token")
async def submitToken(payload: TokenSubmission):
    token = payload.token.strip()
    if not token:
        return {"success": False}
    save_token_for_namespace(payload.namespace, token)
    return {"success": True}


@authRouter.get("/auth/token/status")
async def tokenStatus(namespace: str):
    return {"has_token": has_token_for_namespace(namespace)}
