import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.api.v1.endpoints.health import health_payload
from app.api.v1.router import api_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("driftlock")

app = FastAPI(
    title=settings.APP_NAME,
    description="Cross-repository dependency drift detection for npm, Python and Maven manifests.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS configuration to enable seamless communication with React/Vite frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list if settings.cors_origins_list != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/", tags=["Root"])
async def root():
    return {
        "name": settings.APP_NAME,
        "status": "online",
        "documentation": "/docs",
        "api_v1": "/api/v1",
    }


@app.get("/health", tags=["Health"])
async def health():
    return health_payload()


@app.exception_handler(RequestValidationError)
async def validation_error(_request, exc: RequestValidationError):
    """Malformed bodies answer in the contract's error shape. The body itself is never echoed or logged."""
    fields = ", ".join(sorted({".".join(str(part) for part in err.get("loc", [])[1:]) for err in exc.errors()}))[:300]
    return JSONResponse(status_code=400, content={"error_code": "INVALID_REQUEST", "message": f"The request body is not valid: {fields}", "details": {}})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
    )
