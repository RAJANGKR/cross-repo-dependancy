"""Field-level consumer usage: what a call site reads from a response and what
it sends in a request.

Source code is parsed, never executed: Python with the standard `ast` module,
JavaScript and TypeScript with tree-sitter. Given a file and the line of a URL
that was already matched to an API operation (openapi_diff_engine.py), this
module finds the HTTP call that uses that URL and reports

  * the response fields the code reads (`resp.json()["customer"]["legacy_id"]`,
    `res.data.customer.legacy_id`, destructuring, loops and array callbacks);
  * the request body keys, query parameters and headers the call sends;
  * every place where the analysis loses track of the value (a dynamic key, a
    value passed to another function, a payload built elsewhere).

Losing track is reported as UNRESOLVED with the reason. It is never turned
into "the field is not used", and nothing here is a runtime observation.

Three rules keep claims within the evidence:

  * A call is followed into another function only when the source establishes
    where it goes: a definition in scope, an import from an inspected file, a
    method of the same class, or a method of a class instantiated in the file.
    A matching function name alone is never followed.
  * "The request does not send X" is concluded only when the client is fully
    visible: a direct library call, or a session / axios instance whose
    configuration and interceptors could be read. A value that is set under a
    condition is reported as possibly sent, not as sent.
  * The HTTP method is taken only from what the call states. A URL never
    implies a method.
"""
import ast
import posixpath
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

try:  # optional at import time: without it JS/TS call sites are reported as UNRESOLVED
    import tree_sitter_javascript
    import tree_sitter_typescript
    from tree_sitter import Language, Parser

    _JS_AVAILABLE = True
except Exception:  # pragma: no cover - depends on the installation
    _JS_AVAILABLE = False

T1_OPERATION_MATCH = "T1_OPERATION_MATCH"
T2_FIELD_MATCH = "T2_FIELD_MATCH"
UNRESOLVED = "UNRESOLVED"

CALLS_OPERATION = "CALLS_OPERATION"
READS_CHANGED_FIELD = "READS_CHANGED_FIELD"
FIELD_NOT_READ = "FIELD_NOT_READ"
OMITS_REQUIRED_FIELD = "OMITS_REQUIRED_FIELD"
SENDS_REQUIRED_FIELD = "SENDS_REQUIRED_FIELD"
#: The newly required value is set on some code paths before the request, not on all of them.
MAY_SEND_REQUIRED_FIELD = "MAY_SEND_REQUIRED_FIELD"
NOT_DETERMINED = "NOT_DETERMINED"

_MAX_DEPTH = 2
_VERBS = {"get", "post", "put", "delete", "patch", "head", "options"}
_BODY_VERBS = {"post", "put", "patch"}

Value = Tuple[Any, ...]  # ("resp",) for an HTTP response object, ("data", path) for decoded body data
RESP: Value = ("resp",)


def _data(path: Tuple[str, ...] = ()) -> Value:
    return ("data", path)


def normalize_field(path: Iterable[str]) -> str:
    """Dotted field name without array markers: ("data", "[]", "id") -> "data.id"."""
    return ".".join(part for part in path if part and part != "[]")


def _step(value: Optional[Value], key: str) -> Optional[Value]:
    """The value reached from `value` through one property, key or array element."""
    if value is None:
        return None
    if value == RESP:
        # axios and superagent expose the decoded body as a property of the response.
        return _data() if key in ("data", "body") else None
    return _data(value[1] + (key,))


def _covers(prefix: str, name: str) -> bool:
    return prefix == "" or name == prefix or name.startswith(prefix + ".")


@dataclass
class Trace:
    """What happens to one response."""

    reads: Dict[str, Tuple[str, int]] = field(default_factory=dict)      # field -> (file, line)
    opens: List[Tuple[str, str, str, int]] = field(default_factory=list)  # (field prefix, reason, file, line)
    body_read: Optional[Tuple[str, int]] = None

    def merge(self, other: "Trace") -> None:
        for name, where in other.reads.items():
            self.reads.setdefault(name, where)
        self.opens.extend(other.opens)
        self.body_read = self.body_read or other.body_read


@dataclass
class Sent:
    """Keys a call sends in one place (body, query or headers)."""

    present: bool = False
    keys: Set[str] = field(default_factory=set)
    #: False when some keys could not be enumerated; `reason` says why.
    complete: bool = True
    reason: str = ""
    #: Keys whose nested content is not a literal.
    opaque: Set[str] = field(default_factory=set)
    #: Keys set only on some code paths before the request: {key: line}. Never also in `keys`.
    conditional: Dict[str, int] = field(default_factory=dict)
    #: Where a key comes from when it is not written in the call itself: {key: description}.
    origin: Dict[str, str] = field(default_factory=dict)

    def unknown(self, reason: str) -> "Sent":
        self.present, self.complete, self.reason = True, False, self.reason or reason
        return self

    def limit(self, reason: str) -> "Sent":
        """Something outside what was read may add or change keys. Keys already seen stay valid."""
        self.complete, self.reason = False, self.reason or reason
        return self

    def add(self, key: str, state: str = "definite", line: int = 0, origin: str = "") -> None:
        """`state` is "definite", "conditional" or "never" (the statement cannot run before the request)."""
        if state == "never":
            return
        self.present = True
        if state == "definite":
            self.keys.add(key)
            self.conditional.pop(key, None)
        elif key not in self.keys:
            self.conditional.setdefault(key, line)
        if origin:
            self.origin.setdefault(key, origin)

    def absorb(self, other: "Sent", state: str = "definite", line: int = 0, origin: str = "") -> None:
        if state == "never":
            return
        for key in other.keys:
            self.add(key, state, line, origin or other.origin.get(key, ""))
        for key, where in other.conditional.items():
            self.add(key, "conditional", where, origin or other.origin.get(key, ""))
        self.opaque |= other.opaque
        if not other.complete:
            self.limit(other.reason)


@dataclass
class CallFacts:
    file: str
    line: int
    located: bool = False
    reason: str = ""
    trace: Trace = field(default_factory=Trace)
    body: Sent = field(default_factory=Sent)
    query: Sent = field(default_factory=Sent)
    headers: Sent = field(default_factory=Sent)
    #: HTTP method when the call states it (`requests.delete(...)`, `{ method: 'POST' }`); "" when it
    #: cannot be told from the call, in which case `method_reason` says why. Never guessed from the URL.
    method: str = ""
    method_reason: str = ""


@dataclass
class _Site:
    """One place where a name is bound. `node` is the expression it is bound to
    (None when the value is of no interest) and `steps` the path from there."""

    name: str
    pos: Any
    span: Tuple[Any, Any]
    node: Any
    steps: Tuple[str, ...] = ()
    line: int = 0
    #: True for a binding that deliberately replaces an earlier one (React state set through its setter).
    replaces: bool = False


_URL_QUERY_KEY = re.compile(r"[?&]([A-Za-z_][\w.\-\[\]]*)=")
_URL_OPEN_QUERY = re.compile(r"""\?\s*[{$%]|[?&]["'`]\s*\+|[?&]\s*$""")


def _query_from_url(source: str, sent: Sent) -> None:
    for key in _URL_QUERY_KEY.findall(source):
        sent.present = True
        sent.keys.add(key)
    if _URL_OPEN_QUERY.search(source):
        sent.unknown("the query string is built dynamically")


class _Tracer:
    """Language-neutral bookkeeping: name resolution by position, reads, opens."""

    def __init__(self, file: str, seeds: Dict[Any, Value]):
        self.file = file
        self.seeds = seeds
        self.sites: Dict[str, List[_Site]] = {}
        self.memo: Dict[Any, Optional[Value]] = {}
        self.dynamic: Dict[Any, Tuple[str, str, int]] = {}
        self.returned: List[Tuple[Value, int]] = []
        #: Traced values given to another function: (the call, argument index or keyword, argument node, value, line).
        self.passed: List[Tuple[Any, Any, Any, Value, int]] = []
        self.trace = Trace()

    def add_site(self, name: str, pos: Any, span: Tuple[Any, Any], node: Any, steps: Tuple[str, ...] = (), line: int = 0, replaces: bool = False) -> None:
        self.sites.setdefault(name, []).append(_Site(name, pos, span, node, steps, line, replaces))

    def resolve(self, name: str, pos: Any) -> Optional[Value]:
        """The binding of `name` visible at `pos`: innermost scope, latest before the use."""
        candidates = [site for site in self.sites.get(name, ()) if site.span[0] <= pos <= site.span[1] and site.pos <= pos]
        if not candidates:
            return None
        innermost = max(site.span[0] for site in candidates)
        site = max((site for site in candidates if site.span[0] == innermost), key=lambda item: item.pos)
        return self.site_value(site)

    def site_value(self, site: _Site) -> Optional[Value]:
        value = self.value_of(site.node) if site.node is not None else None
        for key in site.steps:
            value = _step(value, key)
        return value

    def value_of(self, node: Any) -> Optional[Value]:
        key = self.key(node)
        if key in self.seeds:
            return self.seeds[key]
        if key in self.memo:
            return self.memo[key]
        self.memo[key] = None  # guards against cycles
        self.memo[key] = value = self.evaluate(node)
        return value

    def note_read(self, value: Optional[Value], line: int) -> None:
        if value is None or value[0] != "data":
            return
        self.trace.body_read = self.trace.body_read or (self.file, line)
        if value[1]:
            self.trace.reads.setdefault(normalize_field(value[1]), (self.file, line))

    def note_open(self, value: Optional[Value], reason: str, line: int) -> None:
        if value is not None:
            prefix = "" if value == RESP else normalize_field(value[1])
            self.trace.opens.append((prefix, reason, self.file, line))

    def finish(self) -> Trace:
        for name, sites in self.sites.items():
            values = [(site, self.site_value(site)) for site in sites]
            for site, value in values:
                self.note_read(value, site.line)
                # Assigned again in the same scope: which value a later read sees depends on control flow.
                if value is not None and not site.replaces and any(other.span == site.span and other.pos != site.pos and other_value != value for other, other_value in values):
                    self.note_open(value, f"the variable '{name}' is assigned more than once", site.line)
        for prefix, reason, line in self.dynamic.values():
            self.trace.opens.append((prefix, reason, self.file, line))
        return self.trace

    # Implemented per language:
    def key(self, node: Any) -> Any:
        raise NotImplementedError

    def evaluate(self, node: Any) -> Optional[Value]:
        raise NotImplementedError


# ---- Python ---------------------------------------------------------------------------

_PY_HTTP = _VERBS | {"request", "urlopen", "fetch", "send"}
_PY_HARMLESS = {"print", "len", "str", "int", "float", "bool", "repr", "isinstance", "type", "debug", "info", "warning", "error", "exception", "log", "dumps", "format"}
_PY_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.Module)


def _py_name(func: ast.AST) -> str:
    return func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""


def _py_start(node: ast.AST) -> Tuple[int, int]:
    return (node.lineno, node.col_offset)


def _py_end(node: ast.AST) -> Tuple[int, int]:
    return (node.end_lineno, node.end_col_offset)


