"""Lockfile readers. They return resolved pins ({package name: exact version}),
which the scan keeps separate from the declared ranges in manifests."""
import json
import os
from typing import Dict

from packaging.utils import canonicalize_name

try:
    import tomllib
except ImportError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib  # type: ignore


def parse_package_lock(content: str) -> Dict[str, str]:
    """Top-level pins from package-lock.json (lockfile v1, v2 and v3)."""
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    pins: Dict[str, str] = {}
    packages = data.get("packages")
    if isinstance(packages, dict):
        for path, meta in packages.items():
            # Only direct installs: "node_modules/<name>", not nested copies.
            if not isinstance(meta, dict) or not path.startswith("node_modules/"):
                continue
            name = path[len("node_modules/"):]
            if "node_modules/" in name or meta.get("link"):
                continue
            version = meta.get("version")
            if isinstance(version, str):
                pins[name] = version
    if not pins and isinstance(data.get("dependencies"), dict):
        for name, meta in data["dependencies"].items():
            if isinstance(meta, dict) and isinstance(meta.get("version"), str):
                pins[name] = meta["version"]
    return pins


def parse_poetry_lock(content: str) -> Dict[str, str]:
    try:
        data = tomllib.loads(content)
    except Exception:
        return {}
    pins: Dict[str, str] = {}
    for package in data.get("package", []) if isinstance(data, dict) else []:
        if isinstance(package, dict) and isinstance(package.get("name"), str) and isinstance(package.get("version"), str):
            pins[canonicalize_name(package["name"])] = package["version"]
    return pins


LOCK_PARSERS = {"package-lock.json": parse_package_lock, "poetry.lock": parse_poetry_lock}
# Which manifest a lockfile pins, used to pair them inside one folder.
LOCK_ECOSYSTEM = {"package-lock.json": "npm", "poetry.lock": "python"}


def is_lockfile(filename: str) -> bool:
    return os.path.basename(filename).lower() in LOCK_PARSERS


def parse_lockfile(filename: str, content: str) -> Dict[str, str]:
    parser = LOCK_PARSERS.get(os.path.basename(filename).lower())
    return parser(content) if parser else {}
