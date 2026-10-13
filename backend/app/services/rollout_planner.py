"""Rollout order for one provider and one consumer.

Given the provider at its deployed ref (P0) and proposed ref (P1), and the
consumer at its deployed ref (C0) and proposed ref (C1), this evaluates the two
intermediate states of a rollout:

  provider first   P1 is live while the consumer is still C0
  consumer first   C1 is live while the provider is still P0

It reuses the scan's building blocks and adds no analysis of its own: the
GitHub fetcher reads the refs, openapi_diff_engine compares the two provider
specifications, and the C1 consumer analysis says what the consumer code does
with each change.

The rules are deliberately conservative:

  * INCOMPATIBLE needs a demonstrated problem: the consumer calls an operation
    the provider in that state does not define, or sends a request without a
    value that provider requires.
  * COMPATIBLE needs positive evidence: no contract change that could affect
    that state was detected, or every detected change is seen to be satisfied
    (the request includes the newly required value at every call site).
  * Everything else is UNKNOWN. No call found, a call that could not be
    followed, a field that is read after its type changed, a ref that could
    not be fetched: none of these proves compatibility, and none proves a
    break. A state whose consumer ref does not resolve to a commit is always
    UNKNOWN: a pair that was never seen is not called compatible.

Nothing here is a runtime observation.
"""
import asyncio
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.core.config import settings
from app.core.security import InvalidTarget, parse_github_url
from app.schemas.rollout import RolloutRequest, RolloutSide
from app.services import consumer_usage, github_fetcher, usage_scanner
from app.services import openapi_diff_engine as engine
from app.services.http import FetchError, Http
from app.services.scan_runner import shared_cache

logger = logging.getLogger("driftlock.rollout")

PROVIDER_FIRST, CONSUMER_FIRST, EITHER, NEITHER, UNRESOLVED = "PROVIDER_FIRST", "CONSUMER_FIRST", "EITHER", "NEITHER", "UNRESOLVED"
COMPATIBLE, INCOMPATIBLE, UNKNOWN = "COMPATIBLE", "INCOMPATIBLE", "UNKNOWN"

LIMITATIONS = [
    "Only three kinds of contract change are detected: a removed path or operation, a newly required request value, and a changed response field type. "
    "Other differences between the two specifications (removed response fields, enum values, formats, status codes) are not analyzed, so \"compatible\" means compatible with respect to those three kinds.",
    "Consumer evidence comes from reading source code at the given refs. A call that was not found, or could not be followed, never counts as evidence of compatibility.",
    "The consumer is taken to call this provider because the request says so. Calls are matched by path; which host a call really reaches is not verified.",
    "Reading a response field whose type changed is reported as unknown: whether the code copes with the new type cannot be told statically.",
    "Nothing is executed and nothing is observed at runtime. Data migrations, feature flags, caches and gateways are outside this analysis.",
]

_SUMMARIES = {
    EITHER: "Both intermediate states are supported by the evidence, so either order can be used.",
    PROVIDER_FIRST: "Deploy the provider first. That intermediate state is supported by the evidence; deploying the consumer first is not.",
    CONSUMER_FIRST: "Deploy the consumer first. That intermediate state is supported by the evidence; deploying the provider first is not.",
    NEITHER: "Both orders have a demonstrated incompatibility in their intermediate state. Neither order can be rolled out as is.",
    UNRESOLVED: "No order could be shown to be compatible with the evidence available. This is not a statement that the rollout is unsafe.",
}


def recommend(provider_first: str, consumer_first: str) -> str:
    """The recommendation that follows from the two intermediate states.

    An order is recommended only when its own intermediate state is COMPATIBLE.
    NEITHER is reserved for two demonstrated incompatibilities. Any other
    combination is UNRESOLVED: an unknown state is never read as safe."""
    if provider_first == COMPATIBLE and consumer_first == COMPATIBLE:
        return EITHER
    if provider_first == COMPATIBLE:
        return PROVIDER_FIRST
    if consumer_first == COMPATIBLE:
        return CONSUMER_FIRST
    if provider_first == INCOMPATIBLE and consumer_first == INCOMPATIBLE:
        return NEITHER
    return UNRESOLVED


