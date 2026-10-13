"""Deterministic OpenAPI / Swagger contract analysis.

Adapted from the Phase 2 prototype (backup/local-phase2-20261013) to the
current scan pipeline. Specifications are parsed as data (json / yaml.safe_load);
nothing is executed. Output is plain JSON in the `contract_analysis` shape that
frontend/src/api/scanTypes.ts reads.

What a finding means, and what it never means:
  * every finding is a change detected between two specification files;
  * only three kinds are reported, all of them POTENTIALLY_BREAKING for clients:
    a removed path or operation, a newly required request parameter or field,
    and a changed response field type;
  * a consumer entry adds evidence that source code references the endpoint
    (CONSUMER_REFERENCE_FOUND);
  * nothing here is, or is ever labelled as, a confirmed runtime failure.

Two specifications are compared only when they are verifiably the same API
(matching x-api-id / x-service-id, or the same non-generic normalized title)
AND their info.version values parse and differ. Shared paths never establish a
relationship, and submission order never decides which side is the baseline.
"""
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse

import yaml
from packaging.version import InvalidVersion, Version

HTTP_METHODS = ("get", "put", "post", "delete", "patch", "options", "head", "trace")
SPEC_NAMES = {"openapi.json", "openapi.yaml", "openapi.yml", "swagger.json", "swagger.yaml", "swagger.yml"}
#: Besides the repository root, specifications are looked for under these top-level folders.
SPEC_DIRS = ("docs", "api", "spec", "specs", "src")
_MAX_SPEC_DEPTH = 5

ANALYZED = "ANALYZED"
SPEC_UNAVAILABLE = "SPEC_UNAVAILABLE"
MALFORMED_SPEC = "MALFORMED_SPEC"
RELATIONSHIP_UNVERIFIED = "RELATIONSHIP_UNVERIFIED"
NOT_COMPARED = "NOT_COMPARED"

#: Titles that frameworks generate by default. Two services that both kept the
#: default are not the same API, so these never establish identity on their own.
GENERIC_TITLES = {
    "", "api", "apis", "fastapi", "openapi", "openapidefinition", "swagger", "swaggerapi", "swaggerpetstore",
    "restapi", "myapi", "apidocumentation", "apidocs", "title", "service", "backend", "server", "app", "default",
}
#: Paths nearly every service exposes. A reference to one cannot be tied to a provider.
GENERIC_PATHS = {"/", "/health", "/healthz", "/ping", "/status", "/metrics", "/version", "/ready", "/live", "/docs"}

_SEVERITY = {
    "REMOVED_PATH": "HIGH",
    "REMOVED_OPERATION": "HIGH",
    "NEW_REQUIRED_REQUEST_FIELD": "HIGH",
    "CHANGED_RESPONSE_FIELD_TYPE": "MEDIUM",
}
_IMPACT = {
    "REMOVED_PATH": "Potentially breaking for clients that still call this path.",
    "REMOVED_OPERATION": "Potentially breaking for clients that still call this operation.",
    "NEW_REQUIRED_REQUEST_FIELD": "Potentially breaking for clients that do not send this value.",
    "CHANGED_RESPONSE_FIELD_TYPE": "Potentially breaking for clients that read this value with the previous type.",
}
_STATIC_ONLY = "Found by comparing the two specification files; not a confirmed runtime failure."
_MAX_REFERENCES = 10


class MalformedSpec(ValueError):
    """The file is not a readable OpenAPI 3.x / Swagger 2.0 document."""


# ---- Discovery and parsing ----------------------------------------------------

def is_spec_path(relative_path: str) -> bool:
    """True for openapi/swagger .json/.yaml/.yml at the root or under SPEC_DIRS."""
    parts = relative_path.split("/")
    if parts[-1].lower() not in SPEC_NAMES or len(parts) > _MAX_SPEC_DEPTH:
        return False
    return len(parts) == 1 or parts[0].lower() in SPEC_DIRS


def parse_spec(content: str, filename: str = "") -> dict:
    """Parse JSON or YAML safely and check it looks like OpenAPI 3.x or Swagger 2.0."""
    if not content or not content.strip():
        raise MalformedSpec("the file is empty")
    try:
        if filename.lower().endswith(".json"):
            data = json.loads(content)
        else:
            data = yaml.safe_load(content)  # safe_load: no arbitrary object construction
    except (ValueError, yaml.YAMLError, RecursionError) as error:
        kind = "JSON" if filename.lower().endswith(".json") else "YAML"
        raise MalformedSpec(f"not valid {kind} ({type(error).__name__})") from None
    if not isinstance(data, dict):
        raise MalformedSpec("the document root is not an object")
    is_openapi = isinstance(data.get("openapi"), str) and data["openapi"].startswith("3.")
    is_swagger = str(data.get("swagger", "")).startswith("2")
    if not (is_openapi or is_swagger):
        raise MalformedSpec('no supported "openapi: 3.x" or "swagger: 2.0" version field')
    if "paths" in data and data["paths"] is not None and not isinstance(data["paths"], dict):
        raise MalformedSpec('"paths" is not an object')
    return data


def _d(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def normalize_title(title: str) -> str:
    """Lowercase, drop a trailing version tag (" v2", " 2.0"), drop punctuation."""
    text = re.sub(r"[\s\-_(]+v?\d+(\.\d+)*\)?$", "", (title or "").strip().lower())
    return re.sub(r"[^a-z0-9]", "", text)


def parse_api_version(raw: Any) -> Optional[Version]:
    """info.version as an orderable version, or None when it cannot be ordered."""
    text = str(raw).strip() if raw is not None and not isinstance(raw, (dict, list, bool)) else ""
    if not text:
        return None
    date = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)  # date-based API versions
    if date:
        text = ".".join(str(int(part)) for part in date.groups())
    try:
        return Version(text[1:] if text[:1] in "vV" else text)
    except InvalidVersion:
        return None


