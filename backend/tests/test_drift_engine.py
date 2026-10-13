import pytest
from app.schemas.dependency import RepositoryFileInput, RepositoryInput
from app.schemas.drift import DriftSeverity
from app.services.drift_engine import DriftEngine


def test_drift_engine_major_mismatch():
    engine = DriftEngine()

    repo_a = RepositoryInput(
        name="web-client",
        files=[
            RepositoryFileInput(
                filename="package.json",
                content='{"dependencies": {"react": "^18.2.0", "axios": "^1.6.0"}}',
            )
        ],
    )
    repo_b = RepositoryInput(
        name="admin-dashboard",
        files=[
            RepositoryFileInput(
                filename="package.json",
                content='{"dependencies": {"react": "^17.0.2", "axios": "^1.6.0"}}',
            )
        ],
    )

    result = engine.analyze_repositories([repo_a, repo_b])

    assert result.total_unique_dependencies == 2
    assert result.drifted_dependencies_count == 1
    assert result.severity_breakdown[DriftSeverity.CRITICAL.value] == 1
    assert result.severity_breakdown[DriftSeverity.IN_SYNC.value] == 1

    react_report = next(r for r in result.drift_matrix if r.dependency_name == "react")
    assert react_report.severity == DriftSeverity.CRITICAL
    assert react_report.is_drifted is True
    assert react_report.recommended_version == "^18.2.0"

    axios_report = next(r for r in result.drift_matrix if r.dependency_name == "axios")
    assert axios_report.severity == DriftSeverity.IN_SYNC
    assert axios_report.is_drifted is False


def test_drift_engine_python_requirements_comparison():
    engine = DriftEngine()

    service_a = RepositoryInput(
        name="auth-service",
        files=[
            RepositoryFileInput(
                filename="requirements.txt",
                content="fastapi>=0.110.0\npydantic==2.6.0\nredis>=5.0.0",
            )
        ],
    )
    service_b = RepositoryInput(
        name="billing-service",
        files=[
            RepositoryFileInput(
                filename="requirements.txt",
                content="fastapi>=0.100.0\npydantic==2.6.0\ncelery>=5.3.0",
            )
        ],
    )

    result = engine.analyze_repositories([service_a, service_b])

    # fastapi has minor version diff (0.110 vs 0.100) -> WARNING
    fastapi_rep = next(r for r in result.drift_matrix if r.dependency_name == "fastapi")
    assert fastapi_rep.severity == DriftSeverity.WARNING
    assert fastapi_rep.is_drifted is True

    # pydantic is identical (2.6.0) -> IN_SYNC
    pydantic_rep = next(r for r in result.drift_matrix if r.dependency_name == "pydantic")
    assert pydantic_rep.severity == DriftSeverity.IN_SYNC

    # redis only in auth-service, celery only in billing-service -> INFO
    redis_rep = next(r for r in result.drift_matrix if r.dependency_name == "redis")
    assert redis_rep.severity == DriftSeverity.INFO
    assert "billing-service" in redis_rep.missing_in_repos
