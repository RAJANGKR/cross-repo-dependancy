from datetime import datetime, timezone

from fastapi import APIRouter

from app.core.config import settings
from app.core.security import SUPPORTED_MANIFESTS

router = APIRouter()

APP_VERSION = "0.1.0"


def health_payload() -> dict:
    """Liveness plus which optional services are configured. Never includes a key."""
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "version": APP_VERSION,
        "environment": settings.APP_ENV,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "services": {
            "github_api": {"authenticated": bool(settings.GITHUB_TOKEN), "rate_limit_remaining": None},
            "gemini_api": {"configured": bool(settings.GEMINI_API_KEY), "model": settings.GEMINI_MODEL},
            "cache": {"type": "sqlite" if settings.CACHE_ENABLED else "disabled", "path": settings.CACHE_PATH if settings.CACHE_ENABLED else None},
        },
        "supported_manifests": list(SUPPORTED_MANIFESTS),
    }


@router.get("/health", tags=["Health"])
async def get_health():
    return health_payload()
