from fastapi import APIRouter
from app.core.config import settings

router = APIRouter()


@router.get("/health", tags=["Health"])
async def get_health():
    """Health check endpoint to verify backend status and version."""
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "environment": settings.APP_ENV,
        "supported_manifests": [
            "package.json (Node.js/npm)",
            "requirements.txt (Python)",
            "pyproject.toml (PEP 621 & Poetry)",
        ],
    }
