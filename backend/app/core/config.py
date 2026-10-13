from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "DriftLock Backend"
    APP_ENV: str = "development"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:5174,http://localhost:3000,http://127.0.0.1:5173"

    # Optional upstream credentials. Read from backend/.env, never logged.
    GITHUB_TOKEN: str = ""
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.1-flash-lite"

    # Sign in with GitHub (OAuth app). Optional: leave empty to run without sign-in.
    GITHUB_OAUTH_CLIENT_ID: str = ""
    GITHUB_OAUTH_CLIENT_SECRET: str = ""
    # Signs session cookies. If empty, a random one is used and sessions end on restart.
    SESSION_SECRET: str = ""
    # Sign-in is optional by default. Set to true to refuse scans from signed-out callers.
    AUTH_REQUIRED: bool = False

    # SQLite cache for public upstream data only (never pasted content).
    CACHE_ENABLED: bool = True
    CACHE_PATH: str = "driftlock_cache.db"
    CACHE_TTL_SECONDS: int = 86400

    HTTP_TIMEOUT_SECONDS: float = 15.0
    HTTP_RETRIES: int = 2
    MIN_TARGETS: int = 2
    MAX_TARGETS: int = 10
    MAX_PASTED_FILE_BYTES: int = 200 * 1024
    MAX_MANIFEST_BYTES: int = 6 * 1024 * 1024
    MAX_MANIFESTS_PER_REPO: int = 40
    MAX_SPEC_BYTES: int = 2 * 1024 * 1024
    MAX_SPECS_PER_REPO: int = 4
    MAX_ZIP_BYTES: int = 30 * 1024 * 1024
    MAX_SOURCE_FILE_BYTES: int = 400 * 1024
    MAX_CHANGELOG_BYTES: int = 600 * 1024
    SCAN_TTL_SECONDS: int = 7200
    REPO_CONCURRENCY: int = 4
    LIBRARY_CONCURRENCY: int = 6

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_origins_list(self) -> List[str]:
        if isinstance(self.CORS_ORIGINS, str):
            return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]
        return ["*"]


settings = Settings()