@dataclass
class Spec:
    repo: str
    file: str
    doc: dict
    title: str = ""
    version_text: str = ""
    version: Optional[Version] = None
    explicit_id: str = ""
    title_key: str = ""
    dialect: str = ""

    def __post_init__(self) -> None:
        info = _d(self.doc.get("info"))
        self.title = str(info.get("title") or "").strip()
        raw_version = info.get("version")
        self.version_text = "" if raw_version is None else str(raw_version).strip()
        self.version = parse_api_version(raw_version)
        for key in ("x-api-id", "x-service-id"):
            value = info.get(key) or self.doc.get(key)
            if isinstance(value, (str, int)) and str(value).strip():
                self.explicit_id = str(value).strip().lower()
                break
        key = normalize_title(self.title)
        self.title_key = "" if key in GENERIC_TITLES else key
        self.dialect = f"OpenAPI {self.doc['openapi']}" if "openapi" in self.doc else "Swagger 2.0"

    @property
    def label(self) -> str:
        return self.title or self.file

    def describe(self) -> str:
        version = f" version {self.version_text}" if self.version_text else " (no version)"
        return f'{self.dialect} specification "{self.label}"{version}'

    def ref(self) -> dict:
        return {"repository": self.repo, "spec_file": self.file, "version": self.version_text, "title": self.title}


# ---- Reading one specification --------------------------------------------------

def _ptr(*parts: Any) -> str:
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


@dataclass
class _Schema:
    pointer: str
    known: bool = False
    types: Set[str] = field(default_factory=set)
    props: Dict[str, Tuple[Any, str]] = field(default_factory=dict)
    required: Set[str] = field(default_factory=set)
    items: Optional[Tuple[Any, str]] = None
    read_only: bool = False


class _Reader:
    """Accessors over one parsed document. An unresolvable reference yields an
    empty node, and empty nodes never produce findings."""

    def __init__(self, doc: dict):
        self.doc = doc

    def deref(self, node: Any, pointer: str) -> Tuple[dict, str]:
        for _ in range(20):
            if not isinstance(node, dict) or not isinstance(node.get("$ref"), str):
                break
            ref = node["$ref"]
            if not ref.startswith("#/"):
                return {}, pointer  # external file: not fetched, so nothing is claimed about it
            target: Any = self.doc
            for part in ref[2:].split("/"):
                target = target.get(part.replace("~1", "/").replace("~0", "~")) if isinstance(target, dict) else None
            node, pointer = target, ref[1:]
        else:
            return {}, pointer
        return _d(node), pointer

    def schema(self, node: Any, pointer: str, depth: int = 0) -> _Schema:
        node, pointer = self.deref(node, pointer)
        out = _Schema(pointer=pointer, known=bool(node), read_only=node.get("readOnly") is True)
        declared = node.get("type")
        if isinstance(declared, str):
            out.types.add(declared)
        elif isinstance(declared, list):
            out.types.update(item for item in declared if isinstance(item, str))
        if out.types and node.get("nullable") is True:
            out.types.add("null")
        for name, sub in _d(node.get("properties")).items():
            out.props[str(name)] = (sub, pointer + _ptr("properties", name))
        if isinstance(node.get("required"), list):
            out.required.update(str(item) for item in node["required"] if isinstance(item, str))
        if isinstance(node.get("items"), dict):
            out.items = (node["items"], pointer + "/items")
        parts = node.get("allOf")
        if isinstance(parts, list) and depth < 6:
            for index, part in enumerate(parts[:20]):
                sub = self.schema(part, pointer + _ptr("allOf", index), depth + 1)
                out.types |= sub.types
                out.required |= sub.required
                out.items = out.items or sub.items
                for name, value in sub.props.items():
                    out.props.setdefault(name, value)
        return out

    def paths(self) -> Dict[str, Tuple[str, dict, str]]:
        """{normalized template: (path as written, path item, pointer)}. Parameter
        names are ignored, so /users/{id} and /users/{userId} are the same path."""
        found: Dict[str, Tuple[str, dict, str]] = {}
        for path, item in _d(self.doc.get("paths")).items():
            if not isinstance(path, str) or not path.startswith("/"):
                continue
            item, pointer = self.deref(item, _ptr("paths", path))
            if item:
                found.setdefault(normalize_path(path), (path, item, pointer))
        return found

    def parameters(self, item: dict, item_ptr: str, op: dict, op_ptr: str) -> Dict[Tuple[str, str], Tuple[dict, str]]:
        merged: Dict[Tuple[str, str], Tuple[dict, str]] = {}
        for owner, owner_ptr in ((item, item_ptr), (op, op_ptr)):  # operation level overrides path level
            raw = owner.get("parameters")
            for index, param in enumerate(raw if isinstance(raw, list) else []):
                param, pointer = self.deref(param, owner_ptr + _ptr("parameters", index))
                if isinstance(param.get("name"), str) and isinstance(param.get("in"), str):
                    merged[(param["name"], param["in"])] = (param, pointer)
        return merged

    def body(self, params: Dict[Tuple[str, str], Tuple[dict, str]], op: dict, op_ptr: str) -> Tuple[bool, bool, Dict[str, Tuple[Any, str]]]:
        """(present, required, {media type: (schema node, pointer)}). Swagger 2.0
        bodies use the pseudo media type "body"."""
        if "requestBody" in op:
            body, pointer = self.deref(op.get("requestBody"), op_ptr + "/requestBody")
            return bool(body), body.get("required") is True, self._media(body, pointer)
        for (_, where), (param, pointer) in params.items():
            if where == "body":
                schemas = {"body": (param["schema"], pointer + "/schema")} if isinstance(param.get("schema"), dict) else {}
                return True, param.get("required") is True, schemas
        return False, False, {}

    def responses(self, op: dict, op_ptr: str) -> Dict[str, Dict[str, Tuple[Any, str]]]:
        """{status code: {media type: (schema node, pointer)}} for 2xx responses."""
        found: Dict[str, Dict[str, Tuple[Any, str]]] = {}
        for code, response in _d(op.get("responses")).items():
            code = str(code).upper()
            if not code.startswith("2"):
                continue
            response, pointer = self.deref(response, op_ptr + _ptr("responses", code))
            if "content" in response:
                found[code] = self._media(response, pointer)
            elif isinstance(response.get("schema"), dict):
                found[code] = {"body": (response["schema"], pointer + "/schema")}
        return found

    @staticmethod
    def _media(holder: dict, pointer: str) -> Dict[str, Tuple[Any, str]]:
        return {
            str(media): (value["schema"], pointer + _ptr("content", media, "schema"))
            for media, value in _d(holder.get("content")).items()
            if isinstance(value, dict) and isinstance(value.get("schema"), dict)
        }


