"""In-memory scan job store. Records expire after SCAN_TTL_SECONDS."""
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from app.core.config import settings
from app.schemas.scan import ScanRecord


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ScanStore:
    def __init__(self, ttl_seconds: Optional[int] = None):
        self._lock = threading.Lock()
        self._records: Dict[str, ScanRecord] = {}
        self._started: Dict[str, float] = {}
        #: The signed-in user a scan of private repositories belongs to. Its results are readable by that user only.
        self._owners: Dict[str, str] = {}
        self._ttl = ttl_seconds if ttl_seconds is not None else settings.SCAN_TTL_SECONDS

    def create(self, owner: Optional[str] = None) -> ScanRecord:
        stamp = now_iso()
        record = ScanRecord(
            scan_id=f"scn_{uuid.uuid4().hex[:12]}",
            status="QUEUED",
            created_at=stamp,
            updated_at=stamp,
            progress={"stage": "QUEUED", "percentage": 0, "current_action": "Waiting to start"},
        )
        with self._lock:
            self._evict()
            self._records[record.scan_id] = record
            self._started[record.scan_id] = time.monotonic()
            if owner:
                self._owners[record.scan_id] = owner
        return record

    def owner(self, scan_id: str) -> Optional[str]:
        with self._lock:
            return self._owners.get(scan_id)

    def get(self, scan_id: str) -> Optional[ScanRecord]:
        with self._lock:
            self._evict()
            record = self._records.get(scan_id)
            return record.model_copy(deep=True) if record else None

    def progress(self, scan_id: str, stage: str, percentage: int, action: str) -> None:
        self._update(scan_id, status=stage, progress={"stage": stage, "percentage": percentage, "current_action": action})

    def complete(self, scan_id: str, result: Dict[str, Any]) -> None:
        self._finish(scan_id, status="COMPLETED", result=result, progress={"stage": "COMPLETED", "percentage": 100, "current_action": "Done"})

    def fail(self, scan_id: str, error_code: str, message: str) -> None:
        self._finish(scan_id, status="FAILED", error={"error_code": error_code, "message": message})

    def _finish(self, scan_id: str, **fields: Any) -> None:
        with self._lock:
            started = self._started.get(scan_id)
        duration = round(time.monotonic() - started, 2) if started is not None else None
        self._update(scan_id, completed_at=now_iso(), duration_seconds=duration, **fields)

    def _update(self, scan_id: str, **fields: Any) -> None:
        with self._lock:
            record = self._records.get(scan_id)
            if record is not None:
                self._records[scan_id] = record.model_copy(update={**fields, "updated_at": now_iso()})

    def _evict(self) -> None:
        cutoff = time.monotonic() - self._ttl
        for scan_id in [key for key, started in self._started.items() if started < cutoff]:
            self._records.pop(scan_id, None)
            self._started.pop(scan_id, None)
            self._owners.pop(scan_id, None)


scan_store = ScanStore()