class _PyFile:
    def __init__(self, file: str, text: str):
        self.file, self.text = file, text
        self.tree = ast.parse(text)
        self.parent: Dict[int, ast.AST] = {}
        #: Symbols a call can be resolved against. Only what the file itself states is recorded.
        self.functions: Dict[str, List[ast.AST]] = {}                 # module-level functions
        self.classes: Dict[str, Dict[str, List[ast.AST]]] = {}        # class -> method -> definitions
        self.imported: Dict[str, Tuple[str, str, int]] = {}           # local name -> (module, original name, relative level)
        self.modules: Dict[str, str] = {}                             # local name -> imported module
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parent[id(child)] = node
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    self.imported[alias.asname or alias.name] = (node.module or "", alias.name, node.level)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    self.modules[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
        for node in self.tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, []).append(node)
            elif isinstance(node, ast.ClassDef):
                methods = self.classes.setdefault(node.name, {})
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        methods.setdefault(item.name, []).append(item)

    def scope_of(self, node: ast.AST) -> ast.AST:
        current = self.parent.get(id(node))
        while current is not None and not isinstance(current, _PY_SCOPES):
            current = self.parent.get(id(current))
        return current or self.tree

    def class_of(self, node: ast.AST) -> str:
        current = self.parent.get(id(node))
        while current is not None and not isinstance(current, ast.ClassDef):
            current = self.parent.get(id(current))
        return current.name if current is not None else ""

    def guards(self, node: ast.AST) -> Dict[int, str]:
        """Conditions under which `node` runs, as {id of the branching statement: branch}."""
        found: Dict[int, str] = {}
        child, parent = node, self.parent.get(id(node))
        while parent is not None:
            inside = lambda block: any(child is item for item in block)
            if isinstance(parent, ast.If):
                if inside(parent.body) or inside(parent.orelse):
                    found[id(parent)] = "body" if inside(parent.body) else "orelse"
            elif isinstance(parent, ast.IfExp):
                if child is not parent.test:
                    found[id(parent)] = "body" if child is parent.body else "orelse"
            elif isinstance(parent, (ast.For, ast.AsyncFor, ast.While)):
                if inside(parent.body) or inside(parent.orelse):
                    found[id(parent)] = "loop"
            elif isinstance(parent, ast.Try):
                if inside(parent.body) or inside(parent.orelse):
                    found[id(parent)] = "try"
            elif isinstance(parent, ast.ExceptHandler):
                found[id(parent)] = "except"
            elif isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                found[id(parent)] = "function"
            child, parent = parent, self.parent.get(id(parent))
        return found

    def presence(self, statement: ast.AST, anchor: ast.AST) -> str:
        """Does `statement` run before `anchor` (the request)? "definite", "conditional" or "never"."""
        mine, theirs = self.guards(statement), self.guards(anchor)
        if any(key in theirs and theirs[key] != label for key, label in mine.items()):
            return "never"  # the two are in different branches of the same condition
        at_module_level = isinstance(self.scope_of(statement), ast.Module) and not isinstance(self.scope_of(anchor), ast.Module)
        if not at_module_level and _py_start(statement) > _py_start(anchor):
            return "conditional" if any(label == "loop" and key in theirs for key, label in mine.items()) else "never"
        return "definite" if all(key in theirs for key in mine) else "conditional"

    def constructor_of(self, name: str, site: ast.AST) -> Optional[ast.Call]:
        """The call whose result `name` is bound to, when it is bound exactly once
        in the function around `site` or, failing that, at module level."""
        scope = self.scope_of(site)
        for area in ([scope] if not isinstance(scope, ast.Module) else []) + [self.tree]:
            nodes = list(ast.walk(area)) if area is not self.tree else list(self.tree.body)
            assigned = [n for n in nodes if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)]
            bound = [item.context_expr for n in nodes if isinstance(n, (ast.With, ast.AsyncWith)) for item in n.items
                     if isinstance(item.optional_vars, ast.Name) and item.optional_vars.id == name]
            values = [n.value for n in assigned] + bound
            if values:
                return values[0] if len(values) == 1 and isinstance(values[0], ast.Call) else None
        return None

    def span(self, scope: ast.AST) -> Tuple[Tuple[int, int], Tuple[int, int]]:
        return ((0, 0), (10 ** 9, 0)) if isinstance(scope, ast.Module) else (_py_start(scope), _py_end(scope))

    def find_call(self, line: int) -> Optional[ast.Call]:
        """The HTTP call whose URL argument is on `line`, or which is given a
        variable that was assigned the URL on that line."""
        def url_arguments(call: ast.Call) -> List[ast.AST]:
            return list(call.args[:2]) + [kw.value for kw in call.keywords if kw.arg == "url"]

        best: Optional[ast.Call] = None
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Call) and _py_name(node.func) in _PY_HTTP and any(a.lineno <= line <= a.end_lineno for a in url_arguments(node)):
                if best is None or (node.end_lineno - node.lineno, node.end_col_offset - node.col_offset) < (best.end_lineno - best.lineno, best.end_col_offset - best.col_offset):
                    best = node
        if best is not None:
            return best
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Assign) and node.lineno <= line <= node.end_lineno and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                for call in ast.walk(self.scope_of(node)):
                    if isinstance(call, ast.Call) and _py_name(call.func) in _PY_HTTP and any(isinstance(a, ast.Name) and a.id == name for a in url_arguments(call)):
                        return call
        return None


class _PyTracer(_Tracer):
    def __init__(self, source: _PyFile, scope: ast.AST, seeds: Dict[Any, Value]):
        super().__init__(source.file, seeds)
        self.source, self.scope = source, scope
        self.nodes = list(ast.walk(scope))
        whole = source.span(scope)
        for node in self.nodes:
            if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                value = None if isinstance(node, ast.AugAssign) else node.value
                for target in targets:
                    if isinstance(target, ast.Name):
                        self.add_site(target.id, _py_end(node), whole, value, line=node.lineno)
                    elif isinstance(target, (ast.Tuple, ast.List)):
                        for element in ast.walk(target):
                            if isinstance(element, ast.Name):
                                self.add_site(element.id, _py_end(node), whole, None)
            elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
                self.add_site(node.target.id, _py_end(node), whole, node.value, line=node.lineno)
            elif isinstance(node, (ast.For, ast.AsyncFor)):
                self._bind_loop(node.target, node.iter, _py_end(node.iter), whole)
            elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
                for generator in node.generators:
                    self._bind_loop(generator.target, generator.iter, _py_start(node), (_py_start(node), _py_end(node)))
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if isinstance(item.optional_vars, ast.Name):
                        self.add_site(item.optional_vars.id, _py_end(item.context_expr), whole, item.context_expr, line=node.lineno)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                arguments = node.args
                for argument in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs, arguments.vararg, arguments.kwarg]:
                    if argument is not None:  # a parameter hides an outer name, unless a traced value is passed in
                        self.add_site(argument.arg, _py_start(node), (_py_start(node), _py_end(node)), argument if id(argument) in seeds else None)

    def _bind_loop(self, target: ast.AST, iterable: ast.AST, pos: Any, span: Tuple[Any, Any]) -> None:
        if isinstance(target, ast.Name):
            self.add_site(target.id, pos, span, iterable, ("[]",), line=iterable.lineno)
        else:
            for element in ast.walk(target):
                if isinstance(element, ast.Name):
                    self.add_site(element.id, pos, span, None)

    def key(self, node: Any) -> Any:
        return id(node)

    def _dynamic(self, node: ast.AST, value: Value, reason: str) -> None:
        self.dynamic[id(node)] = (normalize_field(value[1]), reason, node.lineno)

    def evaluate(self, node: Any) -> Optional[Value]:
        if isinstance(node, ast.Await):
            return self.value_of(node.value)
        if isinstance(node, ast.Name):
            return self.resolve(node.id, _py_start(node))
        if isinstance(node, ast.Subscript):
            base = self.value_of(node.value)
            if base is None or base[0] != "data":
                return None
            index = node.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, str):
                return _step(base, index.value)
            if isinstance(index, ast.Slice) or (isinstance(index, ast.Constant) and isinstance(index.value, int)) or isinstance(index, ast.UnaryOp):
                return _step(base, "[]")
            self._dynamic(node, base, "the key is computed at runtime")
            return None
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                base = self.value_of(func.value)
                if base == RESP:
                    return _data() if func.attr == "json" else None
                if base is not None:
                    literal = node.args[0].value if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) else None
                    if func.attr in ("get", "pop", "setdefault"):
                        if literal is not None:
                            return _step(base, literal)
                        self._dynamic(node, base, f"the key passed to .{func.attr}() is computed at runtime")
                    elif func.attr == "copy":
                        return base
                    elif func.attr in ("items", "values", "keys"):
                        self._dynamic(node, base, f"all keys are iterated with .{func.attr}()")
                    return None
                if func.attr == "loads" and node.args and isinstance(node.args[0], ast.Attribute) and node.args[0].attr in ("text", "content"):
                    return _data() if self.value_of(node.args[0].value) == RESP else None
            elif isinstance(func, ast.Name) and func.id in ("list", "tuple", "sorted", "reversed", "dict") and len(node.args) == 1:
                base = self.value_of(node.args[0])
                return base if base is not None and base[0] == "data" else None
            return None
        if isinstance(node, ast.BoolOp):
            return next((value for value in map(self.value_of, node.values) if value is not None), None)
        if isinstance(node, ast.IfExp):
            return self.value_of(node.body) or self.value_of(node.orelse)
        return None

    def run(self) -> Trace:
        for node in self.nodes:
            if isinstance(node, (ast.Subscript, ast.Call)):
                self.note_read(self.value_of(node), node.lineno)
            if isinstance(node, (ast.Return, ast.Yield, ast.YieldFrom)) and node.value is not None and self.source.scope_of(node) is self.scope:
                self._returned(node.value, node.lineno)
            elif isinstance(node, ast.Call):
                name = _py_name(node.func)
                if name in _PY_HARMLESS or self.value_of(node) is not None:
                    continue
                for index, argument in enumerate(node.args):
                    if isinstance(argument, ast.Starred):
                        self.note_open(self.value_of(argument.value), f"it is unpacked into {name or 'a function'}()", node.lineno)
                    elif self.value_of(argument) is not None:
                        self.passed.append((node, index, argument, self.value_of(argument), node.lineno))
                for keyword in node.keywords:
                    if self.value_of(keyword.value) is not None:
                        self.passed.append((node, keyword.arg, keyword.value, self.value_of(keyword.value), node.lineno))
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, (ast.Attribute, ast.Subscript)):
                        self.note_open(self.value_of(node.value), "it is stored outside this function", node.lineno)
            elif isinstance(node, (ast.Dict, ast.List, ast.Tuple, ast.Set)) and not isinstance(self.source.parent.get(id(node)), ast.Return):
                for element in (node.values if isinstance(node, ast.Dict) else node.elts):
                    if element is not None:
                        self.note_open(self.value_of(element), "it is placed inside another structure", node.lineno)
        if isinstance(self.scope, ast.Lambda):
            self._returned(self.scope.body, self.scope.lineno)
        return self.finish()

    def _returned(self, value: ast.AST, line: int) -> None:
        traced = self.value_of(value)
        if traced is not None:
            self.returned.append((traced, line))
        elif isinstance(value, (ast.Dict, ast.List, ast.Tuple)):
            for element in (value.values if isinstance(value, ast.Dict) else value.elts):
                if element is not None:
                    self.note_open(self.value_of(element), "it is returned inside another structure", line)


def _py_literal_keys(node: ast.AST, prefix: str, sent: Sent) -> None:
    if isinstance(node, ast.Dict):
        for key, value in zip(node.keys, node.values):
            if key is None:
                sent.unknown("another mapping is merged in with **")
            elif isinstance(key, ast.Constant) and isinstance(key.value, str):
                name = prefix + key.value
                sent.keys.add(name)
                if isinstance(value, (ast.Dict, ast.List)):
                    _py_literal_keys(value, name + ".", sent)
                elif not isinstance(value, (ast.Constant, ast.JoinedStr)):
                    sent.opaque.add(name)
            else:
                sent.unknown("a key is computed at runtime")
    elif isinstance(node, ast.List):
        for element in node.elts:
            _py_literal_keys(element, prefix, sent)


