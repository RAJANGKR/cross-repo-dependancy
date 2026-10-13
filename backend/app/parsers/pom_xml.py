import logging
import os
import re
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional

from app.parsers.base import BaseDependencyParser
from app.schemas.dependency import DependencyItem, DependencyType, Ecosystem

logger = logging.getLogger(__name__)

_PROPERTY = re.compile(r"\$\{([^}]+)\}")
_SCOPES = {"test": DependencyType.DEV, "provided": DependencyType.OPTIONAL}


def _strip(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(node: ET.Element, name: str) -> Optional[ET.Element]:
    return next((c for c in node if _strip(c.tag) == name), None)


def _text(node: Optional[ET.Element], name: str) -> str:
    child = _child(node, name) if node is not None else None
    return (child.text or "").strip() if child is not None else ""


class PomXmlParser(BaseDependencyParser):
    """Direct dependencies from pom.xml. Handles the common cases only:
    ${property} from <properties> and versions from <dependencyManagement>.
    Parent POMs and BOM imports are not followed; a version that cannot be
    resolved is returned empty so the scan reports it as skipped."""

    @property
    def ecosystem(self) -> Ecosystem:
        return Ecosystem.MAVEN

    def supports(self, filename: str) -> bool:
        return os.path.basename(filename).lower() == "pom.xml"

    def parse(self, content: str, filename: str = "pom.xml") -> List[DependencyItem]:
        # Untrusted XML: refuse DTDs and entities instead of expanding them.
        if not content or "<!DOCTYPE" in content or "<!ENTITY" in content:
            return []
        try:
            root = ET.fromstring(content)
        except ET.ParseError as exc:
            logger.warning("Failed to parse XML in %s: %s", filename, exc)
            return []

        properties: Dict[str, str] = {"project.version": _text(root, "version")}
        props_node = _child(root, "properties")
        if props_node is not None:
            for prop in props_node:
                properties[_strip(prop.tag)] = (prop.text or "").strip()

        def resolve(value: str) -> str:
            for _ in range(5):  # properties may reference other properties
                match = _PROPERTY.search(value)
                if not match or match.group(1) not in properties:
                    break
                value = value.replace(match.group(0), properties[match.group(1)])
            return value

        managed: Dict[str, str] = {}
        management = _child(root, "dependencyManagement")
        for dep in self._dependencies(management):
            key = f"{_text(dep, 'groupId')}:{_text(dep, 'artifactId')}"
            managed[key] = resolve(_text(dep, "version"))

        items: List[DependencyItem] = []
        for dep in self._dependencies(root):
            group, artifact = resolve(_text(dep, "groupId")), resolve(_text(dep, "artifactId"))
            if not group or not artifact:
                continue
            name = f"{group}:{artifact}"
            version = resolve(_text(dep, "version")) or managed.get(name, "")
            items.append(
                DependencyItem(
                    name=name,
                    version_spec=version,
                    ecosystem=self.ecosystem,
                    dep_type=_SCOPES.get(_text(dep, "scope"), DependencyType.RUNTIME),
                    source_file=filename,
                    raw_spec=f"{name}:{version}",
                )
            )
        return items

    @staticmethod
    def _dependencies(parent: Optional[ET.Element]) -> List[ET.Element]:
        container = _child(parent, "dependencies") if parent is not None else None
        return [d for d in container if _strip(d.tag) == "dependency"] if container is not None else []