def normalize_path(path: str) -> str:
    return re.sub(r"\{[^/{}]*\}", "{}", path.rstrip("/") or "/")


def _pair_media(base: Dict[str, Tuple[Any, str]], cand: Dict[str, Tuple[Any, str]]) -> List[Tuple[Tuple[Any, str], Tuple[Any, str]]]:
    common = [media for media in cand if media in base]
    if common:
        return [(base[media], cand[media]) for media in common]
    if base and cand and ("body" in base or "body" in cand):  # Swagger 2.0 against OpenAPI 3.x
        pick = lambda options: options.get("body") or options.get("application/json") or next(iter(options.values()))
        return [(pick(base), pick(cand))]
    return []


# ---- Diff ---------------------------------------------------------------------

def _types_text(types: Set[str]) -> str:
    return " | ".join(sorted(types))


def _response_type_compatible(before: Set[str], after: Set[str]) -> bool:
    """A response may narrow (number to integer) but must not produce a type the
    previous contract did not allow."""
    allowed = set(before) | ({"integer"} if "number" in before else set())
    return after <= allowed


def diff_specs(baseline: Spec, candidate: Spec) -> List[dict]:
    """Potentially breaking changes from `baseline` to `candidate`. Additive
    changes (new endpoints, new optional inputs, new response fields) are ignored."""
    old, new = _Reader(baseline.doc), _Reader(candidate.doc)
    findings: List[dict] = []
    seen: Set[Tuple[str, str, str, str, str]] = set()

    def add(change_type: str, path: str, method: str, previous: str, current: str, spec: Spec, pointer: str, description: str) -> None:
        key = (change_type, path, method, previous, current)
        if key in seen:
            return
        seen.add(key)
        findings.append({
            "change_type": change_type,
            "path": path,
            "method": method.upper(),
            "previous_value": previous,
            "new_value": current,
            "spec_file": spec.file,
            "json_pointer": pointer,
            "severity": _SEVERITY[change_type],
            "impact": f"{_IMPACT[change_type]} {_STATIC_ONLY}",
            # Additive fields (not read by the current dashboard):
            "classification": "POTENTIALLY_BREAKING",
            "description": description,
            "spec_repository": spec.repo,
        })

    def required_fields(before: _Schema, after: _Schema, prefix: str, path: str, method: str, visited: Set[Tuple[str, str]], depth: int = 0) -> None:
        if not before.known or not after.known or depth > 5 or (before.pointer, after.pointer) in visited:
            return
        visited.add((before.pointer, after.pointer))
        for name in sorted(after.required - before.required):
            if name in after.props and new.schema(*after.props[name]).read_only:
                continue  # read-only properties are never sent by clients
            was = "optional" if name in before.props else "absent"
            add("NEW_REQUIRED_REQUEST_FIELD", path, method, f"request field {prefix}{name}: {was}", f"request field {prefix}{name}: required",
                candidate, after.pointer + "/required", f"Request body field '{prefix}{name}' is required in {candidate.version_text} and was {was} in {baseline.version_text}.")
        for name in sorted(set(before.props) & set(after.props)):
            required_fields(old.schema(*before.props[name]), new.schema(*after.props[name]), f"{prefix}{name}.", path, method, visited, depth + 1)
        if before.items and after.items:
            required_fields(old.schema(*before.items), new.schema(*after.items), f"{prefix}[].", path, method, visited, depth + 1)

    def response_types(before: _Schema, after: _Schema, label: str, code: str, path: str, method: str, visited: Set[Tuple[str, str]], depth: int = 0) -> None:
        if not before.known or not after.known or depth > 6 or (before.pointer, after.pointer) in visited:
            return
        visited.add((before.pointer, after.pointer))
        if before.types and after.types and not _response_type_compatible(before.types, after.types):
            name = label or "body"
            add("CHANGED_RESPONSE_FIELD_TYPE", path, method, f"{code} response {name}: {_types_text(before.types)}", f"{code} response {name}: {_types_text(after.types)}",
                candidate, after.pointer + "/type", f"Response {name} of status {code} changed type from {_types_text(before.types)} to {_types_text(after.types)}.")
            return
        for name in sorted(set(before.props) & set(after.props)):
            child = f"{label}.{name}" if label else f"field {name}"
            response_types(old.schema(*before.props[name]), new.schema(*after.props[name]), child, code, path, method, visited, depth + 1)
        if before.items and after.items:
            response_types(old.schema(*before.items), new.schema(*after.items), f"{label or 'body'}[]", code, path, method, visited, depth + 1)

    new_paths = new.paths()
    for key, (path, item, item_ptr) in old.paths().items():
        methods = [m for m in HTTP_METHODS if isinstance(item.get(m), dict)]
        if key not in new_paths:
            if methods:
                add("REMOVED_PATH", path, "", "operations: " + ", ".join(m.upper() for m in methods), "path not present",
                    baseline, item_ptr, f"Path {path} exists in {baseline.version_text} and is absent from {candidate.version_text}.")
            continue
        new_path, new_item, new_item_ptr = new_paths[key]
        for method in methods:
            op, op_ptr = item[method], item_ptr + "/" + method
            if not isinstance(new_item.get(method), dict):
                add("REMOVED_OPERATION", path, method, "operation present", "operation not present",
                    baseline, op_ptr, f"{method.upper()} {path} exists in {baseline.version_text} and is absent from {candidate.version_text}.")
                continue
            new_op, new_op_ptr = new_item[method], new_item_ptr + "/" + method
            old_params = old.parameters(item, item_ptr, op, op_ptr)
            new_params = new.parameters(new_item, new_item_ptr, new_op, new_op_ptr)

            for (name, where), (param, pointer) in sorted(new_params.items()):
                # Path parameters are part of the path template; bodies are compared below.
                if where in ("path", "body") or param.get("required") is not True:
                    continue
                previous = old_params.get((name, where))
                if previous is not None and previous[0].get("required") is True:
                    continue
                was = "absent" if previous is None else "optional"
                add("NEW_REQUIRED_REQUEST_FIELD", new_path, method, f"{where} parameter {name}: {was}", f"{where} parameter {name}: required",
                    candidate, pointer, f"{where.capitalize()} parameter '{name}' is required in {candidate.version_text} and was {was} in {baseline.version_text}.")

            had_body, body_required, old_media = old.body(old_params, op, op_ptr)
            has_body, new_body_required, new_media = new.body(new_params, new_op, new_op_ptr)
            if has_body and new_body_required and not body_required:
                was = "optional" if had_body else "absent"
                add("NEW_REQUIRED_REQUEST_FIELD", new_path, method, f"request body: {was}", "request body: required",
                    candidate, new_op_ptr + ("/requestBody" if "requestBody" in new_op else "/parameters"),
                    f"The request body is required in {candidate.version_text} and was {was} in {baseline.version_text}.")
            for (before_node, before_ptr), (after_node, after_ptr) in _pair_media(old_media, new_media):
                required_fields(old.schema(before_node, before_ptr), new.schema(after_node, after_ptr), "", new_path, method, set())

            old_responses, new_responses = old.responses(op, op_ptr), new.responses(new_op, new_op_ptr)
            for code in sorted(set(old_responses) & set(new_responses)):
                for (before_node, before_ptr), (after_node, after_ptr) in _pair_media(old_responses[code], new_responses[code]):
                    response_types(old.schema(before_node, before_ptr), new.schema(after_node, after_ptr), "", code, new_path, method, set())

    order = {method.upper(): index for index, method in enumerate(HTTP_METHODS, start=1)}
    findings.sort(key=lambda f: (f["path"], order.get(f["method"], 0), f["change_type"], f["previous_value"]))
    return findings


