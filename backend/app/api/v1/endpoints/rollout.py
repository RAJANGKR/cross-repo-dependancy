from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.v1.endpoints.auth import current_user
from app.core.config import settings
from app.core.security import InvalidTarget
from app.schemas.rollout import RolloutRequest, RolloutResponse
from app.services import rollout_planner

router = APIRouter()


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error_code": code, "message": message, "details": {}})


@router.post("/rollout", tags=["Rollout"], response_model=None)
async def plan_rollout(request: RolloutRequest, http_request: Request):
    """Compare deployment order for one provider (P0 -> P1) and one consumer (C0 -> C1).

    A ref that cannot be fetched or a specification that cannot be parsed is not
    an HTTP error: the answer is still 200, with the affected states UNKNOWN and
    the reason listed under `unresolved`."""
    if settings.AUTH_REQUIRED and current_user(http_request) is None:
        return error(401, "SIGN_IN_REQUIRED", "Sign in with GitHub to analyze a rollout.")
    try:
        result = await rollout_planner.analyze(request)
    except InvalidTarget as invalid:
        return error(400, "INVALID_TARGETS", str(invalid))
    return RolloutResponse(**result).model_dump()
