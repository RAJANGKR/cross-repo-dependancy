"""Deterministic risk score and confidence. No LLM output reaches this module.

The weights are UNTUNED ESTIMATES chosen for a hackathon, not measurements.
The score is a secondary signal; drift_disparity and compatibility_risk from
classifier.py stay the primary ones. Confidence is a heuristic about how much
evidence was available. It is not accuracy.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass(frozen=True)
class ScoringConfig:
    gap_points: Dict[str, int] = field(default_factory=lambda: {"major": 50, "minor": 20, "patch": 5})
    breaking_marker: int = 25
    known_vulnerability: int = 20
    used_by_three_or_more: int = 10
    tier2_hits: int = 15
    tier3_hits: int = 8
    ranges_overlap: int = -30
    #: (minimum score, level), highest first.
    levels: tuple = ((75, "Critical"), (50, "High"), (25, "Medium"), (0, "Low"))
    #: Confidence starts at 1.0 and loses this much per missing signal.
    confidence_penalties: Dict[str, float] = field(
        default_factory=lambda: {
            "registry": 0.15,
            "lockfile": 0.10,
            "resolved_version": 0.20,
            "range_overlap": 0.10,
            "changelog": 0.15,
            "vulnerabilities": 0.10,
            "code_scan": 0.10,
            "import_mapping": 0.05,
            "tier3_only": 0.10,
        }
    )


DEFAULT_CONFIG = ScoringConfig()


@dataclass
class Score:
    score: int
    level: str
    breakdown: List[dict]
    confidence: float
    signals_missing: List[str]


def level_for(score: int, config: ScoringConfig = DEFAULT_CONFIG) -> str:
    return next(level for minimum, level in config.levels if score >= minimum)


def score_drift(
    *,
    gap: str,
    overlap: Optional[bool],
    breaking_marker: bool,
    vulnerable: bool,
    repo_count: int,
    tier2_hits: int = 0,
    tier3_hits: int = 0,
    signals_missing: Optional[List[str]] = None,
    config: ScoringConfig = DEFAULT_CONFIG,
) -> Score:
    breakdown: List[dict] = []

    def add(signal: str, points: int) -> None:
        breakdown.append({"signal": signal, "points": points})

    if gap in config.gap_points:
        add(f"{gap.capitalize()} version gap", config.gap_points[gap])
    if breaking_marker:
        add("Breaking marker in changelog", config.breaking_marker)
    if vulnerable:
        add("Known vulnerability", config.known_vulnerability)
    if repo_count >= 3:
        add("Used by 3+ repos", config.used_by_three_or_more)
    if tier2_hits:
        add("Tier 2 code hits", config.tier2_hits)
    if tier3_hits:
        add("Tier 3 code hits", config.tier3_hits)
    if overlap is True:
        add("Ranges overlap", config.ranges_overlap)

    score = max(0, min(100, sum(item["points"] for item in breakdown)))
    missing = list(dict.fromkeys(signals_missing or []))
    confidence = 1.0 - sum(config.confidence_penalties.get(key, 0.05) for key in missing)
    return Score(score, level_for(score, config), breakdown, round(max(0.1, min(1.0, confidence)), 2), missing)
