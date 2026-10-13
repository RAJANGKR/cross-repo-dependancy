from typing import List, Optional
from app.parsers.base import BaseDependencyParser
from app.parsers.package_json import PackageJsonParser
from app.parsers.requirements_txt import RequirementsTxtParser
from app.parsers.pyproject_toml import PyprojectTomlParser
from app.parsers.pom_xml import PomXmlParser
from app.schemas.dependency import DependencyItem


class ParserRegistry:
    def __init__(self):
        self._parsers: List[BaseDependencyParser] = [
            PackageJsonParser(),
            RequirementsTxtParser(),
            PyprojectTomlParser(),
            PomXmlParser(),
        ]

    def register(self, parser: BaseDependencyParser) -> None:
        self._parsers.append(parser)

    def get_parser(self, filename: str) -> Optional[BaseDependencyParser]:
        for parser in self._parsers:
            if parser.supports(filename):
                return parser
        return None

    def parse_file(self, filename: str, content: str) -> List[DependencyItem]:
        parser = self.get_parser(filename)
        if not parser:
            return []
        return parser.parse(content, filename=filename)


default_registry = ParserRegistry()


def parse_file_content(filename: str, content: str) -> List[DependencyItem]:
    return default_registry.parse_file(filename, content)
