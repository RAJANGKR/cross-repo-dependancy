import logging
import os
import re
from typing import List
from packaging.requirements import Requirement, InvalidRequirement
from packaging.utils import canonicalize_name

from app.parsers.base import BaseDependencyParser
from app.schemas.dependency import DependencyItem, DependencyType, Ecosystem

logger = logging.getLogger(__name__)


class RequirementsTxtParser(BaseDependencyParser):
    @property
    def ecosystem(self) -> Ecosystem:
        return Ecosystem.PYTHON

    def supports(self, filename: str) -> bool:
        base = os.path.basename(filename).lower()
        # Handles requirements.txt, requirements-dev.txt, dev-requirements.txt, etc.
        return "requirements" in base and base.endswith((".txt", ".in"))

    def _determine_dep_type(self, filename: str) -> DependencyType:
        base = os.path.basename(filename).lower()
        if any(dev_kw in base for dev_kw in ["dev", "test", "lint", "ci"]):
            return DependencyType.DEV
        return DependencyType.RUNTIME

    def parse(self, content: str, filename: str = "requirements.txt") -> List[DependencyItem]:
        items: List[DependencyItem] = []
        if not content:
            return items

        dep_type = self._determine_dep_type(filename)

        for raw_line in content.splitlines():
            line = raw_line.strip()
            # Ignore empty lines and full line comments
            if not line or line.startswith("#"):
                continue

            # Strip inline comments (e.g., "fastapi>=0.100 # web framework")
            if " #" in line:
                line = line.split(" #", 1)[0].strip()

            # Ignore flags and nested requirement includes
            if line.startswith(("-r", "-i", "-f", "-e", "--extra-index-url", "--find-links", "--index-url", "--trusted-host")):
                continue

            # Attempt standard PEP 508 parsing with packaging.requirements.Requirement
            try:
                req = Requirement(line)
                norm_name = canonicalize_name(req.name)
                spec_str = str(req.specifier) if req.specifier else "*"
                items.append(
                    DependencyItem(
                        name=norm_name,
                        version_spec=spec_str,
                        ecosystem=self.ecosystem,
                        dep_type=dep_type,
                        source_file=filename,
                        raw_spec=line,
                    )
                )
                continue
            except InvalidRequirement:
                pass

            # Fallback regex parsing for loose or non-standard lines
            fallback_match = re.match(r"^([a-zA-Z0-9_\-\.]+)\s*([<>=!~].*)?$", line)
            if fallback_match:
                raw_name = fallback_match.group(1)
                norm_name = canonicalize_name(raw_name)
                spec_str = fallback_match.group(2).strip() if fallback_match.group(2) else "*"
                items.append(
                    DependencyItem(
                        name=norm_name,
                        version_spec=spec_str,
                        ecosystem=self.ecosystem,
                        dep_type=dep_type,
                        source_file=filename,
                        raw_spec=line,
                    )
                )
            else:
                logger.debug(f"Could not parse requirements line: {line} in {filename}")

        return items