# ---- Relationships between specifications ------------------------------------------

@dataclass
class RepoInput:
    """What discovery produced for one scan target."""

    name: str
    specs: Dict[str, str] = field(default_factory=dict)
    #: Why no specification could be looked for or read (pasted input, repository unreadable).
    unavailable_reason: str = ""
    #: {path: reason} for specification files that were found but could not be downloaded.
    fetch_errors: Dict[str, str] = field(default_factory=dict)


@dataclass
class Comparison:
    """One verified baseline to candidate comparison of the same API."""

    baseline: Spec
    candidate: Spec
    basis: str
    findings: List[dict]
    #: Repositories that hold a specification of this API; they are not treated as consumers.
    holders: Set[str] = field(default_factory=set)

    def meta(self) -> dict:
        return {"relationship": {"same_api_basis": self.basis}, "baseline": self.baseline.ref(), "candidate": self.candidate.ref()}


def _entry(repo: str, status: str, message: str, spec_file: str = "", consumer: str = "", findings: Optional[List[dict]] = None, **extra: Any) -> dict:
    return {"provider_repo": repo, "consumer_repo": consumer, "status": status, "spec_file": spec_file, "message": message, "findings": findings or [], **extra}


def same_api_groups(specs: List[Spec]) -> Tuple[List[Tuple[str, List[Spec]]], List[Tuple[Spec, str]]]:
    """Groups of specifications that are verifiably the same API, plus the
    specifications whose identity is unusable and the reason why.

    Identity is an explicit x-api-id / x-service-id, otherwise an exact match of
    the normalized, non-generic title. Paths are never consulted."""
    ids_by_title: Dict[str, Set[str]] = {}
    for spec in specs:
        if spec.explicit_id and spec.title_key:
            ids_by_title.setdefault(spec.title_key, set()).add(spec.explicit_id)
    groups: Dict[Tuple[str, str], List[Spec]] = {}
    unusable: List[Tuple[Spec, str]] = []
    for spec in specs:
        if spec.explicit_id:
            groups.setdefault(("id", spec.explicit_id), []).append(spec)
        elif not spec.title_key:
            reason = "it has no info.title" if not spec.title else f'its title "{spec.title}" is a generic default'
            unusable.append((spec, f"The API identity could not be established: {reason} and there is no x-api-id."))
        elif len(ids_by_title.get(spec.title_key, ())) > 1:
            unusable.append((spec, f'The title "{spec.title}" matches specifications with different x-api-id values, so it is not known which API this is.'))
        elif ids_by_title.get(spec.title_key):
            groups.setdefault(("id", next(iter(ids_by_title[spec.title_key]))), []).append(spec)
        else:
            groups.setdefault(("title", spec.title_key), []).append(spec)
    labelled = []
    for (kind, _), members in groups.items():
        all_explicit = all(member.explicit_id for member in members)
        basis = "matching x-api-id" if kind == "id" and all_explicit else "matching normalized info.title"
        labelled.append((basis, members))
    return labelled, unusable