def verdict_for(usage: str) -> str:
    """What one piece of C1 consumer evidence says about one contract change."""
    if usage in (consumer_usage.CALLS_OPERATION, consumer_usage.OMITS_REQUIRED_FIELD):
        return INCOMPATIBLE
    if usage == consumer_usage.SENDS_REQUIRED_FIELD:
        return COMPATIBLE
    # Reads a changed field, may send, not determined, operation called without a read, no usage found.
    return UNKNOWN


def state_status(verdicts: List[str], blocked: bool) -> str:
    if any(verdict == INCOMPATIBLE for verdict in verdicts):
        return INCOMPATIBLE  # a demonstrated problem stands even when other things are unknown
    if blocked or any(verdict == UNKNOWN for verdict in verdicts):
        return UNKNOWN
    return COMPATIBLE


@dataclass
class _Ref:
    label: str
    owner: str
    repo: str
    url: str
    ref: str
    commit: str = ""
    problem: str = ""
    specs: Dict[str, str] = field(default_factory=dict)
    spec_errors: Dict[str, str] = field(default_factory=dict)
    files: Optional[Dict[str, str]] = None
    spec_file: str = ""
    spec: Optional[engine.Spec] = None

    @property
    def repository(self) -> str:
        return f"{self.owner}/{self.repo}"

    def describe(self) -> dict:
        return {
            "label": self.label, "repository": self.repository, "url": self.url, "ref": self.ref, "commit": self.commit,
            "spec_file": self.spec_file, "api_title": self.spec.title if self.spec else "", "api_version": self.spec.version_text if self.spec else "",
            "files_read": len(self.files) if self.files is not None else None, "problem": self.problem,
        }


def _parse(side: RolloutSide, role: str) -> Tuple[str, str, str]:
    try:
        owner, repo, in_url = parse_github_url(side.url)
    except InvalidTarget as error:
        raise InvalidTarget(f"{role} URL: {error}") from error
    if in_url:
        raise InvalidTarget(f"{role} URL: give the repository URL without /tree/..., and put the refs in their own fields")
    return owner, repo, f"https://github.com/{owner}/{repo}"


async def _repository_problem(http: Http, ref: _Ref, checked: Dict[str, str]) -> str:
    """Why the repository itself cannot be read, or "" when it can. Asked only
    after a ref failed to resolve, so that a mistyped repository is not reported
    as a missing branch. One request per repository."""
    if ref.repository not in checked:
        try:
            await http.get_json(f"{github_fetcher.API}/repos/{ref.owner}/{ref.repo}", ttl=300)
            checked[ref.repository] = ""
        except FetchError as error:
            checked[ref.repository] = github_fetcher.describe(error, f"The repository {ref.repository}") + "."
    return checked[ref.repository]


async def _fetch_provider(http: Http, ref: _Ref, checked: Dict[str, str]) -> None:
    fetched = await github_fetcher.fetch_repo(http, ref.owner, ref.repo, ref.ref)
    ref.commit, ref.specs, ref.spec_errors = fetched.commit, fetched.specs, fetched.spec_errors
    if fetched.error:
        ref.problem = (await _repository_problem(http, ref, checked) if not fetched.commit else "") or f"{fetched.error}."
    elif fetched.subdir:
        ref.problem = f'"{ref.ref}" resolved to a folder inside a branch; give a branch, tag or commit.'


async def _fetch_consumer(http: Http, ref: _Ref, archives: Dict[str, Dict[str, str]], checked: Dict[str, str]) -> None:
    try:
        resolved = await github_fetcher.resolve_ref(http, ref.owner, ref.repo, ref.ref)
        if resolved is None or resolved[2]:
            ref.problem = (await _repository_problem(http, ref, checked) if resolved is None else "") or f'Branch, tag or commit "{ref.ref}" could not be resolved in {ref.repository}.'
            return
        ref.commit = resolved[1]
        if ref.commit not in archives:
            archive = await github_fetcher.fetch_zipball(http, ref.owner, ref.repo, ref.commit)
            archives[ref.commit] = await asyncio.to_thread(usage_scanner.read_zip, archive)
        ref.files = archives[ref.commit]
        if not ref.files:
            ref.problem = "No Python, JavaScript, TypeScript or Java source file was found at this ref."
    except FetchError as error:
        ref.problem = f"The source code could not be read: {github_fetcher.describe(error, f'{ref.repository} at {ref.ref}')}."


