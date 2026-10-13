import json
import logging
import os
from typing import List
from app.parsers.base import BaseDependencyParser
from app.schemas.dependency import DependencyItem, DependencyType, Ecosystem

logger = logging.getLogger(__name__)


class PackageJsonParser(BaseDependencyParser):
    @property
    def ecosystem(self) -> Ecosystem:
        return Ecosystem.NPM

    def supports(self, filename: str) -> bool:
        base = os.path.basename(filename).lower()
        return base == "package.json"

    def parse(self, content: str, filename: str = "package.json") -> List[DependencyItem]:
        items: List[DependencyItem] = []
        if not content or not content.strip():
            return items

        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            logger.warning(f"Failed to parse JSON in {filename}: {exc}")
            return items

        if not isinstance(data, dict):
            return items

        dep_sections = [
            ("dependencies", DependencyType.RUNTIME),
            ("devDependencies", DependencyType.DEV),
            ("peerDependencies", DependencyType.PEER),
            ("optionalDependencies", DependencyType.OPTIONAL),
        ]

        for section_key, dep_type in dep_sections:
            deps_dict = data.get(section_key)
            if isinstance(deps_dict, dict):
                for pkg_name, version_val in deps_dict.items():
                    if not isinstance(pkg_name, str):
                        continue
                    version_str = str(version_val).strip() if version_val is not None else "*"
                    items.append(
                        DependencyItem(
                            name=pkg_name.strip(),
                            version_spec=version_str,
                            ecosystem=self.ecosystem,
                            dep_type=dep_type,
                            source_file=filename,
                            raw_spec=f"{pkg_name}: {version_str}",
                        )
                    )

        return items
