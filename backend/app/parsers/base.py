from abc import ABC, abstractmethod
from typing import List
from app.schemas.dependency import DependencyItem, Ecosystem


class BaseDependencyParser(ABC):
    @property
    @abstractmethod
    def ecosystem(self) -> Ecosystem:
        """The ecosystem this parser belongs to (npm, python)."""
        pass

    @abstractmethod
    def supports(self, filename: str) -> bool:
        """Check if this parser can handle the given file."""
        pass

    @abstractmethod
    def parse(self, content: str, filename: str = "") -> List[DependencyItem]:
        """Parse the raw file content and return a list of DependencyItem objects."""
        pass