def _py_sent(repo: "Repository", source: _PyFile, scope: ast.AST, node: Optional[ast.AST], anchor: ast.AST, depth: int = 0) -> Sent:
    """Keys of a request payload expression, as far as they are known before
    `anchor` (the request). Keys added under a condition are kept apart."""
    sent = Sent()
    if node is None:
        return sent
    sent.present = True
    if isinstance(node, ast.Dict):
        _py_literal_keys(node, "", sent)
        return sent
    if isinstance(node, ast.Call):
        name = _py_name(node.func)
        if name == "dumps" and node.args:
            return _py_sent(repo, source, scope, node.args[0], anchor, depth)
        if name == "dict" and not node.args:
            for keyword in node.keywords:
                if keyword.arg is None:
                    sent.unknown("another mapping is merged in with **")
                else:
                    sent.keys.add(keyword.arg)
            return sent
        target, reason = repo.resolve_python(source, node) if depth < _MAX_DEPTH else (None, "it is nested too deeply to follow")
        if target is not None:
            other, definition = target
            returns = [n for n in ast.walk(definition) if isinstance(n, ast.Return) and n.value is not None and other.scope_of(n) is definition]
            if len(returns) == 1:
                return _py_sent(repo, other, definition, returns[0].value, returns[0], depth + 1)
            reason = f"{name}() does not return in exactly one place"
        return sent.unknown(f"the payload is built by a call that could not be read: {reason}")
    if isinstance(node, ast.Name):
        assigned = [n for n in ast.walk(scope) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == node.id for t in n.targets)]
        if len(assigned) != 1:
            return sent.unknown(f"the payload variable '{node.id}' is not built in one place in this function")
        if source.presence(assigned[0], anchor) != "definite":
            return sent.unknown(f"the payload variable '{node.id}' is assigned under a condition")
        sent = _py_sent(repo, source, scope, assigned[0].value, anchor, depth)
        for other in ast.walk(scope):
            if isinstance(other, ast.Assign):
                for target in other.targets:
                    if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and target.value.id == node.id:
                        state = source.presence(other, anchor)
                        if isinstance(target.slice, ast.Constant) and isinstance(target.slice.value, str):
                            sent.add(target.slice.value, state, other.lineno)
                        elif state != "never":
                            sent.limit("a key is added with a name computed at runtime")
            elif isinstance(other, ast.Call) and isinstance(other.func, ast.Attribute) and other.func.attr == "update" and isinstance(other.func.value, ast.Name) and other.func.value.id == node.id:
                state = source.presence(other, anchor)
                if other.args and isinstance(other.args[0], ast.Dict):
                    added = Sent()
                    _py_literal_keys(other.args[0], "", added)
                    sent.absorb(added, state, other.lineno)
                elif state != "never":
                    sent.limit("keys are added with .update() from another mapping")
        return sent
    return sent.unknown("the payload is not a literal mapping")


_PY_LIBRARIES = {"requests", "httpx"}
_PY_CLIENT_FACTORIES = {"Session", "session", "Client", "AsyncClient"}
_PY_CLIENT_HOOKS = {"hooks", "auth", "event_hooks", "transport", "mounts", "mount"}


def _py_from_library(source: _PyFile, func: ast.AST) -> bool:
    """`requests.get`, `httpx.Client`, or a name imported from one of those libraries."""
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        name = func.value.id
        if name in source.modules:
            return source.modules[name].split(".")[0] in _PY_LIBRARIES
        # The library name itself, not rebound to anything in this file.
        return name in _PY_LIBRARIES and name not in source.imported and source.constructor_of(name, func) is None
    if isinstance(func, ast.Name) and func.id in source.imported:
        module, _, level = source.imported[func.id]
        return level == 0 and module.split(".")[0] in _PY_LIBRARIES
    return False


def _py_method(call: ast.Call) -> Tuple[str, str]:
    """(method, why it is unknown). Only what the call itself states."""
    name = _py_name(call.func)
    if name in _VERBS:
        return name.upper(), ""
    if name == "request":
        stated = call.args[0] if call.args else next((kw.value for kw in call.keywords if kw.arg == "method"), None)
        if isinstance(stated, ast.Constant) and isinstance(stated.value, str):
            return stated.value.upper(), ""
        return "", "the method passed to request() is not a literal"
    return "", f"{name or 'the call'}() does not state an HTTP method"


def _py_client(repo: "Repository", source: _PyFile, call: ast.Call) -> Tuple[str, Sent, Sent]:
    """What is known about the client a request goes through: ("" when its
    configuration is fully visible, else why not), default query, default headers.

    A request made with `requests.get(...)` has no shared defaults. A session
    created in this file is read: its literal `params` / `headers`. Any other
    object may add parameters, headers or body fields that are not visible."""
    query, headers = Sent(), Sent()
    func = call.func
    if _py_from_library(source, func):
        return "", query, headers
    if not (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)):
        described = ast.unparse(func.value)[:50] if isinstance(func, ast.Attribute) else _py_name(func)
        return f"the request is sent through '{described}', a client whose defaults are not visible here", query, headers
    name = func.value.id
    created = source.constructor_of(name, call)
    if created is None or _py_name(created.func) not in _PY_CLIENT_FACTORIES or not _py_from_library(source, created.func):
        return f"the request is sent through '{name}', a client whose defaults are not visible here", query, headers

    where = lambda node: f"a default set on '{name}' at {source.file}:{node.lineno}"
    reason = ""
    for keyword in created.keywords:
        target = {"params": query, "headers": headers}.get(keyword.arg or "")
        if target is not None:
            target.absorb(_py_sent(repo, source, source.scope_of(created), keyword.value, call), "definite", created.lineno, where(created))
        elif keyword.arg is None or keyword.arg in _PY_CLIENT_HOOKS:
            reason = f"the client '{name}' is created with {keyword.arg or '**options'}, which can change every request"
    scope = source.scope_of(call)
    for node in ast.walk(source.tree):
        if source.scope_of(node) is not scope and not isinstance(source.scope_of(node), ast.Module):
            continue  # another function's local variable of the same name
        attribute = lambda item: item.attr if isinstance(item, ast.Attribute) and isinstance(item.value, ast.Name) and item.value.id == name else ""
        if isinstance(node, ast.Assign):
            for target in node.targets:
                state = source.presence(node, call)
                kind = attribute(target) or (attribute(target.value) if isinstance(target, ast.Subscript) else "")
                bucket = {"params": query, "headers": headers}.get(kind)
                if state == "never":
                    continue
                if kind in _PY_CLIENT_HOOKS:
                    reason = f"'{name}.{kind}' is set at {source.file}:{node.lineno} and can change every request"
                elif bucket is None:
                    continue
                elif isinstance(target, ast.Subscript):
                    if isinstance(target.slice, ast.Constant) and isinstance(target.slice.value, str):
                        bucket.add(target.slice.value, state, node.lineno, where(node))
                    else:
                        bucket.limit(f"a default of '{name}' is set at {source.file}:{node.lineno} under a name computed at runtime")
                else:
                    value = _py_sent(repo, source, source.scope_of(node), node.value, node)
                    if not value.complete:
                        bucket.limit(f"the default {kind} of '{name}' are set at {source.file}:{node.lineno} from a value that is not a literal")
                    bucket.absorb(value, state, node.lineno, where(node))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            state = source.presence(node, call)
            if state == "never":
                continue
            if attribute(node.func) in _PY_CLIENT_HOOKS:
                reason = f"'{name}.{node.func.attr}()' is called at {source.file}:{node.lineno} and can change every request"
            bucket = {"params": query, "headers": headers}.get(attribute(node.func.value)) if node.func.attr == "update" else None
            if bucket is not None:
                if node.args and isinstance(node.args[0], ast.Dict):
                    added = Sent()
                    _py_literal_keys(node.args[0], "", added)
                    bucket.absorb(added, state, node.lineno, where(node))
                else:
                    bucket.limit(f"the defaults of '{name}' are updated at {source.file}:{node.lineno} from a value that is not a literal")
    return reason, query, headers


def _py_request(repo: "Repository", source: _PyFile, call: ast.Call, facts: CallFacts) -> None:
    name = _py_name(call.func)
    scope = source.scope_of(call)
    keywords = {kw.arg: kw.value for kw in call.keywords}
    offset = 1 if name == "request" else 0  # request(method, url, ...)
    arguments = call.args[offset:]
    url = keywords.get("url") or (arguments[0] if arguments else None)
    body = keywords.get("json") or keywords.get("data")
    if body is None and name in _BODY_VERBS and len(arguments) > 1:
        body = arguments[1]
    params = keywords.get("params") or (arguments[1] if name == "get" and len(arguments) > 1 else None)
    facts.method, facts.method_reason = _py_method(call)
    facts.body = _py_sent(repo, source, scope, body, call)
    facts.query = _py_sent(repo, source, scope, params, call)
    facts.headers = _py_sent(repo, source, scope, keywords.get("headers"), call)
    if url is not None:
        _query_from_url(ast.get_source_segment(source.text, url) or "", facts.query)
        if isinstance(url, ast.Call) and _py_name(url.func) not in ("format", "urljoin", "str", "join"):
            facts.query.limit(f"the URL is passed through {_py_name(url.func) or 'a call'}(), which may add query parameters")
    if body is None and any(key in keywords for key in ("files", "content", "body")):
        facts.body.unknown("the request body is sent as files or raw content")
    if None in keywords:  # **kwargs
        for sent in (facts.body, facts.query, facts.headers):
            sent.unknown("further arguments are passed with **")
    # What the client adds to every request. Without that, "not in this call" is not "not sent".
    unknown, default_query, default_headers = _py_client(repo, source, call)
    facts.query.absorb(default_query)
    facts.headers.absorb(default_headers)
    if unknown:
        for sent in (facts.body, facts.query, facts.headers):
            sent.limit(unknown)


# ---- JavaScript / TypeScript --------------------------------------------------------------

_JS_FUNCTIONS = {"function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "generator_function"}
_JS_BLOCKS = _JS_FUNCTIONS | {"statement_block", "program", "class_body", "switch_body", "for_in_statement", "for_statement"}
_JS_UNWRAP = {"await_expression", "parenthesized_expression", "as_expression", "non_null_expression", "satisfies_expression", "type_assertion"}
_JS_HTTP = _VERBS | {"fetch", "request", "ajax", "axios", "got", "ky", "$fetch", "ofetch"}
_JS_PROMISE = {"then"}
_JS_PASS_THROUGH = {"catch", "finally", "filter", "slice", "concat", "reverse", "sort", "flat"}
_JS_EACH = {"map", "forEach", "filter", "find", "some", "every", "flatMap", "findLast"}
_JS_ELEMENT = {"find", "findLast", "at", "pop", "shift"}
_JS_NOT_FIELDS = {"length", "then", "catch", "finally"} | _JS_PASS_THROUGH | _JS_EACH | _JS_ELEMENT
_JS_HARMLESS = {"await", "log", "info", "warn", "error", "debug", "stringify", "String", "Number", "Boolean", "parseInt", "parseFloat", "isArray", "expect"}
_JS_URL_ARGUMENTS = {"string", "template_string", "binary_expression", "object", "call_expression"}
_JS_PARSERS: Dict[str, Any] = {}


def _js_parser(file: str) -> Any:
    kind = "tsx" if file.endswith(".tsx") else "ts" if file.endswith(".ts") else "js"
    if kind not in _JS_PARSERS:
        language = {"js": tree_sitter_javascript.language, "ts": tree_sitter_typescript.language_typescript, "tsx": tree_sitter_typescript.language_tsx}[kind]()
        _JS_PARSERS[kind] = Parser(Language(language))
    return _JS_PARSERS[kind]


def _text(node: Any) -> str:
    return node.text.decode("utf-8", errors="replace") if node is not None else ""


def _js_walk(node: Any) -> Iterable[Any]:
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.children))


def _js_arguments(call: Any) -> List[Any]:
    arguments = call.child_by_field_name("arguments")
    return [child for child in arguments.named_children if child.type != "comment"] if arguments is not None and arguments.type == "arguments" else []


def _js_callee(call: Any) -> Tuple[str, Any]:
    """(terminal name, object node) of a call: axios.get -> ("get", axios)."""
    function = call.child_by_field_name("function")
    if function is None:
        return "", None
    if function.type == "member_expression":
        return _text(function.child_by_field_name("property")), function.child_by_field_name("object")
    return (_text(function) if function.type == "identifier" else ""), None


def _js_unwrap(node: Any) -> Any:
    while node is not None:
        if node.type in _JS_UNWRAP and node.named_children:
            node = node.named_children[0]
        elif node.type == "call_expression" and _text(node.child_by_field_name("function")) == "await" and _js_arguments(node):
            node = _js_arguments(node)[0]  # `await (x)` parsed as a call
        else:
            break
    return node


