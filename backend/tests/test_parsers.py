import pytest
from app.parsers.package_json import PackageJsonParser
from app.parsers.requirements_txt import RequirementsTxtParser
from app.parsers.pyproject_toml import PyprojectTomlParser
from app.schemas.dependency import DependencyType, Ecosystem


def test_package_json_parser_success():
    parser = PackageJsonParser()
    assert parser.supports("package.json")
    assert not parser.supports("requirements.txt")

    content = """{
        "name": "my-service",
        "dependencies": {
            "react": "^18.2.0",
            "axios": "~1.6.0"
        },
        "devDependencies": {
            "typescript": "^5.0.0"
        },
        "peerDependencies": {
            "react-dom": "^18.2.0"
        }
    }"""

    items = parser.parse(content, "package.json")
    assert len(items) == 4

    names = {i.name: (i.version_spec, i.dep_type) for i in items}
    assert names["react"] == ("^18.2.0", DependencyType.RUNTIME)
    assert names["axios"] == ("~1.6.0", DependencyType.RUNTIME)
    assert names["typescript"] == ("^5.0.0", DependencyType.DEV)
    assert names["react-dom"] == ("^18.2.0", DependencyType.PEER)
    assert all(i.ecosystem == Ecosystem.NPM for i in items)


def test_package_json_parser_malformed():
    parser = PackageJsonParser()
    assert parser.parse("", "package.json") == []
    assert parser.parse("invalid-json", "package.json") == []


def test_requirements_txt_parser():
    parser = RequirementsTxtParser()
    assert parser.supports("requirements.txt")
    assert parser.supports("requirements-dev.txt")

    content = """
    # Primary web framework
    fastapi>=0.110.0
    uvicorn[standard]>=0.28.0 # web server
    requests==2.31.0
    pytest~=8.0.0

    # Flags to ignore
    -r base.txt
    -i https://pypi.org/simple
    --extra-index-url https://custom.repo/pypi
    """

    items = parser.parse(content, "requirements.txt")
    assert len(items) == 4

    name_map = {i.name: i.version_spec for i in items}
    assert "fastapi" in name_map
    assert "uvicorn" in name_map
    assert "requests" in name_map
    assert "pytest" in name_map
    assert name_map["requests"] == "==2.31.0"
    assert all(i.ecosystem == Ecosystem.PYTHON for i in items)


def test_pyproject_toml_parser_pep621():
    parser = PyprojectTomlParser()
    assert parser.supports("pyproject.toml")

    content = """
    [project]
    name = "driftlock"
    version = "0.1.0"
    dependencies = [
        "fastapi>=0.110.0",
        "pydantic>=2.6.0",
    ]

    [project.optional-dependencies]
    dev = [
        "pytest>=8.0.0",
        "ruff>=0.3.0"
    ]
    """

    items = parser.parse(content, "pyproject.toml")
    assert len(items) == 4
    names = {i.name: i.dep_type for i in items}
    assert names["fastapi"] == DependencyType.RUNTIME
    assert names["pydantic"] == DependencyType.RUNTIME
    assert names["pytest"] == DependencyType.DEV
    assert names["ruff"] == DependencyType.DEV


def test_pyproject_toml_parser_poetry():
    parser = PyprojectTomlParser()

    content = """
    [tool.poetry]
    name = "poetry-service"
    version = "1.0.0"

    [tool.poetry.dependencies]
    python = "^3.10"
    flask = "^3.0.0"
    sqlalchemy = { version = "^2.0.0", optional = true }

    [tool.poetry.group.dev.dependencies]
    black = "^24.0.0"
    """

    items = parser.parse(content, "pyproject.toml")
    # python itself is filtered out
    names = {i.name: (i.version_spec, i.dep_type) for i in items}
    assert "flask" in names
    assert names["flask"] == ("^3.0.0", DependencyType.RUNTIME)
    assert names["sqlalchemy"] == ("^2.0.0", DependencyType.RUNTIME)
    assert names["black"] == ("^24.0.0", DependencyType.DEV)
