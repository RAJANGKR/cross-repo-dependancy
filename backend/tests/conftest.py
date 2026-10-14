"""Pytest configuration and test isolation fixtures."""
import pytest

from app.core.config import settings


@pytest.fixture(autouse=True)
def _isolate_app_env(monkeypatch):
    """Ensure tests run in a predictable baseline environment unaffected by local developer .env files."""
    monkeypatch.setattr(settings, "GITHUB_APP_ID", "")
    monkeypatch.setattr(settings, "GITHUB_APP_SLUG", "")
    monkeypatch.setattr(settings, "GITHUB_APP_PRIVATE_KEY", "")
    monkeypatch.setattr(settings, "GITHUB_APP_PRIVATE_KEY_PATH", "")
