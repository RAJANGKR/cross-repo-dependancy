import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_root_endpoint():
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert "/docs" in data["documentation"]


def test_health_endpoint():
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert len(data["supported_manifests"]) >= 3


def test_root_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["version"] == "0.1.0"
    assert len(data["supported_manifests"]) >= 3


def test_parse_file_endpoint():
    payload = {
        "filename": "package.json",
        "content": '{"dependencies": {"express": "^4.18.2"}}',
    }
    response = client.post("/api/v1/scan/parse-file", json=payload)
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 1
    assert items[0]["name"] == "express"
    assert items[0]["version_spec"] == "^4.18.2"


def test_compare_endpoint():
    payload = {
        "repositories": [
            {
                "name": "service-1",
                "files": [
                    {
                        "filename": "requirements.txt",
                        "content": "fastapi>=0.100.0\nrequests==2.31.0",
                    }
                ],
            },
            {
                "name": "service-2",
                "files": [
                    {
                        "filename": "requirements.txt",
                        "content": "fastapi>=0.110.0\nrequests==2.28.0",
                    }
                ],
            },
        ]
    }
    response = client.post("/api/v1/scan/compare", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["scanned_repos"] == ["service-1", "service-2"]
    assert data["total_unique_dependencies"] == 2
    assert data["drifted_dependencies_count"] == 2
    assert len(data["drift_matrix"]) == 2
