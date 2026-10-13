from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class Ecosystem(str, Enum):
    NPM = "npm"
    PYTHON = "python"
    MAVEN = "maven"


class DependencyType(str, Enum):
    RUNTIME = "runtime"
    DEV = "dev"
    PEER = "peer"
    OPTIONAL = "optional"


class DependencyItem(BaseModel):
    name: str = Field(..., description="Normalized package name")
    version_spec: str = Field(..., description="Extracted version specification, e.g., '^18.2.0' or '>=0.100.0'")
    ecosystem: Ecosystem = Field(..., description="Target ecosystem: npm or python")
    dep_type: DependencyType = Field(default=DependencyType.RUNTIME, description="Dependency category")
    source_file: Optional[str] = Field(default="", description="Name of the file parsed")
    raw_spec: Optional[str] = Field(default=None, description="Original raw line or constraint string")


class RepositoryFileInput(BaseModel):
    filename: str = Field(..., description="File name (e.g., package.json, requirements.txt, pyproject.toml)")
    content: str = Field(..., description="Raw text content of the file")


class RepositoryInput(BaseModel):
    name: str = Field(..., description="Unique repository or microservice name")
    files: List[RepositoryFileInput] = Field(..., description="List of dependency manifest files")
