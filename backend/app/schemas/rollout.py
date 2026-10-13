"""Request and response models for the rollout planner (POST /api/v1/rollout)."""
from typing import List, Optional

from pydantic import BaseModel, Field

RECOMMENDATIONS = ("PROVIDER_FIRST", "CONSUMER_FIRST", "EITHER", "NEITHER", "UNRESOLVED")
STATE_STATUSES = ("COMPATIBLE", "INCOMPATIBLE", "UNKNOWN")


class RolloutSide(BaseModel):
    """One repository at its deployed ref and at the ref proposed for release."""

    url: str = Field(..., min_length=1, max_length=300)
    #: What runs today: a branch, tag or commit.
    current_ref: str = Field(..., min_length=1, max_length=200)
    #: What is about to be released.
    proposed_ref: str = Field(..., min_length=1, max_length=200)


class RolloutRequest(BaseModel):
    provider: RolloutSide
    consumer: RolloutSide


class AnalyzedRef(BaseModel):
    """Exactly what was read for one side at one ref."""

    label: str                       # P0, P1, C0, C1
    repository: str
    url: str
    ref: str
    #: Empty when the ref could not be resolved.
    commit: str = ""
    spec_file: str = ""
    api_title: str = ""
    api_version: str = ""
    #: Source files read from a consumer ref; None for a provider ref or when nothing was read.
    files_read: Optional[int] = None
    #: Why this ref could not be read or used; empty when it was.
    problem: str = ""


class ContractChange(BaseModel):
    #: "P0_TO_P1": P1 no longer accepts or returns what P0 did. "P1_TO_P0": P1 offers something P0 does not.
    direction: str
    change_type: str
    method: str
    path: str
    field: str = ""
    field_in: str = ""
    previous_value: str
    new_value: str
    spec_file: str
    json_pointer: str
    description: str = ""


class RolloutEvidence(BaseModel):
    """What the consumer code at one ref shows about one contract change."""

    verdict: str                     # COMPATIBLE | INCOMPATIBLE | UNKNOWN, for this change in this state
    change_type: str
    method: str
    path: str
    field: str = ""
    field_in: str = ""
    evidence_tier: str
    usage: str
    file: str = ""
    line: Optional[int] = None
    snippet: str = ""
    explanation: str


class RolloutState(BaseModel):
    key: str                         # provider_first | consumer_first | final
    title: str
    description: str
    provider: str                    # P0 or P1
    consumer: str                    # C0 or C1
    status: str
    reason: str
    evidence: List[RolloutEvidence] = Field(default_factory=list)
    unresolved: List[str] = Field(default_factory=list)


class UnresolvedItem(BaseModel):
    scope: str
    reason: str


class RolloutResponse(BaseModel):
    recommendation: str
    summary: str
    refs: List[AnalyzedRef]
    provider_first: RolloutState
    consumer_first: RolloutState
    #: Both deployed (P1 with C1). Informational: it does not change the recommendation.
    final: RolloutState
    contract_changes: List[ContractChange]
    unresolved: List[UnresolvedItem]
    limitations: List[str]
