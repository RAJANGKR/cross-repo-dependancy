import json
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Query
from fastapi.responses import JSONResponse

from app.core.security import InvalidTarget
from app.schemas.scan import ScanAccepted, ScanCreateRequest, ScanRecord
from app.services.scan_runner import run_scan, validate_request
from app.services.scan_store import scan_store

router = APIRouter()
DEMO_PATH = Path(__file__).resolve().parents[4] / "demo" / "demo_scan.json"


def error(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error_code": code, "message": message, "details": details or {}})


@router.post("/scans", tags=["Scans"], status_code=202, response_model=None)
async def create_scan(request: ScanCreateRequest, background_tasks: BackgroundTasks, wait: bool = Query(False)):
    """Queue a scan of 2 to 10 targets (GitHub URLs and pasted manifests can be mixed)."""
    try:
        targets = validate_request(request)
    except InvalidTarget as invalid:
        return error(400, "INVALID_TARGETS", str(invalid), {"provided_targets_count": len(request.repository_targets)})

    record = scan_store.create()
    if wait:
        await run_scan(record.scan_id, targets, request.options, scan_store)
        return JSONResponse(status_code=200, content=scan_store.get(record.scan_id).model_dump())
    background_tasks.add_task(run_scan, record.scan_id, targets, request.options, scan_store)
    return ScanAccepted(
        scan_id=record.scan_id,
        status=record.status,
        created_at=record.created_at,
        poll_url=f"/api/v1/scans/{record.scan_id}",
    )


@router.get("/scans/{scan_id}", tags=["Scans"], response_model=None)
async def get_scan(scan_id: str):
    record = scan_store.get(scan_id)
    if record is None:
        return error(404, "SCAN_NOT_FOUND", f"Scan with id '{scan_id[:40]}' does not exist or has expired.", {"scan_id": scan_id[:40]})
    return record


@router.get("/demo", tags=["Scans"], response_model=None)
async def get_demo():
    """A saved run of this backend. It is real output, replayed; the UI labels it as demo data."""
    try:
        return ScanRecord(**json.loads(DEMO_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return error(404, "DEMO_NOT_AVAILABLE", "No saved demo run is available on this backend.")
