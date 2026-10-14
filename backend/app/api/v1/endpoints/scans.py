import json
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Query, Request
from fastapi.responses import JSONResponse

from app.api.v1.endpoints.auth import current_session, current_user
from app.core.config import settings
from app.core.security import InvalidTarget
from app.schemas.scan import ScanAccepted, ScanCreateRequest, ScanRecord
from app.services.github_app import AccessProblem
from app.services.repo_access import scan_credentials
from app.services.scan_runner import run_scan, validate_request
from app.services.scan_store import scan_store

router = APIRouter()
DEMO_PATH = Path(__file__).resolve().parents[4] / "demo" / "demo_scan.json"


def error(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error_code": code, "message": message, "details": details or {}})


@router.post("/scans", tags=["Scans"], status_code=202, response_model=None)
async def create_scan(request: ScanCreateRequest, background_tasks: BackgroundTasks, http_request: Request, wait: bool = Query(False)):
    """Queue a scan of 2 to 10 targets (GitHub URLs and pasted manifests can be mixed)."""
    if settings.AUTH_REQUIRED and current_user(http_request) is None:
        return error(401, "SIGN_IN_REQUIRED", "Sign in with GitHub to start a scan.")
    try:
        targets = validate_request(request)
    except InvalidTarget as invalid:
        return error(400, "INVALID_TARGETS", str(invalid), {"provided_targets_count": len(request.repository_targets)})

    # Access to private repositories is decided here, from the session, before anything is read.
    session_id, session, _ = current_session(http_request)
    try:
        credentials = await scan_credentials(session_id, session, [(t.owner, t.repo) for t in targets if t.kind == "github"])
    except AccessProblem as problem:
        return error(problem.status, problem.code, problem.message)
    # A scan that reads private repositories is readable by the user who started it, and no one else.
    owner = str(session.user.get("id") or session.user.get("login")) if credentials and session else None

    record = scan_store.create(owner=owner)
    if wait:
        await run_scan(record.scan_id, targets, request.options, scan_store, credentials=credentials)
        return JSONResponse(status_code=200, content=scan_store.get(record.scan_id).model_dump())
    background_tasks.add_task(run_scan, record.scan_id, targets, request.options, scan_store, credentials=credentials)
    return ScanAccepted(
        scan_id=record.scan_id,
        status=record.status,
        created_at=record.created_at,
        poll_url=f"/api/v1/scans/{record.scan_id}",
    )


@router.get("/scans/{scan_id}", tags=["Scans"], response_model=None)
async def get_scan(scan_id: str, http_request: Request):
    if settings.AUTH_REQUIRED and current_user(http_request) is None:
        return error(401, "SIGN_IN_REQUIRED", "Sign in with GitHub to read scan results.")
    record = scan_store.get(scan_id)
    owner = scan_store.owner(scan_id)
    user = current_user(http_request) if owner else None
    # Another user's private scan answers exactly like a scan that does not exist.
    if record is None or (owner and (user is None or str(user.get("id") or user.get("login")) != owner)):
        return error(404, "SCAN_NOT_FOUND", f"Scan with id '{scan_id[:40]}' does not exist or has expired.", {"scan_id": scan_id[:40]})
    return record


@router.get("/demo", tags=["Scans"], response_model=None)
async def get_demo():
    """A saved run of this backend. It is real output, replayed; the UI labels it as demo data."""
    try:
        return ScanRecord(**json.loads(DEMO_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return error(404, "DEMO_NOT_AVAILABLE", "No saved demo run is available on this backend.")
