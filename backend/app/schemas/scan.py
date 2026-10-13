"""Request and record models for the scan API. The `result` payload is built
as plain JSON by scan_runner.py to match frontend/src/api/scanTypes.ts."""
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

SCAN_STATUSES = ("QUEUED", "FETCHING", "PARSING", "ANALYZING", "COMPLETED", "FAILED")


class PastedFile(BaseModel):
    filename: str
    content: str


class RepositoryTarget(BaseModel):
    type: Literal["github", "pasted"] = "github"
    url: Optional[str] = None
    ref: Optional[str] = None
    name: Optional[str] = None
    files: List[PastedFile] = Field(default_factory=list)


class ScanOptions(BaseModel):
    check_changelogs: bool = True
    check_vulnerabilities: bool = True
    scan_code: bool = True
    ecosystems: List[str] = Field(default_factory=lambda: ["npm", "python", "maven"])


class ScanCreateRequest(BaseModel):
    repository_targets: List[RepositoryTarget]
    options: ScanOptions = Field(default_factory=ScanOptions)


class ScanAccepted(BaseModel):
    scan_id: str
    status: str
    created_at: str
    poll_url: str
    message: str = "Scan job initiated. Poll the poll_url for progress updates."


class ScanRecord(BaseModel):
    scan_id: str
    status: str
    created_at: str
    updated_at: str
    completed_at: Optional[str] = None
    duration_seconds: Optional[float] = None
    progress: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[Dict[str, str]] = None
