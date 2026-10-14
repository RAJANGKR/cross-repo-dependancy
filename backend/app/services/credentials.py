"""Repository credentials for one scan.

A scan that includes private repositories gets short-lived GitHub App
installation tokens, minted for exactly the repositories in that scan after
the signed-in user's access to each was checked. They live in this object,
which belongs to that scan's Http client and nothing else: they are never
cached, logged, stored with results or used by another scan or user."""
import re
import time
from dataclasses import dataclass
from typing import Dict, Optional

#: URLs that read one repository: the REST API, raw files and source archives.
_REPOSITORY_URL = re.compile(r"^https://(?:api\.github\.com/repos|raw\.githubusercontent\.com|codeload\.github\.com)/([^/?#]+)/([^/?#]+)", re.IGNORECASE)


@dataclass(frozen=True, repr=False)
class RepoCredential:
    token: str
    #: Epoch seconds at which GitHub stops accepting the token.
    expires_at: float
    installation_id: int
    repository_id: int

    def expired(self, margin_seconds: float = 30) -> bool:
        return time.time() >= self.expires_at - margin_seconds

    def __repr__(self) -> str:  # the token never appears in a log line or a traceback
        return f"RepoCredential(installation_id={self.installation_id}, repository_id={self.repository_id})"


class RepoCredentials:
    """{owner/repo: credential} for the private repositories of one scan."""

    def __init__(self) -> None:
        self._by_repository: Dict[str, RepoCredential] = {}

    def add(self, owner: str, repo: str, credential: RepoCredential) -> None:
        self._by_repository[f"{owner}/{repo}".lower()] = credential

    def get(self, owner: str, repo: str) -> Optional[RepoCredential]:
        return self._by_repository.get(f"{owner}/{repo}".lower())

    def for_url(self, url: str) -> Optional[RepoCredential]:
        match = _REPOSITORY_URL.match(url)
        return self.get(match.group(1), match.group(2)) if match else None

    def __len__(self) -> int:
        return len(self._by_repository)

    def __repr__(self) -> str:
        return f"RepoCredentials({sorted(self._by_repository)})"
