import re
from typing import Dict, List, Optional, Tuple
from packaging.version import Version, InvalidVersion
from app.schemas.dependency import Ecosystem
from app.schemas.drift import DriftSeverity


class VersionService:
    @staticmethod
    def extract_clean_version(spec: str) -> Optional[str]:
        """Extract the numeric semver/version string from a version specifier."""
        if not spec or spec == "*":
            return None
        # Match standard semantic version patterns like 18.2.0, 1.0.0-beta.1, 0.110.0
        match = re.search(r"(\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9\.\-]*)?)", spec)
        if match:
            return match.group(1)
        # Fallback if only single number e.g. "18"
        single_digit = re.search(r"(\d+)", spec)
        return single_digit.group(1) if single_digit else None

    @classmethod
    def parse_version_safe(cls, raw: str) -> Optional[Version]:
        """Safely parse a version string into packaging.version.Version."""
        clean = cls.extract_clean_version(raw)
        if not clean:
            return None
        try:
            return Version(clean)
        except InvalidVersion:
            return None

    @classmethod
    def evaluate_drift(
        cls,
        ecosystem: Ecosystem,
        versions_by_repo: Dict[str, str],
        all_repo_names: List[str],
    ) -> Tuple[DriftSeverity, bool, Optional[str], str]:
        """
        Evaluate cross-repository drift for a single dependency.
        Returns: (severity, is_drifted, recommended_version, summary)
        """
        present_repos = list(versions_by_repo.keys())
        missing_repos = [r for r in all_repo_names if r not in versions_by_repo]

        # Case 1: Present in only 1 repo out of multiple
        if len(present_repos) == 1 and len(all_repo_names) > 1:
            repo = present_repos[0]
            ver = versions_by_repo[repo]
            return (
                DriftSeverity.INFO,
                False,
                ver,
                f"Declared only in '{repo}' ({ver}). Absent in other repositories.",
            )

        unique_specs = set(versions_by_repo.values())

        # Case 2: Exact constraint match across all repositories where it's present
        if len(unique_specs) == 1:
            single_spec = list(unique_specs)[0]
            if not missing_repos:
                return (
                    DriftSeverity.IN_SYNC,
                    False,
                    single_spec,
                    f"Fully aligned across all repositories at '{single_spec}'.",
                )
            else:
                return (
                    DriftSeverity.INFO,
                    False,
                    single_spec,
                    f"Aligned at '{single_spec}' in active repos, but not declared in: {', '.join(missing_repos)}.",
                )

        # Case 3: Divergence in version constraints across repositories
        parsed_versions: List[Tuple[str, Version, str]] = []  # (repo, version_obj, raw_spec)
        unparsed_repos: List[Tuple[str, str]] = []

        for repo, spec in versions_by_repo.items():
            parsed_ver = cls.parse_version_safe(spec)
            if parsed_ver:
                parsed_versions.append((repo, parsed_ver, spec))
            else:
                unparsed_repos.append((repo, spec))

        # Check for major version divergence
        has_major_mismatch = False
        highest_version_spec = None
        highest_version_obj: Optional[Version] = None

        if parsed_versions:
            # Sort by version object descending
            sorted_versions = sorted(parsed_versions, key=lambda x: x[1], reverse=True)
            highest_version_obj = sorted_versions[0][1]
            highest_version_spec = sorted_versions[0][2]

            majors = {v[1].major for v in parsed_versions}
            if len(majors) > 1:
                has_major_mismatch = True

        if has_major_mismatch:
            breakdown = ", ".join([f"{r}: {s}" for r, s in versions_by_repo.items()])
            return (
                DriftSeverity.CRITICAL,
                True,
                highest_version_spec,
                f"Critical major version mismatch ({breakdown}). Breaking API changes likely.",
            )

        # If versions differ but same major (minor/patch or specifier style difference)
        breakdown = ", ".join([f"{r}: {s}" for r, s in versions_by_repo.items()])
        recommended = highest_version_spec or list(versions_by_repo.values())[0]

        return (
            DriftSeverity.WARNING,
            True,
            recommended,
            f"Minor/patch version drift ({breakdown}). Recommended to harmonize to '{recommended}'.",
        )