def analyze_specs(repos: List[RepoInput]) -> Tuple[List[dict], List[Comparison]]:
    """Contract-analysis entries for every repository, and the verified
    comparisons (used afterwards to look for consumer references)."""
    per_repo: Dict[str, List[dict]] = {repo.name: [] for repo in repos}
    specs: List[Spec] = []
    comparisons: List[Comparison] = []

    for repo in repos:
        for path, reason in sorted(repo.fetch_errors.items()):
            per_repo[repo.name].append(_entry(repo.name, SPEC_UNAVAILABLE, f"A specification file was found but could not be read: {reason}.", path))
        for path in sorted(repo.specs, key=lambda p: (p.count("/"), p)):
            try:
                specs.append(Spec(repo.name, path, parse_spec(repo.specs[path], path)))
            except MalformedSpec as error:
                per_repo[repo.name].append(_entry(repo.name, MALFORMED_SPEC, f"{path} could not be parsed: {error}.", path))
        if not repo.specs and not repo.fetch_errors:
            message = repo.unavailable_reason or (
                "No OpenAPI or Swagger file (openapi/swagger .json, .yaml, .yml) was found at the repository root or under "
                + ", ".join(f"{name}/" for name in SPEC_DIRS) + "."
            )
            per_repo[repo.name].append(_entry(repo.name, SPEC_UNAVAILABLE, message))

    def put(spec: Spec, status: str, message: str, **extra: Any) -> None:
        per_repo[spec.repo].append(_entry(spec.repo, status, message, spec.file, api=spec.ref(), **extra))

    groups, unusable = same_api_groups(specs)
    for spec, reason in unusable:
        put(spec, RELATIONSHIP_UNVERIFIED if len(specs) > 1 else NOT_COMPARED,
            f"{spec.describe()} was read. {reason} It was not compared with any other specification.")

    for basis, members in groups:
        if len(members) == 1:
            put(members[0], NOT_COMPARED, f"{members[0].describe()} was read. No other version of this API was found among the scanned repositories, so nothing was compared.")
            continue
        by_version: Dict[Version, List[Spec]] = {}
        for spec in members:
            if spec.version is None:
                detail = f'"{spec.version_text}" is not an orderable version' if spec.version_text else "info.version is missing"
                put(spec, RELATIONSHIP_UNVERIFIED, f"{spec.describe()} is the same API as {len(members) - 1} other specification(s) ({basis}), but {detail}. "
                    "Without a version order no baseline can be chosen, so nothing was compared.")
            else:
                by_version.setdefault(spec.version, []).append(spec)
        ordered: List[Spec] = []
        for version in sorted(by_version):
            holders = by_version[version]
            if len(holders) > 1:
                for spec in holders:
                    others = ", ".join(f"{o.repo}/{o.file}" for o in holders if o is not spec)
                    put(spec, RELATIONSHIP_UNVERIFIED, f"{spec.describe()} declares the same version as {others}. With equal versions no baseline can be chosen, so nothing was compared.")
            else:
                ordered.append(holders[0])
        if len(ordered) == 1:
            put(ordered[0], RELATIONSHIP_UNVERIFIED, f"{ordered[0].describe()} is the same API as other specification(s) in this scan ({basis}), "
                "but none of them has a distinct, orderable version to compare against.")
        holders_of_api = {spec.repo for spec in members}
        for baseline, candidate in zip(ordered, ordered[1:]):
            findings = diff_specs(baseline, candidate)
            comparison = Comparison(baseline, candidate, basis, findings, holders_of_api)
            comparisons.append(comparison)
            count = f"{len(findings)} potentially breaking change(s) detected" if findings else "No removed operation, newly required request field or changed response type was detected"
            message = (
                f'Compared "{candidate.label}" {baseline.version_text} ({baseline.repo}/{baseline.file}) with {candidate.version_text} '
                f"({candidate.repo}/{candidate.file}); same API by {basis}, order by info.version. {count}. "
                "This is a static comparison of specification files and does not prove a runtime failure."
            )
            per_repo[candidate.repo].append(_entry(candidate.repo, ANALYZED, message, candidate.file, findings=findings, **comparison.meta()))

    return [entry for repo in repos for entry in per_repo[repo.name]], comparisons


# ---- Consumer references ----------------------------------------------------------
#
# Three separate questions, answered separately:
#   1. Does a string literal denote a path of the API?        (_path_pattern)
#   2. Which HTTP method does the call that uses it send?     (_call_context)
#   3. Is the call addressed to THIS provider?                (_evidence)
# A path match alone never answers the third question.