def _js_static_string(node: Any) -> Optional[str]:
    if node is None:
        return None
    if node.type == "string":
        return "".join(_text(child) for child in node.named_children if child.type in ("string_fragment", "escape_sequence"))
    if node.type == "template_string" and not any(child.type == "template_substitution" for child in node.named_children):
        return _text(node)[1:-1]
    return None


def _js_key(node: Any) -> Optional[str]:
    if node is None:
        return None
    if node.type in ("property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "identifier", "number"):
        return _text(node)
    return _js_static_string(node)


class _JsFile:
    def __init__(self, file: str, text: str):
        self.file, self.text = file, text
        self.tree = _js_parser(file).parse(text.encode("utf-8"))
        self.root = self.tree.root_node
        #: React: `const [state, setState] = useState()` as {setter: [(state name, component, declaration)]}.
        self.state_setters: Dict[str, List[Tuple[str, Any, Any]]] = {}
        #: Symbols a call can be resolved against. Only what the file itself states is recorded.
        self.functions: Dict[str, List[Any]] = {}                  # named functions that are not methods
        self.classes: Dict[str, Dict[str, List[Any]]] = {}         # class -> method -> definitions
        self.imports: Dict[str, Tuple[str, str]] = {}              # local name -> (module, "default" | "*" | exported name)
        self.declarators: Dict[str, List[Any]] = {}                # variable name -> declarations
        self.default_export: Any = None
        for node in _js_walk(self.root):
            kind = node.type
            if kind == "variable_declarator":
                names, value = node.child_by_field_name("name"), _js_unwrap(node.child_by_field_name("value"))
                if names is None:
                    continue
                if names.type == "identifier":
                    self.declarators.setdefault(_text(names), []).append(node)
                required = _js_static_string(_js_arguments(value)[0]) if value is not None and value.type == "call_expression" and _text(value.child_by_field_name("function")) == "require" and _js_arguments(value) else None
                if required is not None and names.type == "identifier":
                    self.imports[_text(names)] = (required, "*")
                elif required is not None and names.type == "object_pattern":
                    for child in names.named_children:
                        if child.type == "shorthand_property_identifier_pattern":
                            self.imports[_text(child)] = (required, _text(child))
                        elif child.type == "pair_pattern" and child.child_by_field_name("value") is not None:
                            self.imports[_text(child.child_by_field_name("value"))] = (required, _js_key(child.child_by_field_name("key")) or "")
                elif names.type == "array_pattern" and value is not None and value.type == "call_expression" and _js_callee(value)[0] == "useState":
                    pair = [child for child in names.named_children if child.type == "identifier"]
                    if len(pair) == 2:
                        self.state_setters.setdefault(_text(pair[1]), []).append((_text(pair[0]), self.scope_of(node), node))
            elif kind == "import_statement":
                module = _js_static_string(node.child_by_field_name("source")) or ""
                for clause in node.named_children:
                    for item in clause.named_children if clause.type == "import_clause" else []:
                        if item.type == "identifier":
                            self.imports[_text(item)] = (module, "default")
                        elif item.type == "namespace_import":
                            self.imports[_text(item.named_children[-1])] = (module, "*")
                        elif item.type == "named_imports":
                            for specifier in item.named_children:
                                names = [child for child in specifier.named_children if child.type == "identifier"]
                                if names:
                                    self.imports[_text(names[-1])] = (module, _text(names[0]))
            elif kind == "method_definition":
                owner = self.class_of(node)
                if owner:
                    self.classes.setdefault(owner, {}).setdefault(_text(node.child_by_field_name("name")), []).append(node)
            elif kind in _JS_FUNCTIONS:
                parent = node.parent
                if kind in ("function_declaration", "generator_function_declaration") or (parent is not None and parent.type == "variable_declarator"):
                    name = self.function_name(node)
                elif parent is not None and parent.type == "assignment_expression" and _text(parent.child_by_field_name("left")).startswith(("exports.", "module.exports.")):
                    name = self.function_name(node)  # exports.save = function () {}
                else:
                    name = ""  # object-literal methods and callbacks are not free functions
                if name:
                    self.functions.setdefault(name, []).append(node)
            elif kind in ("class_declaration", "class"):
                self.classes.setdefault(self._class_name(node), {})
            elif kind == "export_statement" and any(child.type == "default" for child in node.children):
                self.default_export = node.child_by_field_name("declaration") or node.child_by_field_name("value")

    @staticmethod
    def _class_name(node: Any) -> str:
        name = node.child_by_field_name("name")
        if name is not None:
            return _text(name)
        parent = node.parent
        return _text(parent.child_by_field_name("name")) if parent is not None and parent.type == "variable_declarator" else ""

    def class_of(self, node: Any) -> str:
        current = node.parent
        while current is not None and current.type not in ("class_declaration", "class"):
            current = current.parent
        return self._class_name(current) if current is not None else ""

    def visible(self, definition: Any, site: Any) -> bool:
        """Is a function defined at `definition` in scope at `site`?"""
        scope = self.scope_of(definition)
        return scope.id == self.root.id or (scope.start_byte <= site.start_byte and site.end_byte <= scope.end_byte)

    def exported(self, name: str) -> Any:
        """The top-level function this module exports under `name` ("default" for the default export)."""
        if name == "default":
            target = _js_unwrap(self.default_export)
            if target is None:
                return None
            if target.type in _JS_FUNCTIONS:
                return target
            name = _text(target) if target.type == "identifier" else ""
        found = [node for node in self.functions.get(name, []) if self.scope_of(node).id == self.root.id]
        return found[0] if len(found) == 1 else None

    def exported_class(self, name: str) -> str:
        if name == "default":
            target = _js_unwrap(self.default_export)
            name = self._class_name(target) if target is not None and target.type in ("class_declaration", "class") else _text(target) if target is not None else ""
        return name if name in self.classes else ""

    def guards(self, node: Any) -> Dict[int, str]:
        """Conditions under which `node` runs, as {id of the branching node: branch}."""
        found: Dict[int, str] = {}
        child, parent = node, node.parent
        while parent is not None:
            kind = parent.type
            is_field = lambda name: parent.child_by_field_name(name) is not None and parent.child_by_field_name(name).id == child.id
            if kind in ("if_statement", "ternary_expression"):
                if is_field("consequence") or is_field("alternative"):
                    found[parent.id] = "then" if is_field("consequence") else "else"
            elif kind in ("for_statement", "for_in_statement", "while_statement", "do_statement"):
                if is_field("body"):
                    found[parent.id] = "loop"
            elif kind == "try_statement":
                if is_field("body"):
                    found[parent.id] = "try"
            elif kind == "catch_clause":
                found[parent.id] = "catch"
            elif kind in ("switch_case", "switch_default"):
                found[parent.parent.id if parent.parent is not None else parent.id] = str(parent.id)
            elif kind == "binary_expression" and _text(parent.child_by_field_name("operator")) in ("&&", "||", "??"):
                if is_field("right"):
                    found[parent.id] = "right"
            elif kind in _JS_FUNCTIONS:
                found[parent.id] = "function"
            child, parent = parent, parent.parent
        return found

    def presence(self, statement: Any, anchor: Any) -> str:
        """Does `statement` run before `anchor` (the request)? "definite", "conditional" or "never"."""
        mine, theirs = self.guards(statement), self.guards(anchor)
        if any(key in theirs and theirs[key] != label for key, label in mine.items()):
            return "never"  # different branches of the same condition
        at_module_level = self.scope_of(statement).id == self.root.id and self.scope_of(anchor).id != self.root.id
        if not at_module_level and statement.start_byte > anchor.start_byte:
            return "conditional" if any(label == "loop" and key in theirs for key, label in mine.items()) else "never"
        return "definite" if all(key in theirs for key in mine) else "conditional"

    def scope_of(self, node: Any) -> Any:
        current = node.parent
        while current is not None and current.type not in _JS_FUNCTIONS:
            current = current.parent
        return current or self.root

    @staticmethod
    def function_name(scope: Any) -> str:
        if scope.type in ("function_declaration", "method_definition", "generator_function_declaration"):
            return _text(scope.child_by_field_name("name"))
        parent = scope.parent
        if parent is not None and parent.type == "variable_declarator":
            name = parent.child_by_field_name("name")
            return _text(name) if name is not None and name.type == "identifier" else ""
        if parent is not None and parent.type == "pair":
            return _js_key(parent.child_by_field_name("key")) or ""
        if parent is not None and parent.type == "assignment_expression":
            left = parent.child_by_field_name("left")
            return _text(left.child_by_field_name("property")) if left is not None and left.type == "member_expression" else _text(left)
        return ""

    def find_call(self, line: int) -> Any:
        row = line - 1
        best = None
        for node in _js_walk(self.root):
            if node.type != "call_expression":
                continue
            arguments = _js_arguments(node)
            # The first argument must look like a URL, so `setTotal(order.total)` on the same line is not mistaken for the request.
            if arguments and arguments[0].start_point[0] <= row <= arguments[0].end_point[0] and arguments[0].type in _JS_URL_ARGUMENTS and "/" in _text(arguments[0]):
                if best is None or node.end_byte - node.start_byte < best.end_byte - best.start_byte:
                    best = node
        if best is not None:
            outer = best.parent.parent if best.parent is not None and best.parent.type == "arguments" else None
            if _js_callee(best)[0] not in _JS_HTTP and outer is not None and outer.type == "call_expression" and _js_callee(outer)[0] in _JS_HTTP:
                return outer  # axios.get(withQuery(`...`))
            return best
        for node in _js_walk(self.root):
            if node.type == "variable_declarator" and node.start_point[0] <= row <= node.end_point[0]:
                name = node.child_by_field_name("name")
                if name is None or name.type != "identifier":
                    continue
                for call in _js_walk(self.scope_of(node)):
                    arguments = _js_arguments(call) if call.type == "call_expression" else []
                    if arguments and arguments[0].type == "identifier" and _text(arguments[0]) == _text(name):
                        return call
        return None


class _JsTracer(_Tracer):
    def __init__(self, source: _JsFile, scope: Any, seeds: Dict[Any, Value]):
        super().__init__(source.file, seeds)
        self.source, self.scope = source, scope
        self.nodes = list(_js_walk(scope))
        self.pattern_opens: List[Tuple[Any, Tuple[str, ...], str, int]] = []
        whole = (scope.start_byte, scope.end_byte)
        for node in self.nodes:
            kind = node.type
            if kind == "variable_declarator":
                self._bind(node.child_by_field_name("name"), node.child_by_field_name("value"), (), node.end_byte, self._block(node))
            elif kind == "assignment_expression":
                left = node.child_by_field_name("left")
                if left is not None and left.type in ("identifier", "object_pattern", "array_pattern"):
                    self._bind(left, node.child_by_field_name("right"), (), node.end_byte, whole)
            elif kind == "for_in_statement":
                right = node.child_by_field_name("right")
                operator = node.child_by_field_name("operator")
                if right is not None:
                    steps = ("[]",) if _text(operator) == "of" else ("?",)
                    self._bind(node.child_by_field_name("left"), right if _text(operator) == "of" else None, steps, right.end_byte, (node.start_byte, node.end_byte))
            elif kind in _JS_FUNCTIONS:
                callback_of = self._callback_source(node)
                source_node, steps = callback_of if callback_of else (None, ())
                for index, parameter in enumerate(self._parameters(node)):  # only the first parameter receives the value
                    bound = parameter if parameter.id in seeds else source_node if index == 0 else None
                    self._bind(parameter, bound, () if parameter.id in seeds else steps, node.start_byte, (node.start_byte, node.end_byte))

    @staticmethod
    def _parameters(function: Any) -> List[Any]:
        single = function.child_by_field_name("parameter")
        if single is not None:
            return [single]
        parameters = function.child_by_field_name("parameters")
        return list(parameters.named_children) if parameters is not None else []

    def _callback_source(self, function: Any) -> Optional[Tuple[Any, Tuple[str, ...]]]:
        """For `x.then(cb)` and `xs.map(cb)`: what the first parameter of cb is bound to."""
        arguments = function.parent
        call = arguments.parent if arguments is not None and arguments.type == "arguments" else None
        if call is None or call.type != "call_expression" or not _js_arguments(call) or _js_arguments(call)[0].id != function.id:
            return None
        name, target = _js_callee(call)
        if target is None:
            return None
        if name in _JS_PROMISE:
            return target, ()
        if name in _JS_EACH:
            return target, ("[]",)
        return None

    def _block(self, node: Any) -> Tuple[int, int]:
        current = node.parent
        while current is not None and current.type not in _JS_BLOCKS:
            current = current.parent
        current = current or self.scope
        return (current.start_byte, current.end_byte)

    def _bind(self, pattern: Any, source: Any, steps: Tuple[str, ...], pos: int, span: Tuple[int, int]) -> None:
        if pattern is None:
            return
        kind = pattern.type
        line = pattern.start_point[0] + 1
        if kind in ("identifier", "shorthand_property_identifier_pattern"):
            self.add_site(_text(pattern), pos, span, source, steps, line)
        elif kind == "object_pattern":
            for child in pattern.named_children:
                if child.type == "shorthand_property_identifier_pattern":
                    self._bind(child, source, steps + (_text(child),), pos, span)
                elif child.type == "pair_pattern":
                    key = _js_key(child.child_by_field_name("key"))
                    if key is None:
                        self.pattern_opens.append((source, steps, "a property name in a destructuring pattern is computed at runtime", line))
                    else:
                        self._bind(child.child_by_field_name("value"), source, steps + (key,), pos, span)
                elif child.type == "object_assignment_pattern":
                    left = child.child_by_field_name("left")
                    self._bind(left, source, steps + (_text(left),), pos, span)
                elif child.type == "rest_pattern":
                    self.pattern_opens.append((source, steps, "the remaining properties are collected with ...rest", line))
        elif kind == "array_pattern":
            for child in pattern.named_children:
                self._bind(child, source, steps + ("[]",), pos, span)
        elif kind == "assignment_pattern":
            self._bind(pattern.child_by_field_name("left"), source, steps, pos, span)
        elif kind in ("required_parameter", "optional_parameter"):
            self._bind(pattern.child_by_field_name("pattern"), source, steps, pos, span)

    def key(self, node: Any) -> Any:
        return node.id

    def _dynamic(self, node: Any, value: Value, reason: str) -> None:
        self.dynamic[node.id] = (normalize_field(value[1]), reason, node.start_point[0] + 1)

    def evaluate(self, node: Any) -> Optional[Value]:
        kind = node.type
        if kind in _JS_UNWRAP:
            return self.value_of(node.named_children[0]) if node.named_children else None
        if kind == "identifier":
            return self.resolve(_text(node), node.start_byte)
        if kind == "member_expression":
            base = self.value_of(node.child_by_field_name("object"))
            name = _text(node.child_by_field_name("property"))
            if base is None or (base[0] == "data" and name in _JS_NOT_FIELDS):
                return None
            return _step(base, name)
        if kind == "subscript_expression":
            base = self.value_of(node.child_by_field_name("object"))
            if base is None:
                return None
            index = node.child_by_field_name("index")
            literal = _js_static_string(index)
            if literal is not None:
                return _step(base, literal)
            if index is not None and index.type == "number":
                return _step(base, "[]") if base[0] == "data" else None
            if base[0] == "data":
                self._dynamic(node, base, "the property name is computed at runtime")
            return None
        if kind == "call_expression":
            name, target = _js_callee(node)
            arguments = _js_arguments(node)
            if target is None:
                return self.value_of(arguments[0]) if name == "await" and arguments else None
            if name == "parse" and _text(target) == "JSON" and arguments:  # JSON.parse(await res.text())
                inner = _js_unwrap(arguments[0])
                if inner is not None and inner.type == "call_expression" and _js_callee(inner)[0] == "text":
                    return _data() if self.value_of(_js_callee(inner)[1]) == RESP else None
                return None
            base = self.value_of(target)
            if base is None:
                return None
            if base == RESP:
                return _data() if name == "json" else RESP if name in ("catch", "finally", "clone") else self._then(arguments) if name in _JS_PROMISE else None
            if name in _JS_PROMISE:
                return self._then(arguments)
            if name in _JS_PASS_THROUGH:
                return base
            if name in _JS_ELEMENT:
                return _step(base, "[]")
            return None
        if kind == "binary_expression" and _text(node.child_by_field_name("operator")) in ("||", "??"):
            return self.value_of(node.child_by_field_name("left")) or self.value_of(node.child_by_field_name("right"))
        if kind == "ternary_expression":
            return self.value_of(node.child_by_field_name("consequence")) or self.value_of(node.child_by_field_name("alternative"))
        return None

    def _then(self, arguments: List[Any]) -> Optional[Value]:
        """Value a `.then(callback)` resolves to: what the callback returns."""
        callback = arguments[0] if arguments else None
        if callback is None or callback.type not in _JS_FUNCTIONS:
            return None
        body = callback.child_by_field_name("body")
        if body is None:
            return None
        if body.type != "statement_block":
            return self.value_of(body)
        values = {self.value_of(node.named_children[0]) for node in _js_walk(body) if node.type == "return_statement" and node.named_children and self.source.scope_of(node).id == callback.id}
        return values.pop() if len(values) == 1 else None

    def run(self) -> Trace:
        for node in self.nodes:
            kind = node.type
            line = node.start_point[0] + 1
            if kind in ("member_expression", "subscript_expression", "call_expression"):
                self.note_read(self.value_of(node), line)
            if kind == "return_statement" and node.named_children and self.source.scope_of(node).id == self.scope.id:
                self._returned(node.named_children[0], line)
            elif kind == "call_expression":
                name, _ = _js_callee(node)
                if name in _JS_HARMLESS or name in _JS_PROMISE or name in _JS_EACH or self.value_of(node) is not None:
                    continue
                for index, argument in enumerate(_js_arguments(node)):
                    if argument.type == "spread_element":
                        self.note_open(self.value_of(argument.named_children[0]) if argument.named_children else None, f"it is spread into {name or 'a function'}()", line)
                    elif self.value_of(argument) is not None:
                        self.passed.append((node, index, argument, self.value_of(argument), line))
            elif kind == "assignment_expression":
                left = node.child_by_field_name("left")
                if left is not None and left.type in ("member_expression", "subscript_expression"):
                    self.note_open(self.value_of(node.child_by_field_name("right")), "it is stored outside this function", line)
            elif kind in ("array", "object") and (node.parent is None or node.parent.type != "return_statement"):
                for child in node.named_children:
                    inner = child.child_by_field_name("value") if child.type == "pair" else child.named_children[0] if child.type == "spread_element" and child.named_children else child
                    if inner is not None and inner.type not in ("comment", "method_definition"):
                        self.note_open(self.value_of(inner), "it is placed inside another object", line)
            elif kind == "jsx_expression" and node.parent is not None and node.parent.type == "jsx_attribute" and node.named_children:
                self.note_open(self.value_of(node.named_children[0]), "it is passed to a component", line)
        if self.scope.type == "arrow_function":
            body = self.scope.child_by_field_name("body")
            if body is not None and body.type != "statement_block":
                self._returned(body, body.start_point[0] + 1)
        for source_node, steps, reason, line in self.pattern_opens:
            value = self.value_of(source_node) if source_node is not None else None
            for key in steps:
                value = _step(value, key)
            self.note_open(value, reason, line)
        return self.finish()

    def _returned(self, value: Any, line: int) -> None:
        traced = self.value_of(value)
        if traced is not None:
            self.returned.append((traced, line))
            return
        inner = _js_unwrap(value)
        if inner is not None and inner.type in ("object", "array"):
            for child in inner.named_children:
                element = child.child_by_field_name("value") if child.type == "pair" else child.named_children[0] if child.type == "spread_element" and child.named_children else child
                if element is not None:
                    self.note_open(self.value_of(element), "it is returned inside another object", line)


def _js_object_keys(node: Any, prefix: str, sent: Sent) -> None:
    for child in node.named_children:
        kind = child.type
        if kind == "pair":
            key = _js_key(child.child_by_field_name("key"))
            value = _js_unwrap(child.child_by_field_name("value"))
            if key is None:
                sent.unknown("a property name is computed at runtime")
                continue
            sent.keys.add(prefix + key)
            if value is not None and value.type == "object":
                _js_object_keys(value, prefix + key + ".", sent)
            elif value is not None and value.type == "array":
                for element in value.named_children:
                    if element.type == "object":
                        _js_object_keys(element, prefix + key + ".", sent)
            elif value is not None and value.type in ("identifier", "call_expression", "member_expression", "await_expression"):
                sent.opaque.add(prefix + key)
        elif kind == "shorthand_property_identifier":
            sent.keys.add(prefix + _text(child))
            sent.opaque.add(prefix + _text(child))
        elif kind == "spread_element":
            sent.unknown("another object is merged in with ...spread")
        elif kind == "method_definition":
            sent.keys.add(prefix + _text(child.child_by_field_name("name")))


def _js_sent(repo: "Repository", source: _JsFile, scope: Any, node: Any, anchor: Any, depth: int = 0) -> Sent:
    """Keys of a request payload expression, as far as they are known before
    `anchor` (the request). Keys added under a condition are kept apart."""
    sent = Sent()
    node = _js_unwrap(node)
    if node is None:
        return sent
    sent.present = True
    if node.type == "object":
        _js_object_keys(node, "", sent)
        return sent
    if node.type == "call_expression":
        name, _ = _js_callee(node)
        arguments = _js_arguments(node)
        if name == "stringify" and arguments:
            return _js_sent(repo, source, scope, arguments[0], anchor, depth)
        target, reason = repo.resolve_js(source, node) if depth < _MAX_DEPTH else (None, "it is nested too deeply to follow")
        if target is not None:
            other, function = target
            body = function.child_by_field_name("body")
            if body is not None and body.type != "statement_block":
                return _js_sent(repo, other, function, body, body, depth + 1)
            returns = [n for n in _js_walk(body) if n.type == "return_statement" and n.named_children and other.scope_of(n).id == function.id] if body is not None else []
            if len(returns) == 1:
                return _js_sent(repo, other, function, returns[0].named_children[0], returns[0], depth + 1)
            reason = f"{name}() does not return in exactly one place"
        return sent.unknown(f"the payload is built by a call that could not be read: {reason}")
    if node.type == "identifier":
        name = _text(node)
        declared = [n for n in _js_walk(scope) if n.type == "variable_declarator" and _text(n.child_by_field_name("name")) == name and n.child_by_field_name("name").type == "identifier"]
        if len(declared) != 1 or declared[0].child_by_field_name("value") is None:
            return sent.unknown(f"the payload variable '{name}' is not built in one place in this function")
        if source.presence(declared[0], anchor) != "definite":
            return sent.unknown(f"the payload variable '{name}' is declared under a condition")
        sent = _js_sent(repo, source, scope, declared[0].child_by_field_name("value"), anchor, depth)
        for other in _js_walk(scope):
            if other.type == "assignment_expression":
                left = other.child_by_field_name("left")
                if left is not None and left.type in ("member_expression", "subscript_expression") and _text(left.child_by_field_name("object")) == name:
                    key = _js_key(left.child_by_field_name("property")) if left.type == "member_expression" else _js_static_string(left.child_by_field_name("index"))
                    state = source.presence(other, anchor)
                    if key is not None:
                        sent.add(key, state, other.start_point[0] + 1)
                    elif state != "never":
                        sent.limit("a property is added with a name computed at runtime")
            elif other.type == "call_expression" and _js_callee(other)[0] == "assign" and _js_arguments(other) and _text(_js_arguments(other)[0]) == name:
                if source.presence(other, anchor) != "never":
                    sent.limit("properties are added with Object.assign()")
        return sent
    return sent.unknown("the payload is not an object literal")


def _js_property(node: Any, name: str) -> Any:
    """Value node of property `name` in an object literal, or None."""
    for child in node.named_children if node is not None and node.type == "object" else []:
        if child.type == "pair" and _js_key(child.child_by_field_name("key")) == name:
            return child.child_by_field_name("value")
        if child.type == "shorthand_property_identifier" and _text(child) == name:
            return child
    return None


_JS_DEFAULT_GET = {"fetch", "axios", "$fetch", "ofetch", "got", "ky"}
_JS_REQUEST_CHANGERS = ("transformRequest", "adapter", "paramsSerializer")
_JS_INTERCEPTOR = re.compile(r"^(?P<owner>.+)\.interceptors\.request\.use$", re.S)
_JS_DEFAULTS = re.compile(r"^(?P<owner>[\w$.]+?)\.defaults\.(?P<kind>params|headers|data|transformRequest|adapter)(?P<rest>.*)$", re.S)
_JS_BUCKETS = {"params": "query", "headers": "headers", "data": "body"}


def _js_method(call: Any) -> Tuple[str, str]:
    """(method, why it is unknown). Only what the call itself states."""
    name, target = _js_callee(call)
    if target is not None and name in _VERBS:
        return name.upper(), ""
    arguments = [_js_unwrap(argument) for argument in _js_arguments(call)]
    options = arguments[0] if arguments and arguments[0] is not None and arguments[0].type == "object" else arguments[1] if len(arguments) > 1 else None
    if target is None and name in _JS_DEFAULT_GET:
        if options is None:
            return "GET", ""
        if options.type != "object":
            return "", f"the request options come from '{_text(options)[:40]}', which is not an object literal here"
        if any(child.type == "spread_element" for child in options.named_children):
            return "", "the request options merge in another object, which may set the method"
        stated = _js_unwrap(_js_property(options, "method"))
        if stated is None:
            return "GET", ""
        literal = _js_static_string(stated)
        return (literal.upper(), "") if literal else ("", "the method in the request options is not a literal")
    return "", f"{name or 'the call'}() does not state an HTTP method"


def _js_is_library(source: _JsFile, name: str, library: str) -> bool:
    """Is `name` the library itself: imported from it, or the well-known global that nothing here redefines."""
    if name in source.imports:
        return source.imports[name][0] in (library, f"node-{library}", f"cross-{library}")
    return name == library and name not in source.declarators and name not in source.functions


def _js_interceptor(source: _JsFile, callback: Any, origin: str) -> Tuple[Dict[str, Sent], bool]:
    """What a request interceptor adds, by kind, and whether it does anything
    that was not understood (in which case nothing can be said to be absent)."""
    added = {"query": Sent(), "headers": Sent(), "body": Sent()}
    callback = _js_unwrap(callback)
    parameters = _JsTracer._parameters(callback) if callback is not None and callback.type in _JS_FUNCTIONS else []
    if not parameters or parameters[0].type != "identifier":
        return added, True
    config = _text(parameters[0])
    inside = lambda node: {key: label for key, label in source.guards(node).items() if key not in source.guards(callback) and key != callback.id}
    opaque = False
    for node in _js_walk(callback):
        if node.type == "call_expression" and any(_text(argument) == config for argument in _js_arguments(node)):
            opaque = True  # the configuration is handed to another function
        if node.type != "assignment_expression":
            continue
        left, right = node.child_by_field_name("left"), _js_unwrap(node.child_by_field_name("right"))
        state = "conditional" if inside(node) else "definite"
        line = node.start_point[0] + 1
        target = _text(left)
        for kind, bucket in _JS_BUCKETS.items():
            if target == f"{config}.{kind}":
                if right is not None and right.type == "object":
                    literal = Sent()
                    for child in right.named_children:
                        if child.type == "pair" and _js_key(child.child_by_field_name("key")) is not None:
                            literal.keys.add(_js_key(child.child_by_field_name("key")))
                        elif child.type == "shorthand_property_identifier":
                            literal.keys.add(_text(child))
                        elif child.type != "spread_element":
                            opaque = True
                    added[bucket].absorb(literal, state, line, origin)
                else:
                    opaque = True
            elif left is not None and left.type in ("member_expression", "subscript_expression") and _text(left.child_by_field_name("object")) in (f"{config}.{kind}", f"{config}.{kind}.common"):
                key = _js_key(left.child_by_field_name("property")) if left.type == "member_expression" else _js_static_string(left.child_by_field_name("index"))
                if key is None:
                    opaque = True
                else:
                    added[bucket].add(key, state, line, origin)
    return added, opaque


def _js_client(repo: "Repository", source: _JsFile, call: Any) -> Tuple[str, Dict[str, Sent]]:
    """What is known about the client a request goes through: ("" when its
    configuration is fully visible, else why not) and what it adds by default.

    `fetch(...)` has no shared configuration. The axios library object and an
    instance made with `axios.create({...})` are read: literal defaults, and
    request interceptors registered anywhere in the repository. Any other
    object may add parameters, headers or body fields that are not visible."""
    added = {"query": Sent(), "headers": Sent(), "body": Sent()}
    name, target = _js_callee(call)
    receiver = _js_unwrap(target)
    if receiver is None:
        if name == "fetch" and _js_is_library(source, name, "fetch"):
            return "", added
        if not _js_is_library(source, name, "axios"):
            return f"the request is sent by {name or 'a call'}(), which is not a known HTTP library call", added
        owner: Any = "global"
    elif receiver.type == "identifier" and _js_is_library(source, _text(receiver), "axios"):
        owner = "global"
    else:
        instance = repo.axios_instance(source, receiver, call) if receiver.type == "identifier" else None
        if instance is None:
            return f"the request is sent through '{_text(receiver)[:50]}', a client whose defaults and interceptors are not visible here", added
        home, declaration = instance
        owner = (home.file, declaration.id)
        label = _text(declaration.child_by_field_name("name"))
        where = f"{home.file}:{declaration.start_point[0] + 1}"
        options = _js_arguments(_js_unwrap(declaration.child_by_field_name("value")))
        options = _js_unwrap(options[0]) if options else None
        if options is not None and options.type != "object":
            return f"the client '{label}' is created at {where} with options that are not an object literal", added
        if options is not None:
            if any(child.type == "spread_element" for child in options.named_children):
                return f"the client '{label}' is created at {where} with options merged from another object", added
            if any(_js_property(options, key) is not None for key in _JS_REQUEST_CHANGERS):
                return f"the client '{label}' is created at {where} with a request transform", added
            for kind, bucket in _JS_BUCKETS.items():
                added[bucket].absorb(_js_sent(repo, home, home.root, _js_property(options, kind), declaration), "definite", declaration.start_point[0] + 1, f"a default of the client '{label}' ({where})")

    reason = ""
    for entry in repo.axios_configuration():
        applies = entry["owner"] == owner or (entry["owner"] == "global" and entry["kind"] == "defaults")  # instances copy the library defaults
        if entry["owner"] == "unknown":
            reason = reason or f"a request {entry['kind'] if entry['kind'] == 'interceptor' else 'default'} is registered at {entry['where']} on a client that could not be identified"
            continue
        if not applies:
            continue
        for bucket, sent in entry["adds"].items():
            added[bucket].absorb(sent)
        if entry["opaque"]:
            reason = reason or entry["opaque"]
    return reason, added


def _js_request(repo: "Repository", source: _JsFile, call: Any, facts: CallFacts) -> None:
    name, _ = _js_callee(call)
    scope = source.scope_of(call)
    arguments = [_js_unwrap(argument) for argument in _js_arguments(call)]
    url = arguments[0] if arguments else None
    config: Any = None
    body: Any = None
    if url is not None and url.type == "object":  # axios({ url, method, data, params })
        config, url = url, _js_property(url, "url")
        body = _js_property(config, "data") or _js_property(config, "body")
    elif name in _BODY_VERBS:
        body = arguments[1] if len(arguments) > 1 else None
        config = arguments[2] if len(arguments) > 2 else None
    elif name in _VERBS:
        config = arguments[1] if len(arguments) > 1 else None
        body = _js_property(config, "data")
    else:  # fetch(url, init) and look-alikes
        config = arguments[1] if len(arguments) > 1 else None
        body = _js_property(config, "body")
    facts.method, facts.method_reason = _js_method(call)
    facts.body = _js_sent(repo, source, scope, body, call)
    facts.query = _js_sent(repo, source, scope, _js_property(config, "params") or _js_property(config, "searchParams"), call)
    facts.headers = _js_sent(repo, source, scope, _js_property(config, "headers"), call)
    _query_from_url(_text(url), facts.query)
    if url is not None and url.type == "call_expression" and _js_callee(url)[0] not in ("String", "concat", "toString", "encodeURI"):
        facts.query.limit(f"the URL is passed through {_js_callee(url)[0] or 'a call'}(), which may add query parameters")
    if config is not None and config.type != "object":
        for sent in (facts.body, facts.query, facts.headers):
            sent.unknown(f"the request options come from '{_text(config)[:40]}', which is not an object literal here")
    elif config is not None and any(child.type == "spread_element" for child in config.named_children):
        for sent in (facts.body, facts.query, facts.headers):
            sent.unknown("the request options merge in another object with ...spread")
    # What the client adds to every request. Without that, "not in this call" is not "not sent".
    unknown, added = _js_client(repo, source, call)
    for bucket, sent in (("body", facts.body), ("query", facts.query), ("headers", facts.headers)):
        sent.absorb(added[bucket])
        if unknown:
            sent.limit(unknown)


# ---- One repository -------------------------------------------------------------------

class Repository:
    """Parsed source files of one consumer, loaded on demand."""

    def __init__(self, files: Dict[str, str]):
        self.files = files
        self._parsed: Dict[str, Any] = {}
        self._facts: Dict[Tuple[str, int], CallFacts] = {}
        self._axios: Optional[List[dict]] = None

    @staticmethod
    def language(file: str) -> str:
        if file.endswith(".py"):
            return "python"
        if file.endswith((".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")):
            return "javascript"
        return ""

    def parsed(self, file: str) -> Any:
        """A _PyFile / _JsFile, or a string saying why the file could not be parsed."""
        if file not in self._parsed:
            language = self.language(file)
            try:
                if language == "python":
                    self._parsed[file] = _PyFile(file, self.files[file])
                elif language == "javascript" and _JS_AVAILABLE:
                    self._parsed[file] = _JsFile(file, self.files[file])
                elif language == "javascript":
                    self._parsed[file] = "the JavaScript parser (tree-sitter) is not installed on the backend"
                else:
                    self._parsed[file] = "field-level analysis supports Python, JavaScript and TypeScript only"
            except (SyntaxError, ValueError, RecursionError) as error:
                self._parsed[file] = f"the file could not be parsed ({type(error).__name__})"
        return self._parsed[file]

    def call_facts(self, file: str, line: int) -> CallFacts:
        if (file, line) not in self._facts:
            try:
                self._facts[(file, line)] = self._call_facts(file, line)
            except Exception as error:  # a file this analysis cannot handle must never fail the scan
                self._facts[(file, line)] = CallFacts(file, line, reason=f"the source could not be analyzed ({type(error).__name__})")
        return self._facts[(file, line)]

    def _call_facts(self, file: str, line: int) -> CallFacts:
        facts = CallFacts(file, line)
        source = self.parsed(file)
        if isinstance(source, str):
            facts.reason = source
            return facts
        call = source.find_call(line)
        if call is None:
            facts.reason = "the URL on this line is not passed directly to an HTTP call in the same function"
            return facts
        facts.located = True
        if isinstance(source, _PyFile):
            _py_request(self, source, call, facts)
            facts.trace = self._follow_python(source, source.scope_of(call), {id(call): RESP}, 0)
        else:
            _js_request(self, source, call, facts)
            facts.trace = self._follow_js(source, source.scope_of(call), {call.id: RESP}, 0)
        return facts

    def _others(self, language: str, needle: str) -> List[Any]:
        found = []
        for file, text in self.files.items():
            if self.language(file) == language and needle in text:
                source = self.parsed(file)
                if not isinstance(source, str):
                    found.append(source)
        return found

    # -- Which function does a call reach? Only edges that the source itself establishes. --

    def _python_module(self, source: _PyFile, module: str, level: int) -> Optional[_PyFile]:
        """The inspected file an import refers to, or None (a library, or ambiguous)."""
        parts = [part for part in module.split(".") if part]
        if level:
            base = posixpath.dirname(source.file)
            for _ in range(level - 1):
                base = posixpath.dirname(base)
            stem = posixpath.join(base, *parts) if parts else base
            matches = [name for name in (stem + ".py", posixpath.join(stem, "__init__.py")) if name in self.files]
        else:
            if not parts:
                return None
            tail = "/".join(parts)
            matches = [name for name in self.files if name in (tail + ".py", tail + "/__init__.py") or name.endswith(("/" + tail + ".py", "/" + tail + "/__init__.py"))]
            if len(matches) > 1:  # prefer the one next to the importing file
                near = [name for name in matches if posixpath.dirname(name).startswith(posixpath.dirname(source.file))]
                matches = near if len(near) == 1 else matches
        parsed = self.parsed(matches[0]) if len(matches) == 1 else None
        return parsed if isinstance(parsed, _PyFile) else None

    def _python_class(self, source: _PyFile, name: str) -> Optional[Tuple[_PyFile, str]]:
        if name in source.classes:
            return source, name
        if name in source.imported:
            module, original, level = source.imported[name]
            other = self._python_module(source, module, level)
            if other is not None and original in other.classes:
                return other, original
        return None

    def resolve_python(self, source: _PyFile, call: ast.Call) -> Tuple[Optional[Tuple[_PyFile, ast.AST]], str]:
        """((file, function definition), "") when the call provably reaches that
        definition, else (None, why not). A matching name is never enough: the
        function must be defined in scope, imported from an inspected file, a
        method of the same class, or a method of a class instantiated here."""
        func = call.func
        if isinstance(func, ast.Name):
            name = func.id
            scope = source.scope_of(call)
            while not isinstance(scope, ast.Module):  # a helper defined inside an enclosing function
                nested = [n for n in getattr(scope, "body", []) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name] if not isinstance(scope, ast.Lambda) else []
                if len(nested) == 1:
                    return (source, nested[0]), ""
                scope = source.scope_of(scope)
            if name in source.imported:
                module, original, level = source.imported[name]
                other = self._python_module(source, module, level)
                if other is None:
                    return None, f"{name}() is imported from '{'.' * level}{module}', which is not among the inspected files"
                found = other.functions.get(original, [])
                return ((other, found[0]), "") if len(found) == 1 else (None, f"{name}() is not a single module-level function in {other.file}")
            found = source.functions.get(name, [])
            if len(found) == 1:
                return (source, found[0]), ""
            return None, f"{name}() is not defined in this file and is not imported from an inspected file"
        if isinstance(func, ast.Attribute):
            name, receiver = func.attr, func.value
            owner: Optional[Tuple[_PyFile, str]] = None
            if isinstance(receiver, ast.Name) and receiver.id in ("self", "cls"):
                owner = (source, source.class_of(call)) if source.class_of(call) else None
            elif isinstance(receiver, ast.Name):
                module = source.modules.get(receiver.id)
                if module is None and receiver.id in source.imported:  # from package import module
                    package, original, level = source.imported[receiver.id]
                    other = self._python_module(source, f"{package}.{original}" if package else original, level)
                else:
                    other = self._python_module(source, module, 0) if module else None
                if other is not None:
                    found = other.functions.get(name, [])
                    return ((other, found[0]), "") if len(found) == 1 else (None, f"{name}() is not a single module-level function in {other.file}")
                created = source.constructor_of(receiver.id, call)
                if created is not None and isinstance(created.func, ast.Name):
                    owner = self._python_class(source, created.func.id)
            elif isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name):
                owner = self._python_class(source, receiver.func.id)
            if owner is not None:
                found = owner[0].classes.get(owner[1], {}).get(name, [])
                if len(found) == 1:
                    return (owner[0], found[0]), ""
            return None, f"{name}() is called on '{ast.unparse(receiver)[:50]}', whose type is not known statically"
        return None, "the function that is called is computed at runtime"

    @staticmethod
    def _prefix(value: Value) -> str:
        return "" if value == RESP else normalize_field(value[1])

    def _follow_python(self, source: _PyFile, scope: ast.AST, seeds: Dict[Any, Value], depth: int) -> Trace:
        tracer = _PyTracer(source, scope, seeds)
        trace = tracer.run()
        for call, position, _argument, value, line in tracer.passed:
            name = _py_name(call.func) or "a function"
            target, reason = self.resolve_python(source, call)
            if target is None:
                trace.opens.append((self._prefix(value), f"it is passed to {name}(), which could not be followed: {reason}", source.file, line))
                continue
            other, definition = target
            parameters = [*definition.args.posonlyargs, *definition.args.args]
            if parameters and parameters[0].arg in ("self", "cls") and isinstance(call.func, ast.Attribute):
                parameters = parameters[1:]
            if isinstance(position, int):
                parameter = parameters[position] if position < len(parameters) else None
            else:
                parameter = next((item for item in [*parameters, *definition.args.kwonlyargs] if item.arg == position), None)
            if parameter is None:
                trace.opens.append((self._prefix(value), f"it is passed to {name}(), whose matching parameter could not be found", source.file, line))
            elif depth >= _MAX_DEPTH:
                trace.opens.append((self._prefix(value), f"it is passed to {name}(), beyond the {_MAX_DEPTH} functions that are followed", source.file, line))
            else:
                trace.merge(self._follow_python(other, definition, {id(parameter): value}, depth + 1))
        if tracer.returned:
            name = getattr(scope, "name", "")
            callers: List[Tuple[_PyFile, ast.AST, Any]] = []
            unknown = 0
            for other in (self._others("python", name) if name else []):
                for node in ast.walk(other.tree):
                    if isinstance(node, ast.Call) and _py_name(node.func) == name:
                        target, _ = self.resolve_python(other, node)
                        if target is not None and target[1] is scope:
                            callers.append((other, other.scope_of(node), id(node)))
                        elif target is None:
                            unknown += 1
            self._handed_on(trace, tracer.returned, name, depth, source.file, callers, unknown, self._follow_python)
        return trace

    def _handed_on(self, trace: Trace, returned: List[Tuple[Value, int]], name: str, depth: int, file: str, callers: List[Tuple[Any, Any, Any]], unknown: int, follow: Any) -> None:
        """Follow a returned response to the calls that provably reach this function."""
        values = {value for value, _ in returned}
        value, line = returned[0]
        reason = ""
        if len(values) > 1:
            reason = f"{name or 'the function'}() returns the response in more than one shape"
        elif not name:
            reason = "it is returned from an unnamed function, whose callers cannot be identified"
        elif depth >= _MAX_DEPTH:
            reason = f"it is returned through more than {_MAX_DEPTH} functions"
        elif not callers:
            reason = f"it is returned by {name}() and no caller was found in the inspected files"
            if unknown:
                reason += f" ({unknown} call(s) to a {name}() on an object of unknown type could not be tied to it)"
        if reason:
            trace.opens.append((self._prefix(value), reason, file, line))
            return
        for source, scope, key in callers:
            trace.merge(follow(source, scope, {key: value}, depth + 1))

    _JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")

    def _js_module(self, source: _JsFile, module: str) -> Optional[_JsFile]:
        """The inspected file a relative import refers to. Packages and path aliases are not resolved."""
        if not module.startswith("."):
            return None
        base = posixpath.normpath(posixpath.join(posixpath.dirname(source.file), module))
        stems = [base] + ([base.rsplit(".", 1)[0]] if base.endswith(self._JS_EXTENSIONS) else [])
        for stem in stems:
            for name in [stem] + [stem + extension for extension in self._JS_EXTENSIONS] + [posixpath.join(stem, "index" + extension) for extension in self._JS_EXTENSIONS]:
                if name in self.files and self.language(name) == "javascript":
                    parsed = self.parsed(name)
                    return parsed if isinstance(parsed, _JsFile) else None
        return None

    def _js_class(self, source: _JsFile, name: str) -> Optional[Tuple[_JsFile, str]]:
        if name in source.classes:
            return source, name
        if name in source.imports:
            module, original = source.imports[name]
            other = self._js_module(source, module)
            if other is not None and other.exported_class(original):
                return other, other.exported_class(original)
        return None

    def resolve_js(self, source: _JsFile, call: Any) -> Tuple[Optional[Tuple[_JsFile, Any]], str]:
        """((file, function), "") when the call provably reaches that function,
        else (None, why not). A matching name is never enough: the function must
        be in scope, imported from an inspected file through a relative path, a
        method of the same class, or a method of a class instantiated here."""
        function = _js_unwrap(call.child_by_field_name("function"))
        if function is None:
            return None, "the function that is called could not be read"
        if function.type == "identifier":
            name = _text(function)
            visible = [node for node in source.functions.get(name, []) if source.visible(node, call)]
            if len(visible) > 1:  # the innermost definition shadows the others
                innermost = max(source.scope_of(node).start_byte for node in visible)
                visible = [node for node in visible if source.scope_of(node).start_byte == innermost]
            if len(visible) == 1:
                return (source, visible[0]), ""
            if visible:
                return None, f"{name}() is defined more than once in this scope"
            if name in source.imports:
                module, original = source.imports[name]
                other = self._js_module(source, module)
                if other is None:
                    return None, f"{name}() is imported from '{module}', which is not among the inspected files"
                target = other.exported(original)
                return ((other, target), "") if target is not None else (None, f"{name}() is not a single exported function in {other.file}")
            return None, f"{name}() is not defined in this file and is not imported from an inspected file"
        if function.type == "member_expression":
            name = _text(function.child_by_field_name("property"))
            receiver = _js_unwrap(function.child_by_field_name("object"))
            owner: Optional[Tuple[_JsFile, str]] = None
            if receiver is not None and receiver.type == "this":
                owner = (source, source.class_of(call)) if source.class_of(call) else None
            elif receiver is not None and receiver.type == "identifier":
                local = _text(receiver)
                if local in source.imports and source.imports[local][1] == "*":
                    other = self._js_module(source, source.imports[local][0])
                    if other is None:
                        return None, f"{local}.{name}() belongs to '{source.imports[local][0]}', which is not among the inspected files"
                    target = other.exported(name)
                    return ((other, target), "") if target is not None else (None, f"{name}() is not a single exported function in {other.file}")
                created = [_js_unwrap(node.child_by_field_name("value")) for node in source.declarators.get(local, [])]
                if len(created) == 1 and created[0] is not None and created[0].type == "new_expression":
                    constructor = created[0].child_by_field_name("constructor")
                    owner = self._js_class(source, _text(constructor)) if constructor is not None and constructor.type == "identifier" else None
            if owner is not None:
                found = owner[0].classes.get(owner[1], {}).get(name, [])
                if len(found) == 1:
                    return (owner[0], found[0]), ""
            return None, f"{name}() is called on '{_text(receiver)[:50]}', whose type is not known statically"
        return None, "the function that is called is computed at runtime"

    def axios_instance(self, source: _JsFile, receiver: Any, site: Any) -> Optional[Tuple[_JsFile, Any]]:
        """(file, declaration) of `const api = axios.create(...)` that `receiver` names, here or through a relative import."""
        name, home = _text(receiver), source
        if name in source.imports and name not in source.declarators:
            module, original = source.imports[name]
            other = self._js_module(source, module)
            if other is None:
                return None
            target = _js_unwrap(other.default_export) if original == "default" else None
            name, home = (_text(target) if target is not None and target.type == "identifier" else original), other
        declared = [node for node in home.declarators.get(name, []) if home is not source or home.visible(node, site) or home.scope_of(node).id == home.root.id]
        if len(declared) != 1:
            return None
        value = _js_unwrap(declared[0].child_by_field_name("value"))
        if value is None or value.type != "call_expression":
            return None
        method, library = _js_callee(value)
        if method != "create" or library is None or library.type != "identifier" or not _js_is_library(home, _text(library), "axios"):
            return None
        return home, declared[0]

    def axios_configuration(self) -> List[dict]:
        """Request interceptors and default assignments on axios objects, across
        the repository: [{kind, owner, where, adds, opaque}]. `owner` is "global"
        for the library object, (file, declaration id) for an instance created
        with axios.create, or "unknown" when the object cannot be identified."""
        if self._axios is not None:
            return self._axios
        self._axios = []
        for file, text in self.files.items():
            if self.language(file) != "javascript" or ("interceptors" not in text and ".defaults" not in text):
                continue
            source = self.parsed(file)
            if isinstance(source, str):
                continue

            def owner_of(node: Any) -> Any:
                node = _js_unwrap(node)
                if node is None or node.type != "identifier":
                    return "unknown"
                if _js_is_library(source, _text(node), "axios"):
                    return "global"
                instance = self.axios_instance(source, node, node)
                return (instance[0].file, instance[1].id) if instance is not None else "unknown"

            for node in _js_walk(source.root):
                where = f"{file}:{node.start_point[0] + 1}"
                if node.type == "call_expression":
                    function = _js_unwrap(node.child_by_field_name("function"))
                    if function is None or function.type != "member_expression" or not _JS_INTERCEPTOR.match(_text(function)):
                        continue
                    chain = function.child_by_field_name("object")                       # X.interceptors.request
                    holder = chain.child_by_field_name("object") if chain is not None else None  # X.interceptors
                    arguments = _js_arguments(node)
                    adds, opaque = _js_interceptor(source, arguments[0] if arguments else None, f"added by a request interceptor at {where}")
                    self._axios.append({
                        "kind": "interceptor", "where": where, "adds": adds,
                        "owner": owner_of(holder.child_by_field_name("object") if holder is not None else None),
                        # Even a fully read interceptor may remove or rename what it does not add; absence is never concluded from it.
                        "opaque": f"a request interceptor registered at {where} can change the request" + (" and could not be read completely" if opaque else ""),
                    })
                elif node.type == "assignment_expression":
                    left = node.child_by_field_name("left")
                    match = _JS_DEFAULTS.match(_text(left)) if left is not None else None
                    if match is None:
                        continue
                    kind, rest = match.group("kind"), match.group("rest")
                    owner_node = left
                    while owner_node is not None and _text(owner_node) != match.group("owner"):
                        owner_node = owner_node.child_by_field_name("object")
                    adds = {"query": Sent(), "headers": Sent(), "body": Sent()}
                    state = "definite" if source.scope_of(node).id == source.root.id and not source.guards(node) else "conditional"
                    origin = f"a default set at {where}"
                    opaque = ""
                    right = _js_unwrap(node.child_by_field_name("right"))
                    if kind not in _JS_BUCKETS:
                        opaque = f"a request transform is set at {where}"
                    elif not rest:
                        value = _js_sent(self, source, source.root, right, node)
                        adds[_JS_BUCKETS[kind]].absorb(value, state, node.start_point[0] + 1, origin)
                        if not value.complete:
                            opaque = f"the default {kind} are set at {where} from a value that is not a literal"
                    else:
                        key = _js_key(left.child_by_field_name("property")) if left.type == "member_expression" else _js_static_string(left.child_by_field_name("index"))
                        if key is None:
                            opaque = f"a default is set at {where} under a name computed at runtime"
                        else:
                            adds[_JS_BUCKETS[kind]].add(key, state, node.start_point[0] + 1, origin)
                    self._axios.append({"kind": "defaults", "where": where, "adds": adds, "owner": owner_of(owner_node), "opaque": opaque})
        return self._axios

    def _follow_js(self, source: _JsFile, scope: Any, seeds: Dict[Any, Value], depth: int, state: Optional[Tuple[str, Any, Any]] = None) -> Trace:
        tracer = _JsTracer(source, scope, seeds)
        if state is not None:  # a React state variable now holds the value given to its setter
            name, declaration, node = state
            # Same block as the declaration and just after it, so it takes over from `useState(initial)`.
            tracer.add_site(name, declaration.end_byte + 1, tracer._block(declaration), node, line=node.start_point[0] + 1, replaces=True)
        trace = tracer.run()
        for call, position, argument, value, line in tracer.passed:
            name, receiver = _js_callee(call)
            # A React state setter: only the one declared in a component that encloses this call.
            setters = [item for item in source.state_setters.get(name, []) if receiver is None and item[1].start_byte <= call.start_byte and call.end_byte <= item[1].end_byte]
            if len(setters) == 1:
                state_name, component, declaration = setters[0]
                if argument.id in seeds:
                    continue  # this is the setter call already being followed
                if depth < _MAX_DEPTH:
                    trace.merge(self._follow_js(source, component, {argument.id: value}, depth + 1, (state_name, declaration, argument)))
                else:
                    trace.opens.append((self._prefix(value), f"it is stored in React state by {name}()", source.file, line))
                continue
            target, reason = self.resolve_js(source, call)
            if target is None:
                trace.opens.append((self._prefix(value), f"it is passed to {name or 'a function'}(), which could not be followed: {reason}", source.file, line))
                continue
            other, function = target
            parameters = _JsTracer._parameters(function)
            if position >= len(parameters):
                trace.opens.append((self._prefix(value), f"it is passed to {name}(), whose matching parameter could not be found", source.file, line))
            elif depth >= _MAX_DEPTH:
                trace.opens.append((self._prefix(value), f"it is passed to {name}(), beyond the {_MAX_DEPTH} functions that are followed", source.file, line))
            else:
                trace.merge(self._follow_js(other, function, {parameters[position].id: value}, depth + 1))
        if tracer.returned:
            name = _JsFile.function_name(scope) if scope.type in _JS_FUNCTIONS else ""
            callers: List[Tuple[_JsFile, Any, Any]] = []
            unknown = 0
            for other in (self._others("javascript", name) if name else []):
                for node in _js_walk(other.root):
                    if node.type == "call_expression" and _js_callee(node)[0] == name:
                        target, _ = self.resolve_js(other, node)
                        if target is not None and target[0] is source and target[1].id == scope.id:
                            callers.append((other, other.scope_of(node), node.id))
                        elif target is None:
                            unknown += 1
            self._handed_on(trace, tracer.returned, name, depth, source.file, callers, unknown, self._follow_js)
        return trace


