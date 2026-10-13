from typing import List
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from app.parsers.registry import default_registry
from app.schemas.dependency import DependencyItem, RepositoryFileInput, RepositoryInput
from app.schemas.drift import ComparisonRequest, ComparisonResult
from app.services.drift_engine import drift_engine

router = APIRouter()


@router.post("/compare", response_model=ComparisonResult, tags=["Scan"])
async def compare_repositories(request: ComparisonRequest) -> ComparisonResult:
    """
    Compare dependency manifests across multiple repositories or services.
    Returns detected cross-repository drift, severity breakdown, and harmonized version recommendations.
    """
    if not request.repositories:
        raise HTTPException(status_code=400, detail="At least one repository must be provided.")
    
    return drift_engine.analyze_repositories(request.repositories)


@router.post("/parse-file", response_model=List[DependencyItem], tags=["Scan"])
async def parse_manifest_file(file_input: RepositoryFileInput) -> List[DependencyItem]:
    """
    Parse a single dependency manifest (package.json, requirements.txt, or pyproject.toml)
    and return the extracted dependencies and version constraints.
    """
    parser = default_registry.get_parser(file_input.filename)
    if not parser:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format '{file_input.filename}'. Supported formats: package.json, requirements.txt, pyproject.toml",
        )
    return parser.parse(file_input.content, filename=file_input.filename)


@router.post("/upload-repo", response_model=ComparisonResult, tags=["Scan"])
async def upload_repo_files(
    repo_name: str = Form(..., description="Repository or service name"),
    files: List[UploadFile] = File(..., description="One or more dependency manifest files"),
) -> ComparisonResult:
    """
    Upload one or more manifest files for a repository (useful for direct file-input forms in the frontend).
    """
    parsed_files: List[RepositoryFileInput] = []
    for f in files:
        content_bytes = await f.read()
        try:
            content_str = content_bytes.decode("utf-8")
        except UnicodeDecodeError:
            content_str = content_bytes.decode("latin-1", errors="replace")
        parsed_files.append(RepositoryFileInput(filename=f.filename or "unknown", content=content_str))

    repo = RepositoryInput(name=repo_name, files=parsed_files)
    return drift_engine.analyze_repositories([repo])
