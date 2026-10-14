from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.v1.endpoints.auth import current_user
from app.core.config import settings
from app.schemas.assistant import AssistantChatRequest, AssistantChatResponse
from app.services import assistant

router = APIRouter()


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error_code": code, "message": message, "details": {}})


@router.post("/assistant/chat", tags=["Assistant"], response_model=None)
async def chat(request: AssistantChatRequest, http_request: Request):
    """Answer one question about the results the dashboard is showing.

    The answer is built from the scan result and rollout analysis in the
    request and from nothing else. When Gemini is not configured or does not
    answer, the response is still 200: a rule-based summary of the same
    results, with `source` "fallback" and the reason in `notice`."""
    if settings.AUTH_REQUIRED and current_user(http_request) is None:
        return error(401, "SIGN_IN_REQUIRED", "Sign in with GitHub to use the assistant.")
    length = http_request.headers.get("content-length", "")
    if length.isdigit() and int(length) > settings.ASSISTANT_MAX_REQUEST_BYTES:
        return error(413, "CONTEXT_TOO_LARGE", "The results sent with this question are too large for the assistant.")
    return AssistantChatResponse(**await assistant.answer(request)).model_dump()
