from enum import Enum
from typing import Dict, List, Optional
from datetime import datetime
from pydantic import BaseModel, Field

from app.schemas.dependency import Ecosystem, RepositoryInput


class DriftSeverity(str, Enum):
    CRITICAL = "CRITICAL"    # Major version disparity (breaking changes likely)
    WARNING = "WARNING"      # Minor or patch version divergence
    INFO = "INFO"            # Present in some repos, absent in others (not necessarily an error)
    IN_SYNC = "IN_SYNC"      # Consistent version constraints across all repositories


class DependencyDriftReport(BaseModel):
    dependency_name: str = Field(..., description="Package name")
    ecosystem: Ecosystem = Field(..., description="Ecosystem (npm or python)")
    versions_by_repo: Dict[str, str] = Field(..., description="Mapping of repo_name -> version constraint")
    present_in_repos: List[str] = Field(default_factory=list, description="Repositories where this package is declared")
    missing_in_repos: List[str] = Field(default_factory=list, description="Repositories where this package is missing")
    severity: DriftSeverity = Field(..., description="Calculated drift severity")
    is_drifted: bool = Field(..., description="True if versions diverge or severity is not IN_SYNC")
    recommended_version: Optional[str] = Field(default=None, description="Recommended unified version target")
    drift_summary: str = Field(..., description="Human-readable explanation of the drift status")


class ComparisonRequest(BaseModel):
    repositories: List[RepositoryInput] = Field(
        ...,
        min_length=1,
        description="List of repositories or services to scan and cross-compare"
    )


class ComparisonResult(BaseModel):
    scanned_repos: List[str] = Field(..., description="Names of analyzed repositories")
    total_unique_dependencies: int = Field(..., description="Total unique package names evaluated")
    drifted_dependencies_count: int = Field(..., description="Count of packages with detected drift")
    in_sync_count: int = Field(..., description="Count of packages that are completely aligned")
    severity_breakdown: Dict[str, int] = Field(..., description="Counts grouped by severity")
    drift_matrix: List[DependencyDriftReport] = Field(..., description="Detailed drift status per dependency")
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