def _choose_specs(current: _Ref, proposed: _Ref) -> str:
    """Pick the specification file to compare at both refs. Returns a problem, or ""."""
    for ref in (current, proposed):
        if ref.problem:
            return ""
        if not ref.specs:
            unread = "; ".join(f"{path}: {reason}" for path, reason in ref.spec_errors.items())
            ref.problem = (f"A specification file was found but could not be read ({unread})." if unread else
                           "No OpenAPI or Swagger file was found at the repository root or under docs/, api/, spec/, specs/, src/.")
            return ""
    shared = sorted(set(current.specs) & set(proposed.specs), key=lambda path: (path.count("/"), path))
    if shared:
        current.spec_file = proposed.spec_file = shared[0]
    elif len(current.specs) == 1 and len(proposed.specs) == 1:
        current.spec_file, proposed.spec_file = next(iter(current.specs)), next(iter(proposed.specs))
    else:
        return ("The two provider refs contain different specification files and it is not clear which ones correspond: "
                f"{sorted(current.specs)} at {current.label}, {sorted(proposed.specs)} at {proposed.label}.")
    for ref in (current, proposed):
        try:
            ref.spec = engine.Spec(f"{ref.repository}@{ref.ref}", ref.spec_file, engine.parse_spec(ref.specs[ref.spec_file], ref.spec_file))
        except engine.MalformedSpec as error:
            ref.problem = f"{ref.spec_file} could not be parsed: {error}."
    return ""


def _contract(doc: dict) -> dict:
    return {key: value for key, value in doc.items() if key != "info"}


def _evidence(row: dict, verdict: str, explanation: str = "") -> dict:
    return {
        "verdict": verdict, "change_type": row["change_type"], "method": row["method"], "path": row["path"],
        "field": row.get("field", ""), "field_in": row.get("field_in", ""),
        "evidence_tier": row["evidence_tier"], "usage": row["usage"],
        "file": row.get("file", ""), "line": row.get("line"), "snippet": row.get("snippet", ""),
        "explanation": explanation or row["explanation"],
    }


def _rows(comparison: engine.Comparison, consumer: _Ref) -> Tuple[List[dict], str]:
    """One C1 evidence row per change for the consumer at one ref, and why there are none."""
    entry = engine.consumer_entry(comparison, f"{consumer.repository}@{consumer.ref}", consumer.files, "the source could not be read", declared=True)
    if "consumer_impact" in entry:
        return entry["consumer_impact"], ""
    return [], entry["message"]