_PARAM = r"""(?:\$\{[^}"'`\n]*\}|\{[^}"'`\n]*\}|:[A-Za-z_]\w*|%[sd]|<[^>"'`\n]*>|[A-Za-z0-9_.~-]+)"""
_QUOTE = r"""["'`]"""
_PRE = r"""(?P<pre>[^\s"'`]*?)"""
#: Stands for a value joined in by string concatenation: "/orders/" + id.
_JOINED = "${+}"
_BLOCKED = "\x00"
_JOIN_MIDDLE = re.compile(r"""["'`][ \t]*\+[ \t]*[^"'`+\n]{1,80}?[ \t]*\+[ \t]*["'`]""")   # "a/" + x + "/b"
_JOIN_LITERALS = re.compile(r"""["'`][ \t]*\+[ \t]*["'`]""")                                # "a" + "/b"
_JOIN_SPLIT = re.compile(r"""(?P<q>["'`])(?=[ \t]*\+\s*["'`])""")                           # "a" +\n "/b": not followed
_JOIN_END = re.compile(r"""(?P<q>["'`])(?=[ \t]*\+)""")                                     # "a/" + x
#: What may stand between the opening quote and the path: nothing, one base-URL
#: placeholder, or a scheme and host. Never further path segments.
_PLACEHOLDER = r"""(?:\$\{[^{}"'`\n]*\}|\{[^{}"'`\n]*\}|%s|\$\w+)"""
_PREFIX_HEAD = re.compile(rf"""(?:{_PLACEHOLDER}|https?://[^/\s]+)?""")
_COMMENT = ("#", "//", "/*", "*", "<!--")
#: Lines that declare a server route rather than call one.
_ROUTE_DEFINITION = re.compile(
    r"""@\s*[\w.]*\b(?:get|post|put|delete|patch|route|api_route|websocket)\s*\(|@\w*Mapping\b|@Path\b|"""
    r"""\b(?:app|router|blueprint|bp|server|fastify|routes?)\.(?:get|post|put|delete|patch|all|use|route|add_url_rule)\s*\(""",
    re.IGNORECASE,
)
_TOKEN = re.compile(r'''"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|[()]''')
_CALLEE = re.compile(r"""([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()\n]{0,40}>)?\s*$""")
_VERBS = ("get", "post", "put", "delete", "patch", "head", "options")
_VERB_CALLEE = re.compile(r"(get|post|put|delete|patch|head|options)(?:For(?:Object|Entity|Location))?$", re.IGNORECASE)
_METHOD_OPTION = re.compile(r"""\bmethod["']?\s*[:=]\s*["'`](\w+)["'`]|\bHttpMethod\.(\w+)|["'](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["']""")
_MAX_CALL_DISTANCE = 400
_MAX_CALL_SPAN = 1500
_IDENTIFIER = re.compile(r"[A-Za-z_$][\w$]*")
_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+")
_NOT_A_NAME = {"self", "this", "process", "env", "os", "environ", "window", "await", "return", "new", "const", "let", "var", "str", "String", "f"}
#: Words that say nothing about which API is meant.
_IDENTITY_STOPWORDS = {
    "api", "apis", "service", "services", "rest", "http", "https", "openapi", "swagger", "internal", "public", "server", "backend",
    "frontend", "client", "core", "main", "base", "data", "test", "prod", "demo", "example", "sample", "default", "version", "docs",
    "spec", "specs", "open", "application", "platform", "system", "gateway", "microservice", "json", "yaml", "with", "from", "this", "that",
}
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal")


def base_paths(*docs: dict) -> List[str]:
    """Path prefixes the specifications declare (servers[].url, basePath), plus none."""
    found = {""}
    for doc in docs:
        for url in [*_server_urls(doc), doc.get("basePath")]:
            if not isinstance(url, str):
                continue
            path = (urlparse(url).path if "://" in url else url).rstrip("/")
            if path.startswith("/") and "{" not in path:
                found.add(path)
    return sorted(found, key=lambda path: (-len(path), path))  # longest first, deterministic


def _server_urls(doc: dict) -> List[Any]:
    servers = doc.get("servers")
    return [server.get("url") for server in servers if isinstance(server, dict)] if isinstance(servers, list) else []


def provider_hosts(*docs: dict) -> List[str]:
    """Hosts the specifications say the API is served from (servers[].url, Swagger
    `host`). Local and templated hosts identify nothing and are left out."""
    found: Set[str] = set()
    for doc in docs:
        hosts = [urlparse(url).netloc for url in _server_urls(doc) if isinstance(url, str) and "://" in url]
        if isinstance(doc.get("host"), str):
            hosts.append(doc["host"])
        for host in hosts:
            host = host.strip().lower()
            if host and "{" not in host and "." in host and not host.startswith(_LOCAL_HOSTS):
                found.add(host)
    return sorted(found)


def _words(text: str) -> Set[str]:
    """Lowercase words of an identifier or phrase, singular: ORDERS_URL, ordersApi -> order."""
    return {word.lower().rstrip("s") for word in _WORD.findall(text)}


def identity_words(*names: str) -> List[str]:
    """Distinctive words of an API's title, id and repository names."""
    found: Set[str] = set()
    for name in names:
        for word in _WORD.findall(name or ""):
            word = word.lower()
            if len(word) >= 4 and word not in _IDENTITY_STOPWORDS:
                found.add(word.rstrip("s"))
    return sorted(found)


def _prefix_ok(pre: str, bases: Iterable[str]) -> bool:
    """The text between the opening quote and the path may only be a base-URL
    placeholder or a scheme and host, optionally followed by a base path the
    specification declares. "/internal/admin/users" and "/t/${tenant}/users"
    are therefore not references to "/users"."""
    for base in bases:
        if base and not pre.endswith(base):
            continue
        head = pre[: len(pre) - len(base)] if base else pre
        if _PREFIX_HEAD.fullmatch(head):
            return True
    return False


def _join_concatenations(text: str) -> str:
    """Rewrite string concatenation so that one logical URL is one literal:
    "/orders/" + id + "/items" becomes "/orders/${+}/items". Without this the
    first fragment would look like a complete, shorter path. Line breaks are
    kept, so line numbers still refer to the original file."""
    text = _JOIN_MIDDLE.sub(_JOINED, text)
    text = _JOIN_LITERALS.sub("", text)
    text = _JOIN_SPLIT.sub(lambda match: _BLOCKED + match.group("q"), text)  # continues on the next line: not attributed
    return _JOIN_END.sub(lambda match: _JOINED + match.group("q"), text)