# ---- Decision ---------------------------------------------------------------------------

def _result(tier: str, usage: str, explanation: str, file: str, line: int) -> dict:
    return {"evidence_tier": tier, "usage": usage, "explanation": explanation, "file": file, "line": line}


def _sent_decision(sent: Sent, name: str, what: str, where: str, facts: CallFacts, case_insensitive: bool = False) -> dict:
    keys = {key.lower() for key in sent.keys} if case_insensitive else sent.keys
    wanted = name.lower() if case_insensitive else name
    origin = next((text for key, text in sent.origin.items() if (key.lower() if case_insensitive else key) == wanted), "")
    if wanted in keys:
        if origin:
            return _result(T2_FIELD_MATCH, SENDS_REQUIRED_FIELD, f"The request includes {what} '{name}': it is {origin}.", facts.file, facts.line)
        return _result(T2_FIELD_MATCH, SENDS_REQUIRED_FIELD, f"This call already sends {what} '{name}'.", facts.file, facts.line)
    conditional = {(key.lower() if case_insensitive else key): line for key, line in sent.conditional.items()}
    if wanted in conditional:
        source = f" ({origin})" if origin else ""
        return _result(T2_FIELD_MATCH, MAY_SEND_REQUIRED_FIELD,
                       f"{what.capitalize()} '{name}' is set only on some paths before this request (line {conditional[wanted]}){source}, so a request without it is possible.", facts.file, facts.line)
    parent = next((key for key in sent.opaque if wanted.startswith(key + ".")), None)
    if parent is not None:
        return _result(UNRESOLVED, NOT_DETERMINED, f"Whether {what} '{name}' is sent cannot be determined: the value of '{parent}' is not a literal in this call.", facts.file, facts.line)
    if not sent.complete:
        return _result(UNRESOLVED, NOT_DETERMINED, f"Whether {what} '{name}' is sent cannot be determined: {sent.reason}.", facts.file, facts.line)
    listed = f"it sends {', '.join(sorted(sent.keys))}" if sent.keys else f"it sends no {where}"
    return _result(T2_FIELD_MATCH, OMITS_REQUIRED_FIELD, f"This call does not send {what} '{name}': {listed}.", facts.file, facts.line)


