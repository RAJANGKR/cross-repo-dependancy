"""Deterministic drift classification. No LLM output reaches this module.

Decision order for one package (one ecosystem + normalized name):

1. Effective version per repository: the lockfile pin if present, else the
   version an exact declaration pins, else the highest registry version that
   satisfies the declared range, else unknown.
2. drift_disparity
   - present in one repository only                      -> INFO
   - all effective versions known and equal:
       declared ranges also equal (or every repo pinned) -> IN_SYNC (every repository
                                                            that uses it agrees; other
                                                            repositories are listed in
                                                            missing_in_repos)
       declared ranges differ                            -> MINOR_DRIFT
   - all known, different: widest gap major              -> MAJOR_DRIFT
                           minor or patch                -> MINOR_DRIFT
   - some unknown: declared texts identical              -> IN_SYNC
                   otherwise                             -> INFO (unresolvable difference)
3. compatibility_risk (only drifted packages can be more than NONE)
   - verified breaking changelog line, or Tier 2 rule hit -> CONFIRMED_BREAKING
   - ranges overlap, or a patch-only gap                 -> NONE
   - major gap, ranges do not overlap                    -> SUSPECTED_BREAKING
   - anything else                                       -> UNKNOWN_IMPACT
4. recommended_version: the highest known version that satisfies the declared
   ranges of the most repositories; if no version satisfies them all, the
   highest effective version in use; None when nothing is known.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from app.services import range_service as ranges

GAP_RANK = {"none": 0, "patch": 1, "minor": 2, "major": 3}


@dataclass
class Declaration:
    repo: str
    declared_range: str
    resolved_version: Optional[str]
    dep_type: str
    source_file: str


@dataclass
class Classification:
    drift_disparity: str
    compatibility_risk: str
    recommended_version: Optional[str]
    #: Effective version per repository; None where it could not be determined.
    effective: Dict[str, Optional[str]]
    #: major | minor | patch | none | unknown
    gap: str
    #: True / False / None (unknown)
    overlap: Optional[bool]
    signals_missing: List[str] = field(default_factory=list)

    @property
    def drifted(self) -> bool:
        return self.drift_disparity in ("MAJOR_DRIFT", "MINOR_DRIFT")

    @property
    def low_and_high(self) -> Optional[tuple]:
        known = [v for v in self.effective.values() if v]
        return (known[0], known[-1]) if len(known) >= 2 else None


def effective_versions(eco: str, declarations: List[Declaration], registry_versions: List[str]) -> Dict[str, Optional[str]]:
    result: Dict[str, Optional[str]] = {}
    for declaration in declarations:
        version = declaration.resolved_version or ranges.exact_pin(eco, declaration.declared_range)
        if not version and registry_versions:
            version = ranges.resolve(eco, declaration.declared_range, registry_versions)
        result[declaration.repo] = version
    return result


def _overlap(eco: str, specs: List[str], candidates: List[str]) -> Optional[bool]:
    """True if one candidate satisfies every spec; None when that cannot be known."""
    if not candidates or len(specs) < 2:
        return None
    seen_any = False
    for version in candidates:
        results = [ranges.satisfies(eco, spec, version) for spec in specs]
        if any(r is None for r in results):
            return None
        seen_any = True
        if all(results):
            return True
    return False if seen_any else None


def _recommend(eco: str, specs: List[str], candidates: List[str], effective: List[str]) -> Optional[str]:
    ordered = ranges.sort_versions(eco, candidates)
    stable = [v for v in ordered if ranges.is_stable(eco, ranges.parse_version(eco, v))] or ordered
    best, best_count = None, 0
    for version in stable:  # ascending, so ties go to the higher version
        count = sum(1 for spec in specs if ranges.satisfies(eco, spec, version))
        if count and count >= best_count:
            best, best_count = version, count
    if best is not None and best_count == len(specs):
        return best
    in_use = ranges.sort_versions(eco, effective)
    return in_use[-1] if in_use else best


def classify(
    eco: str,
    declarations: List[Declaration],
    total_repos: int,
    registry_versions: Optional[List[str]] = None,
    verified_breaking: bool = False,
    tier2_hit: bool = False,
) -> Classification:
    versions = registry_versions or []
    effective = effective_versions(eco, declarations, versions)
    known = ranges.sort_versions(eco, [v for v in effective.values() if v])
    all_known = len(known) == len(declarations)
    specs = [d.declared_range for d in declarations]
    missing: List[str] = []
    if not versions:
        missing.append("registry")
    if any(not d.resolved_version for d in declarations):
        missing.append("lockfile")

    # Sorted effective versions, so callers can read the oldest and newest.
    rank = {version: index for index, version in enumerate(known)}
    ordered_effective = dict(sorted(effective.items(), key=lambda item: rank.get(item[1], len(rank))))
    if not all_known:
        missing.append("resolved_version")

    candidates = list(dict.fromkeys(versions + known))
    overlap = _overlap(eco, specs, candidates)
    if overlap is None and len(declarations) > 1:
        missing.append("range_overlap")

    def result(disparity: str, risk: str, gap: str) -> Classification:
        return Classification(disparity, risk, _recommend(eco, specs, candidates, known), ordered_effective, gap, overlap, missing)

    if len(declarations) < 2:
        return result("INFO", "NONE", "none")

    aligned = "IN_SYNC"
    if not all_known:
        if len(set(specs)) == 1:
            return result(aligned, "NONE", "unknown")
        return result("INFO", "UNKNOWN_IMPACT", "unknown")

    gap = "none"
    if len(set(known)) > 1:
        gap = ranges.gap(eco, known[0], known[-1])
    if gap == "none":
        pinned = all(d.resolved_version for d in declarations)
        if pinned or len(set(specs)) == 1:
            return result(aligned, "NONE", "none")
        return result("MINOR_DRIFT", "NONE", "none")

    disparity = "MAJOR_DRIFT" if gap == "major" else "MINOR_DRIFT" if gap in ("minor", "patch") else "INFO"
    if disparity == "INFO":
        return result("INFO", "UNKNOWN_IMPACT", gap)
    if verified_breaking or tier2_hit:
        risk = "CONFIRMED_BREAKING"
    elif overlap is True or gap == "patch":
        risk = "NONE"
    elif gap == "major" and overlap is False:
        risk = "SUSPECTED_BREAKING"
    else:
        risk = "UNKNOWN_IMPACT"
    return result(disparity, risk, gap)
