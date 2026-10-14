"""Request and response models for the assistant (POST /api/v1/assistant/chat)."""
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

MAX_MESSAGE_CHARS = 600
MAX_HISTORY_TURNS = 12
MAX_TURN_CHARS = 2000


class ChatTurn(BaseModel):
    """One earlier message of the same conversation."""

    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=MAX_TURN_CHARS)


class AssistantContext(BaseModel):
    """The results the dashboard is showing. The assistant answers from these and from nothing else."""

    #: The `result` of the completed scan on screen, as the scan endpoint returned it.
    scan: Optional[Dict[str, Any]] = None
    scan_id: str = Field("", max_length=80)
    #: What kind of data that is: a scan just run, the saved demo run, or the built-in sample.
    scan_source: Literal["live", "demo", "sample"] = "live"
    #: The rollout planner's latest answer, as POST /api/v1/rollout returned it.
    rollout: Optional[Dict[str, Any]] = None
    #: The screen the question is asked from. It decides which results an open question is about.
    view: Literal["start", "results", "rollout"] = "results"


class AssistantChatRequest(BaseModel):
    message: str = Field(..., max_length=MAX_MESSAGE_CHARS)
    history: List[ChatTurn] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)
    context: AssistantContext = Field(default_factory=AssistantContext)

    @field_validator("message")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("The message is empty.")
        return value


class AssistantUsed(BaseModel):
    """Which of the supplied results the answer was built from."""

    scan: bool
    rollout: bool
    scan_id: str = ""
    scan_source: str = ""


class AssistantChatResponse(BaseModel):
    answer: str
    #: gemini: written by the model from the supplied results.
    #: fallback: built by fixed rules from the same results, because the model could not be used.
    #: no_context: there were no results to answer from.
    source: Literal["gemini", "fallback", "no_context"]
    #: For a fallback: what the question was taken to be about (main_problem, next_step, explain_scan, improve,
    #: why, package, repository, unknown_repository, rollout, contract, vulnerabilities, safety, term, greeting,
    #: out_of_scope, unsupported). Empty otherwise.
    intent: str = ""
    #: For a fallback: one short sentence on why the model was not used. Empty otherwise.
    notice: str = ""
    used: AssistantUsed