def assess(finding: dict, facts: CallFacts) -> dict:
    """Evidence for one contract change at one call site.

    T2_FIELD_MATCH needs the field itself: the code reads the changed response
    field, or the request is seen to send or omit the newly required one.
    T1_OPERATION_MATCH means the operation is called and nothing more is
    claimed. UNRESOLVED means the code could not be followed far enough."""
    change, name, where = finding["change_type"], finding.get("field", ""), finding.get("field_in", "")
    if change in ("REMOVED_PATH", "REMOVED_OPERATION"):
        return _result(T1_OPERATION_MATCH, CALLS_OPERATION, "This call targets an operation that the newer specification no longer defines.", facts.file, facts.line)
    if not facts.located:
        return _result(UNRESOLVED, NOT_DETERMINED, f"The operation is referenced here, but field usage could not be analyzed: {facts.reason}.", facts.file, facts.line)

    if change == "CHANGED_RESPONSE_FIELD_TYPE":
        wanted = normalize_field(name.split("."))
        trace = facts.trace
        read = trace.reads.get(wanted) if wanted else trace.body_read
        if read is not None:
            target = f"response field '{wanted}'" if wanted else "the response body"
            return _result(T2_FIELD_MATCH, READS_CHANGED_FIELD, f"The code reads {target}, whose type changed.", read[0], read[1])
        lost = next((item for item in trace.opens if _covers(item[0], wanted)), None)
        if lost is not None:
            scope = f"'{lost[0]}'" if lost[0] else "the response"
            return _result(UNRESOLVED, NOT_DETERMINED, f"Whether '{wanted or 'the body'}' is read cannot be determined: {scope} could not be followed because {lost[1]}.", lost[2], lost[3])
        others = sorted(trace.reads)
        seen = f"It reads {', '.join(others[:6])}" if others else "The response body is not read"
        return _result(T1_OPERATION_MATCH, FIELD_NOT_READ, f"This call uses the operation. {seen} in the code that was followed; no read of '{wanted or 'the body'}' was found.", facts.file, facts.line)

    if where == "request_body":
        if not name:  # the body itself became required
            if facts.body.present:
                return _result(T2_FIELD_MATCH, SENDS_REQUIRED_FIELD, "This call already sends a request body.", facts.file, facts.line)
            return _result(T2_FIELD_MATCH, OMITS_REQUIRED_FIELD, "This call sends no request body.", facts.file, facts.line)
        return _sent_decision(facts.body, normalize_field(name.split(".")), "request field", "request body", facts)
    if where == "query":
        return _sent_decision(facts.query, name, "query parameter", "query parameters", facts)
    if where == "header":
        if facts.headers.present and name.lower() in {key.lower() for key in facts.headers.keys}:
            return _sent_decision(facts.headers, name, "header", "headers", facts, case_insensitive=True)
        return _result(UNRESOLVED, NOT_DETERMINED, f"Whether header '{name}' is sent cannot be determined: headers are often set on a shared client, outside this call.", facts.file, facts.line)
    return _result(UNRESOLVED, NOT_DETERMINED, f"Parameters sent in '{where or 'this location'}' are not analyzed.", facts.file, facts.line)


#: When several call sites of one consumer hit the same change, the entry reports the strongest claim.
_RANK = {READS_CHANGED_FIELD: 0, OMITS_REQUIRED_FIELD: 0, MAY_SEND_REQUIRED_FIELD: 1, NOT_DETERMINED: 2, CALLS_OPERATION: 3, FIELD_NOT_READ: 3, SENDS_REQUIRED_FIELD: 4}


def strongest(results: List[dict]) -> dict:
    return min(results, key=lambda item: _RANK.get(item["usage"], 9))