def _path_pattern(path: str) -> Optional[Tuple[re.Pattern, int, str]]:
    """(pattern, static segment count, prefilter needle) for one path template.

    The whole literal must be the path: after it only a trailing slash, a query
    string, a fragment, or a joined-on suffix may follow. "/orders/123/items"
    is therefore never a reference to "/orders" or to "/orders/{id}"."""
    if normalize_path(path) in GENERIC_PATHS:
        return None
    segments = path.strip("/").split("/")
    static = [segment for segment in segments if segment and "{" not in segment]
    if not static:
        return None
    parts = []
    for segment in segments:
        pieces = re.split(r"(\{[^/{}]*\})", segment)
        parts.append("".join(_PARAM if piece.startswith("{") else re.escape(piece) for piece in pieces if piece))
    tail = r"""(?:/?(?:[?#][^\s"'`]*)?|\$\{\+\})(?=["'`])"""
    pattern = re.compile(r"(?P<q>" + _QUOTE + ")" + _PRE + "(?P<p>/" + "/".join(parts) + ")" + tail)
    return pattern, len(static), "/" + max(static, key=len)


def _call_index(text: str) -> Tuple[Dict[int, Tuple[int, ...]], Dict[int, int]]:
    """For every string literal, the open parentheses that enclose it (innermost
    last), and where each parenthesis closes. Parentheses inside strings are
    not counted."""
    stack: List[int] = []
    enclosing: Dict[int, Tuple[int, ...]] = {}
    closes: Dict[int, int] = {}
    for match in _TOKEN.finditer(text):
        token = match.group()
        if token == "(":
            stack.append(match.start())
        elif token == ")":
            if stack:
                closes[stack.pop()] = match.start()
        else:
            enclosing[match.start()] = tuple(stack[-2:])
    return enclosing, closes


def _callee(text: str, open_paren: int) -> str:
    match = _CALLEE.search(text, max(0, open_paren - 120), open_paren)
    return re.sub(r"\s+", "", match.group(1)) if match else ""


def _verb(callee: str) -> str:
    match = _VERB_CALLEE.match(callee.rsplit(".", 1)[-1])
    return match.group(1).upper() if match else ""


def _call_context(text: str, literal_start: int, enclosing: Dict[int, Tuple[int, ...]], closes: Dict[int, int]) -> Tuple[List[str], str]:
    """(HTTP methods, callee) of the invocation that receives the literal.

    Only that invocation is consulted: its name (`axios.post(`), or a method
    named inside its own parentheses (`fetch(url, {method: 'POST'})`,
    `requests.request("POST", url)`). Neighbouring statements, comments and
    log messages are never read. An empty list means the method is unknown."""
    opens = enclosing.get(literal_start)
    if not opens or literal_start - opens[-1] > _MAX_CALL_DISTANCE:
        return [], ""
    inner = opens[-1]
    callee = _callee(text, inner)
    if _verb(callee):
        return [_verb(callee)], callee
    close = closes.get(inner)
    if close is not None and close - inner <= _MAX_CALL_SPAN:
        span = text[inner: close + 1]
        named = {(m.group(1) or m.group(2) or m.group(3)).upper() for m in _METHOD_OPTION.finditer(span)} & {verb.upper() for verb in _VERBS}
        if named:
            return sorted(named), callee
        if callee.rsplit(".", 1)[-1] == "fetch" and "," not in _TOKEN.sub(lambda m: "" if m.group() not in "()" else m.group(), span):
            return ["GET"], callee  # fetch(url) with no options is a GET
    if len(opens) == 2 and literal_start - opens[0] <= _MAX_CALL_DISTANCE and _verb(_callee(text, opens[0])):
        outer = _callee(text, opens[0])  # axios.get(url(`...`)), requests.get(urljoin(base, "..."))
        return [_verb(outer)], outer
    return [], callee


def _statement(text: str, start: int) -> str:
    """The assignment that starts at `start`: its line, continued only while a
    bracket is still open (axios.create({ ... })), at most five lines. Later
    statements are never included, so their paths cannot pass as a name."""
    lines = text[start: start + 600].split("\n")[:5]
    kept: List[str] = []
    depth = 0
    for line in lines:
        kept.append(line)
        depth += sum(line.count(char) for char in "([{") - sum(line.count(char) for char in ")]}")
        if depth <= 0:
            break
    return "\n".join(kept)


def _evidence(original: str, pre: str, callee: str, hosts: Iterable[str], words: Iterable[str]) -> List[str]:
    """Signals that the call is addressed to this provider, or [] when there is none.

    Looked at: the URL prefix of the literal, the object the call is made on,
    and (one step back, in the same file) the lines that assign those names.
    A signal is a server host from the specification, or a name containing a
    distinctive word of the API's title, id or repository."""
    names = [name for name in _IDENTIFIER.findall(pre) + callee.split(".")[:-1] if name not in _NOT_A_NAME]
    context = [pre, *names]
    for name in dict.fromkeys(names):
        assignment = re.compile(rf"(?<![\w$]){re.escape(name)}\s*(?::[^=\n]{{0,40}})?=(?![=>])")
        context.extend(_statement(original, match.start()) for match in list(assignment.finditer(original))[:5])
    joined = " ".join(context)
    lowered = joined.lower()
    found = [f"server host {host}" for host in hosts if host in lowered]
    named = sorted(set(words) & _words(joined))
    if named:
        found.append(f"identifier naming the API ({', '.join(named)})")
    return found


