"""One outbound HTTP path for the whole backend: timeout, bounded retries with
backoff, response size caps, GitHub rate-limit detection and a stale-cache
fallback. Tokens and request bodies are never logged."""
import asyncio
import hashlib
import json
import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

from app.services.cache import Cache

logger = logging.getLogger("driftlock.http")

_CHANGELOG_PROBE_RE = re.compile(
    r"/(?:CHANGELOG|CHANGES|HISTORY|RELEASE|RELEASES)(?:\.(?:md|markdown|rst|txt))?(?:\?.*)?$",
    re.IGNORECASE,
)


def _is_expected_probe_404(url: str) -> bool:
    """True for speculative probe requests (such as root changelog files) where a 404 is an expected normal miss."""
    return bool(_CHANGELOG_PROBE_RE.search(url))


class FetchError(Exception):
    """kind: not_found | rate_limit | timeout | network | http | too_large | invalid"""

    def __init__(self, kind: str, status: Optional[int] = None, message: str = ""):
        super().__init__(message or kind)
        self.kind, self.status = kind, status


class Http:
    def __init__(
        self,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        cache: Optional[Cache] = None,
        github_token: str = "",
        timeout: float = 15.0,
        retries: int = 2,
        backoff: float = 0.4,
    ):
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "DriftLock/0.2 (dependency drift scanner)"},
        )
        self._cache, self._token = cache, github_token
        self._retries, self._backoff = retries, backoff
        self.rate_limit_remaining: Optional[int] = None
        # Set when a failed request was answered from an expired cache entry.
        self.used_stale_cache = False
        self.calls: Dict[str, int] = {}
        self.failures: Dict[str, int] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _send(
        self, method: str, url: str, headers: Dict[str, str], body: Any, max_bytes: int, ignore_404_failure: bool = False
    ) -> bytes:
        host = urlparse(url).netloc
        self.calls[host] = self.calls.get(host, 0) + 1
        if self._token and host == "api.github.com":
            headers = {**headers, "Authorization": f"Bearer {self._token}"}
        last: FetchError = FetchError("network")
        for attempt in range(self._retries + 1):
            try:
                async with self._client.stream(method, url, headers=headers, json=body) as response:
                    if host == "api.github.com":
                        remaining = response.headers.get("x-ratelimit-remaining")
                        if remaining is not None and remaining.isdigit():
                            self.rate_limit_remaining = int(remaining)
                    status = response.status_code
                    if status in (403, 429) and (
                        response.headers.get("x-ratelimit-remaining") == "0" or status == 429
                    ):
                        raise FetchError("rate_limit", status, "GitHub API rate limit reached")
                    if status in (404, 410):
                        raise FetchError("not_found", status)
                    if status >= 500:
                        last = FetchError("http", status)
                    elif status >= 400:
                        raise FetchError("http", status)
                    else:
                        chunks, size = [], 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > max_bytes:
                                raise FetchError("too_large", status, f"Response exceeds {max_bytes} bytes")
                            chunks.append(chunk)
                        return b"".join(chunks)
            except FetchError as error:
                if error.kind != "http" or (error.status or 0) < 500:
                    if not (error.kind == "not_found" and (ignore_404_failure or _is_expected_probe_404(url))):
                        self.failures[host] = self.failures.get(host, 0) + 1
                    raise
                last = error
            except httpx.TimeoutException:
                last = FetchError("timeout")
            except httpx.HTTPError:
                last = FetchError("network")
            if attempt < self._retries:
                await asyncio.sleep(self._backoff * (2**attempt))
        if not (last.kind == "not_found" and (ignore_404_failure or _is_expected_probe_404(url))):
            self.failures[host] = self.failures.get(host, 0) + 1
        raise last

    async def _cached(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Any,
        max_bytes: int,
        ttl: Optional[int],
        ignore_404_failure: bool = False,
    ) -> str:
        key = None
        if self._cache and ttl:
            digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16] if body else ""
            key = f"{method} {url} {digest}"
            hit = self._cache.get(key)
            if hit is not None:
                return hit
        try:
            text = (await self._send(method, url, headers, body, max_bytes, ignore_404_failure=ignore_404_failure)).decode(
                "utf-8", errors="replace"
            )
        except FetchError as error:
            # A permanent "not found" is an answer; anything else may be served stale.
            stale = self._cache.get(key, allow_stale=True) if (key and self._cache and error.kind != "not_found") else None
            if stale is None:
                raise
            self.used_stale_cache = True
            return stale
        if key and self._cache and ttl:
            self._cache.set(key, text, ttl)
        return text

    async def get_text(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        max_bytes: int = 2_000_000,
        ttl: Optional[int] = None,
        ignore_404_failure: bool = False,
    ) -> str:
        return await self._cached("GET", url, headers or {}, None, max_bytes, ttl, ignore_404_failure=ignore_404_failure)

    async def get_json(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        max_bytes: int = 20_000_000,
        ttl: Optional[int] = None,
        ignore_404_failure: bool = False,
    ) -> Any:
        return self._json(await self._cached("GET", url, headers or {}, None, max_bytes, ttl, ignore_404_failure=ignore_404_failure))

    async def post_json(
        self,
        url: str,
        body: Any,
        *,
        headers: Optional[Dict[str, str]] = None,
        max_bytes: int = 5_000_000,
        ttl: Optional[int] = None,
        ignore_404_failure: bool = False,
    ) -> Any:
        return self._json(await self._cached("POST", url, headers or {}, body, max_bytes, ttl, ignore_404_failure=ignore_404_failure))

    async def get_bytes(self, url: str, *, max_bytes: int, ignore_404_failure: bool = False) -> bytes:
        return await self._send("GET", url, {}, None, max_bytes, ignore_404_failure=ignore_404_failure)

    @staticmethod
    def _json(text: str) -> Any:
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise FetchError("invalid", message="Response was not valid JSON") from exc
