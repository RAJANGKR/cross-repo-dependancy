from collections import defaultdict
from typing import Dict, List, Set, Tuple
from app.parsers.registry import default_registry
from app.schemas.dependency import DependencyItem, Ecosystem, RepositoryInput
from app.schemas.drift import (
    ComparisonResult,
    DependencyDriftReport,
    DriftSeverity,
)
from app.services.version_service import VersionService


class DriftEngine:
    def __init__(self, parser_registry=default_registry):
        self.parser_registry = parser_registry

    def analyze_repositories(self, repositories: List[RepositoryInput]) -> ComparisonResult:
        repo_names = [r.name for r in repositories]

        # Structure: (package_name, ecosystem) -> { repo_name: version_spec }
        dep_map: Dict[Tuple[str, Ecosystem], Dict[str, str]] = defaultdict(dict)
        # Structure: (package_name, ecosystem) -> Set[repo_name]
        dep_repos: Dict[Tuple[str, Ecosystem], Set[str]] = defaultdict(set)

        for repo in repositories:
            for file_entry in repo.files:
                parsed_items: List[DependencyItem] = self.parser_registry.parse_file(
                    file_entry.filename,
                    file_entry.content,
                )
                for item in parsed_items:
                    key = (item.name, item.ecosystem)
                    # If repo defines the same dependency in multiple files, keep first or most specific
                    if repo.name not in dep_map[key]:
                        dep_map[key][repo.name] = item.version_spec
                    dep_repos[key].add(repo.name)

        matrix: List[DependencyDriftReport] = []
        severity_counts: Dict[str, int] = {
            DriftSeverity.CRITICAL.value: 0,
            DriftSeverity.WARNING.value: 0,
            DriftSeverity.INFO.value: 0,
            DriftSeverity.IN_SYNC.value: 0,
        }

        drifted_count = 0
        in_sync_count = 0

        # Evaluate each unique dependency
        for (pkg_name, ecosystem), repo_versions in dep_map.items():
            present = sorted(list(dep_repos[(pkg_name, ecosystem)]))
            missing = sorted([r for r in repo_names if r not in repo_versions])

            severity, is_drifted, recommended, summary = VersionService.evaluate_drift(
                ecosystem=ecosystem,
                versions_by_repo=repo_versions,
                all_repo_names=repo_names,
            )

            severity_counts[severity.value] += 1
            if is_drifted:
                drifted_count += 1
            if severity == DriftSeverity.IN_SYNC:
                in_sync_count += 1

            matrix.append(
                DependencyDriftReport(
                    dependency_name=pkg_name,
                    ecosystem=ecosystem,
                    versions_by_repo=repo_versions,
                    present_in_repos=present,
                    missing_in_repos=missing,
                    severity=severity,
                    is_drifted=is_drifted,
                    recommended_version=recommended,
                    drift_summary=summary,
                )
            )

        # Priority sorting: CRITICAL -> WARNING -> INFO -> IN_SYNC, then alphabetical
        severity_order = {
            DriftSeverity.CRITICAL: 0,
            DriftSeverity.WARNING: 1,
            DriftSeverity.INFO: 2,
            DriftSeverity.IN_SYNC: 3,
        }
        matrix.sort(key=lambda r: (severity_order.get(r.severity, 99), r.dependency_name))

        return ComparisonResult(
            scanned_repos=repo_names,
            total_unique_dependencies=len(dep_map),
            drifted_dependencies_count=drifted_count,
            in_sync_count=in_sync_count,
            severity_breakdown=severity_counts,
            drift_matrix=matrix,
        )


drift_engine = DriftEngine()
