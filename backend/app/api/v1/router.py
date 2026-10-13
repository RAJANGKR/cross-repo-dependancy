from fastapi import APIRouter
from app.api.v1.endpoints import auth, health, scan, scans

api_router = APIRouter()

api_router.include_router(health.router, prefix="", tags=["Health"])
api_router.include_router(scan.router, prefix="/scan", tags=["Scan"])
api_router.include_router(scans.router, prefix="")
api_router.include_router(auth.router, prefix="")