def _state(key: str, title: str, description: str, provider: _Ref, consumer: _Ref, comparison: Optional[engine.Comparison],
           nothing_detected: str, blockers: List[str]) -> dict:
    """Evaluate one deployed pair. `comparison` holds the contract changes that
    could break this pair, read in the direction that matters for it."""
    state = {"key": key, "title": title, "description": description, "provider": provider.label, "consumer": consumer.label,
             "status": UNKNOWN, "reason": "", "evidence": [], "unresolved": list(blockers)}
    if blockers or comparison is None:
        state["reason"] = "This state could not be evaluated: " + " ".join(blockers)
        return state
    if not consumer.commit:
        # The ref does not resolve to a commit, so the pair this state describes was never seen.
        # Nothing is concluded about it, even when the specifications alone show no change.
        state["unresolved"].append(f"{consumer.label}: {consumer.problem}")
        state["reason"] = f"This state could not be evaluated: the consumer ref {consumer.label} could not be resolved. {consumer.problem}"
        return state
    if not comparison.findings:
        # The specification comparison is the evidence here; the consumer code is not needed.
        state["status"], state["reason"] = COMPATIBLE, nothing_detected
        return state
    if consumer.files is None or consumer.problem:
        state["unresolved"].append(f"{consumer.label}: {consumer.problem or 'the source code was not read.'}")
        state["reason"] = (f"{len(comparison.findings)} contract change(s) could affect this state, but the consumer code at {consumer.label} "
                           "could not be read, so their effect is not known.")
        return state
    rows, missing = _rows(comparison, consumer)
    if not rows:
        state["unresolved"].append(f"{consumer.label}: {missing}")
        state["reason"] = (f"{len(comparison.findings)} contract change(s) could affect this state, and no call to this API could be matched "
                           f"in the consumer code at {consumer.label}. That does not show the consumer is unaffected.")
        return state
    state["evidence"] = [_evidence(row, verdict_for(row["usage"])) for row in rows]
    for item in state["evidence"]:
        if item["verdict"] == UNKNOWN:
            target = f"{item['method']} {item['path']}".strip() + (f" ({item['field']})" if item["field"] else "")
            state["unresolved"].append(f"{target}: {item['explanation']}")
    verdicts = [item["verdict"] for item in state["evidence"]]
    state["status"] = state_status(verdicts, blocked=False)
    broken, unknown = verdicts.count(INCOMPATIBLE), verdicts.count(UNKNOWN)
    if state["status"] == INCOMPATIBLE:
        state["reason"] = f"{broken} of {len(verdicts)} contract change(s) is shown to break the consumer code at {consumer.label} against {provider.label}."
    elif state["status"] == UNKNOWN:
        state["reason"] = (f"The effect of {unknown} of {len(verdicts)} contract change(s) on the consumer code at {consumer.label} could not be established. "
                           "Unknown is not compatible.")
    else:
        state["reason"] = f"All {len(verdicts)} contract change(s) are seen to be satisfied by the consumer code at {consumer.label}."
    return state


