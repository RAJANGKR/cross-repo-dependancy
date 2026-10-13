import logging
import os
from typing import Any, Dict, List
from packaging.requirements import Requirement, InvalidRequirement
from packaging.utils import canonicalize_name

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib  # type: ignore
    except ImportError:
        tomllib = None

from app.parsers.base import BaseDependencyParser
from app.schemas.dependency import DependencyItem, DependencyType, Ecosystem

logger = logging.getLogger(__name__)


class PyprojectTomlParser(BaseDependencyParser):
    @property
    def ecosystem(self) -> Ecosystem:
        return Ecosystem.PYTHON

    def supports(self, filename: str) -> bool:
        base = os.path.basename(filename).lower()
        return base == "pyproject.toml"

    def parse(self, content: str, filename: str = "pyproject.toml") -> List[DependencyItem]:
        items: List[DependencyItem] = []
        if not content or not content.strip():
            return items

        if tomllib is None:
            logger.error("Neither tomllib nor tomli is installed. Cannot parse pyproject.toml.")
            return items

        try:
            data = tomllib.loads(content)
        except Exception as exc:
            logger.warning(f"Failed to parse TOML in {filename}: {exc}")
            return items

        if not isinstance(data, dict):
            return items

        # 1. PEP 621 Standard: [project.dependencies]
        project = data.get("project", {})
        if isinstance(project, dict):
            pep621_deps = project.get("dependencies", [])
            if isinstance(pep621_deps, list):
                for dep_str in pep621_deps:
                    item = self._parse_pep508_string(str(dep_str), DependencyType.RUNTIME, filename)
                    if item:
                        items.append(item)

            # PEP 621: [project.optional-dependencies]
            opt_deps = project.get("optional-dependencies", {})
            if isinstance(opt_deps, dict):
                for group_name, group_list in opt_deps.items():
                    dep_type = DependencyType.DEV if group_name.lower() in ["dev", "test", "lint"] else DependencyType.OPTIONAL
                    if isinstance(group_list, list):
                        for dep_str in group_list:
                            item = self._parse_pep508_string(str(dep_str), dep_type, filename)
                            if item:
                                items.append(item)

        # 2. Poetry Support: [tool.poetry.dependencies]
        poetry = data.get("tool", {}).get("poetry", {})
        if isinstance(poetry, dict):
            poetry_deps = poetry.get("dependencies", {})
            if isinstance(poetry_deps, dict):
                for pkg_name, version_spec in poetry_deps.items():
                    if pkg_name.lower() == "python":
                        continue
                    item = self._parse_poetry_entry(pkg_name, version_spec, DependencyType.RUNTIME, filename)
                    if item:
                        items.append(item)

            # [tool.poetry.dev-dependencies] (Poetry < 1.2)
            poetry_dev = poetry.get("dev-dependencies", {})
            if isinstance(poetry_dev, dict):
                for pkg_name, version_spec in poetry_dev.items():
                    item = self._parse_poetry_entry(pkg_name, version_spec, DependencyType.DEV, filename)
                    if item:
                        items.append(item)

            # [tool.poetry.group.<group>.dependencies] (Poetry >= 1.2)
            groups = poetry.get("group", {})
            if isinstance(groups, dict):
                for grp_name, grp_content in groups.items():
                    if isinstance(grp_content, dict):
                        grp_deps = grp_content.get("dependencies", {})
                        dep_type = DependencyType.DEV if grp_name.lower() in ["dev", "test", "lint"] else DependencyType.OPTIONAL
                        if isinstance(grp_deps, dict):
                            for pkg_name, version_spec in grp_deps.items():
                                item = self._parse_poetry_entry(pkg_name, version_spec, dep_type, filename)
                                if item:
                                    items.append(item)

        return items

    def _parse_pep508_string(self, dep_str: str, dep_type: DependencyType, filename: str) -> DependencyItem | None:
        try:
            req = Requirement(dep_str.strip())
            return DependencyItem(
                name=canonicalize_name(req.name),
                version_spec=str(req.specifier) if req.specifier else "*",
                ecosystem=self.ecosystem,
                dep_type=dep_type,
                source_file=filename,
                raw_spec=dep_str,
            )
        except InvalidRequirement:
            return None

    def _parse_poetry_entry(self, pkg_name: str, version_spec: Any, dep_type: DependencyType, filename: str) -> DependencyItem | None:
        if isinstance(version_spec, dict):
            ver = str(version_spec.get("version", "*")).strip()
        elif isinstance(version_spec, str):
            ver = version_spec.strip()
        else:
            ver = "*"

        return DependencyItem(
            name=canonicalize_name(pkg_name),
            version_spec=ver if ver else "*",
            ecosystem=self.ecosystem,
            dep_type=dep_type,
            source_file=filename,
            raw_spec=f"{pkg_name} = {version_spec}",
        )