def find_references(paths: Iterable[str], bases: List[str], files: Dict[str, str], hosts: Iterable[str] = (), words: Iterable[str] = ()) -> Dict[str, List[dict]]:
    """{spec path: references} for string literals in `files` that are a path of
    the API. Comment lines and server route declarations are skipped. When a
    literal fits several templates, only the most specific one keeps it.

    Each reference carries the methods of its own call and `evidence`: the
    signals tying it to this provider (empty when there are none)."""
    hosts, words = list(hosts), list(words)
    compiled = {path: pattern for path in dict.fromkeys(paths) if (pattern := _path_pattern(path))}
    found: Dict[str, List[dict]] = {}
    for file in sorted(files):
        original = files[file]
        candidates = [(path, pattern) for path, pattern in compiled.items() if pattern[2] in original]
        if not candidates:
            continue
        text = _join_concatenations(original)
        lines = original.splitlines()
        hits: Dict[int, List[Tuple[int, str, re.Match]]] = {}  # path start -> [(static segments, path, match)]
        for path, (pattern, static_count, _) in candidates:
            for match in pattern.finditer(text):
                if _prefix_ok(match.group("pre"), bases):
                    hits.setdefault(match.start("p"), []).append((static_count, path, match))
        if not hits:
            continue
        enclosing, closes = _call_index(text)
        for start in sorted(hits):
            number = text.count("\n", 0, start) + 1
            line = lines[number - 1] if number <= len(lines) else ""
            if line.strip().startswith(_COMMENT) or _ROUTE_DEFINITION.search(line):
                continue
            best = max(weight for weight, _, _ in hits[start])
            for weight, path, match in hits[start]:
                if weight != best:
                    continue
                methods, callee = _call_context(text, match.start("q"), enclosing, closes)
                found.setdefault(path, []).append({
                    "file": file, "line": number, "snippet": line.strip()[:240],
                    "match": "concatenated" if _JOINED in match.group() else "exact",
                    "methods": methods,
                    "evidence": _evidence(original, match.group("pre"), callee, hosts, words),
                })
    return found


def _public(consumer: str, ref: dict) -> dict:
    return {"repository": consumer, **{key: ref[key] for key in ("file", "line", "snippet", "match")}}


def consumer_entry(comparison: Comparison, consumer: str, files: Optional[Dict[str, str]], not_scanned_reason: str = "") -> dict:
    """How `consumer` relates to the changed API: a provider to consumer entry.

    ANALYZED requires a reference that is tied to this provider by a server
    host or a naming signal. Path matches without such a signal, no matches,
    and unscanned source are all RELATIONSHIP_UNVERIFIED, never "not affected"."""
    candidate, baseline = comparison.candidate, comparison.baseline
    api = f'"{candidate.label}"'
    meta = comparison.meta()
    common = {"spec_file": candidate.file, "consumer": consumer}
    if files is None:
        return _entry(candidate.repo, RELATIONSHIP_UNVERIFIED, f"{consumer} was not checked for calls to {api}: {not_scanned_reason}. Whether it consumes this API is unverified.", **common, **meta)

    old_paths = {path for path, _, _ in _Reader(baseline.doc).paths().values()}
    new_paths = {path for path, _, _ in _Reader(candidate.doc).paths().values()}
    references = find_references(
        sorted(old_paths | new_paths), base_paths(baseline.doc, candidate.doc), files,
        provider_hosts(baseline.doc, candidate.doc),
        identity_words(baseline.title, candidate.title, baseline.explicit_id, candidate.explicit_id, *sorted(comparison.holders)),
    )
    if not references:
        return _entry(candidate.repo, RELATIONSHIP_UNVERIFIED,
                      f"No reference to an endpoint of {api} was found in the {len(files)} source file(s) read from {consumer}. "
                      "A provider-consumer relationship is unverified; it is not ruled out.", **common, **meta)

    verified = {path: [ref for ref in refs if ref["evidence"]] for path, refs in references.items()}
    verified = {path: refs for path, refs in verified.items() if refs}
    unattributed = [{"path": path, **_public(consumer, ref)} for path in sorted(references) for ref in references[path] if not ref["evidence"]]
    extra = {"possible_references": unattributed[:_MAX_REFERENCES]} if unattributed else {}

    def listed(paths: Iterable[str]) -> str:
        paths = sorted(paths)
        return ", ".join(paths[:5]) + (f" and {len(paths) - 5} more" if len(paths) > 5 else "")

    if not verified:
        shared = sorted({item["path"] for item in unattributed})
        return _entry(candidate.repo, RELATIONSHIP_UNVERIFIED,
                      f"{consumer} contains {len(unattributed)} string(s) matching path(s) that {api} also defines ({listed(shared)}), but nothing ties them to this API: "
                      "no server host from the specification and no identifier naming the API was found. Other services expose the same paths, "
                      "so a shared path does not establish a provider-consumer relationship.", **common, **meta, **extra)

    signals = sorted({signal for refs in verified.values() for ref in refs for signal in ref["evidence"]})
    meta["relationship"] = {**meta["relationship"], "consumer_evidence": signals}
    affected: List[dict] = []
    for finding in comparison.findings:
        refs = [
            ref for ref in verified.get(finding["path"], [])
            if not finding["method"] or not ref["methods"] or finding["method"] in ref["methods"]
        ]
        if not refs:
            continue
        first = refs[0]
        joined = " (the path is built by concatenation)" if first["match"] == "concatenated" else ""
        more = f" and {len(refs) - 1} more place(s)" if len(refs) > 1 else ""
        affected.append({
            **finding,
            "classification": "CONSUMER_REFERENCE_FOUND",
            "impact": (
                f"{consumer} references this endpoint at {first['file']}:{first['line']}{joined}{more}. {_IMPACT[finding['change_type']]} "
                "A matching call in source code is evidence of use, not proof that it reaches this service or fails at runtime."
            ),
            "consumer_references": [_public(consumer, ref) for ref in refs[:_MAX_REFERENCES]],
        })
    basis = f"Tied to this API by: {'; '.join(signals)}."
    if affected:
        message = (f"{consumer} references {len(verified)} endpoint(s) of {api} ({listed(verified)}); {len(affected)} change(s) between "
                   f"{baseline.version_text} and {candidate.version_text} touch them. {basis}")
    else:
        message = (f"{consumer} references {len(verified)} endpoint(s) of {api} ({listed(verified)}). None of the changes between "
                   f"{baseline.version_text} and {candidate.version_text} touches an endpoint it references. {basis}")
    return _entry(candidate.repo, ANALYZED, message, findings=affected, **common, **meta, **extra)