async def analyze(request: RolloutRequest, http: Optional[Http] = None) -> dict:
    """The rollout analysis for one request. Raises InvalidTarget for input the API must reject."""
    provider_owner, provider_repo, provider_url = _parse(request.provider, "Provider")
    consumer_owner, consumer_repo, consumer_url = _parse(request.consumer, "Consumer")
    p0 = _Ref("P0", provider_owner, provider_repo, provider_url, request.provider.current_ref.strip().strip("/"))
    p1 = _Ref("P1", provider_owner, provider_repo, provider_url, request.provider.proposed_ref.strip().strip("/"))
    c0 = _Ref("C0", consumer_owner, consumer_repo, consumer_url, request.consumer.current_ref.strip().strip("/"))
    c1 = _Ref("C1", consumer_owner, consumer_repo, consumer_url, request.consumer.proposed_ref.strip().strip("/"))

    owns_http = http is None
    http = http or Http(cache=shared_cache(), github_token=settings.GITHUB_TOKEN, timeout=settings.HTTP_TIMEOUT_SECONDS, retries=settings.HTTP_RETRIES)
    archives: Dict[str, Dict[str, str]] = {}
    checked: Dict[str, str] = {}
    try:
        await _fetch_provider(http, p0, checked)
        await _fetch_provider(http, p1, checked)
        await _fetch_consumer(http, c0, archives, checked)
        await _fetch_consumer(http, c1, archives, checked)
    finally:
        if owns_http:
            await http.aclose()

    pairing = await asyncio.to_thread(_choose_specs, p0, p1)
    provider_blockers = [f"{ref.label}: {ref.problem}" for ref in (p0, p1) if ref.problem] + ([pairing] if pairing else [])
    forward = reverse = None
    changes: List[dict] = []
    if not provider_blockers and p0.spec and p1.spec:
        holders = {p0.repository}
        basis = "the two refs of the provider given in the request"
        # P0 -> P1: what P1 no longer accepts or returns. It decides whether an existing consumer survives P1.
        forward = engine.Comparison(p0.spec, p1.spec, basis, await asyncio.to_thread(engine.diff_specs, p0.spec, p1.spec), holders)
        # P1 -> P0: what P1 offers that P0 does not. It decides whether a consumer written for P1 survives P0.
        reverse = engine.Comparison(p1.spec, p0.spec, basis, await asyncio.to_thread(engine.diff_specs, p1.spec, p0.spec), holders)
        for direction, comparison in (("P0_TO_P1", forward), ("P1_TO_P0", reverse)):
            changes.extend({"direction": direction, **{key: finding.get(key, "") for key in (
                "change_type", "method", "path", "field", "field_in", "previous_value", "new_value", "spec_file", "json_pointer", "description")}}
                for finding in comparison.findings)

    identical = bool(p0.spec and p1.spec and _contract(p0.spec.doc) == _contract(p1.spec.doc))
    none_forward = ("The two provider specifications are identical apart from their info block." if identical else
                    "No removed operation, newly required request value or changed response type was detected from P0 to P1, so nothing detected can break a consumer written for P0.")
    none_reverse = ("The two provider specifications are identical apart from their info block." if identical else
                    "P1 defines no operation, required value or response type that P0 lacks among the kinds that are checked, so nothing detected can break a consumer written for P1.")

    def evaluate() -> Tuple[dict, dict, dict]:
        final = _state("final", "Both deployed", "P1 and C1 are both live: the end of either rollout order.", p1, c1, forward, none_forward, provider_blockers)
        first = _state("provider_first", "Provider first", "P1 is deployed while the consumer is still C0.", p1, c0, forward, none_forward, provider_blockers)
        second = _state("consumer_first", "Consumer first", "C1 is deployed while the provider is still P0.", p0, c1, reverse, none_reverse, provider_blockers)
        # A consumer that already sends a value P0 does not define: whether P0 ignores or rejects it is not known.
        for item in final["evidence"]:
            undefined = next((c for c in changes if c["direction"] == "P0_TO_P1" and (c["method"], c["path"], c["field"]) == (item["method"], item["path"], item["field"])
                              and c["previous_value"].endswith(": absent")), None)
            if item["usage"] == consumer_usage.SENDS_REQUIRED_FIELD and undefined is not None and not provider_blockers:
                note = (f"{c1.label} sends {item['field_in'].replace('_', ' ')} '{item['field']}' to {item['method']} {item['path']}, which P0's specification does not define. "
                        "Whether P0 ignores an unknown value or rejects it is not known.")
                second["evidence"].append(_evidence(item, UNKNOWN, note))
                second["unresolved"].append(note)
                if second["status"] == COMPATIBLE:
                    second["status"] = UNKNOWN
                    second["reason"] = "C1 sends a value that P0's specification does not define. Unknown is not compatible."
        return first, second, final

    provider_first, consumer_first, final = await asyncio.to_thread(evaluate)
    recommendation = recommend(provider_first["status"], consumer_first["status"])
    summary = _SUMMARIES[recommendation]
    if recommendation in (PROVIDER_FIRST, CONSUMER_FIRST):
        other = consumer_first if recommendation == PROVIDER_FIRST else provider_first
        if other["status"] == UNKNOWN:
            summary = summary.replace("is not.", "could not be established.")
    if recommendation != UNRESOLVED and final["status"] == INCOMPATIBLE:
        summary += " Note that the end state (P1 with C1) has a demonstrated incompatibility of its own; see \"Both deployed\"."
    elif recommendation == UNRESOLVED and INCOMPATIBLE in (provider_first["status"], consumer_first["status"]):
        broken = provider_first if provider_first["status"] == INCOMPATIBLE else consumer_first
        summary = f"{broken['title']} has a demonstrated incompatibility, and the other order could not be shown to be compatible. " + summary

    unresolved: List[dict] = []
    for ref in (p0, p1, c0, c1):
        if ref.problem:
            unresolved.append({"scope": ref.label, "reason": ref.problem})
    if pairing:
        unresolved.append({"scope": "Provider specifications", "reason": pairing})
    for state in (provider_first, consumer_first, final):
        for reason in state["unresolved"]:
            if not any(reason.endswith(item["reason"]) for item in unresolved):
                unresolved.append({"scope": state["title"], "reason": reason})
    if p0.commit and p0.commit == p1.commit:
        unresolved.append({"scope": "Provider refs", "reason": f"P0 and P1 resolve to the same commit ({p0.commit[:7]}), so there is no provider change to roll out."})

    return {
        "recommendation": recommendation, "summary": summary,
        "refs": [ref.describe() for ref in (p0, p1, c0, c1)],
        "provider_first": provider_first, "consumer_first": consumer_first, "final": final,
        "contract_changes": changes, "unresolved": unresolved, "limitations": LIMITATIONS,
    }
