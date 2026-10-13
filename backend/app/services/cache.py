"""SQLite cache for PUBLIC upstream responses (GitHub, registries, OSV).
Pasted manifest content never reaches this module: only the HTTP layer writes
here, and pasted targets make no HTTP requests for their own content."""
import sqlite3
import threading
import time
from typing import Optional


class Cache:
    def __init__(self, path: str = ":memory:"):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires REAL NOT NULL)")
        self._db.commit()
        self.path = path

    def get(self, key: str, allow_stale: bool = False) -> Optional[str]:
        with self._lock:
            row = self._db.execute("SELECT value, expires FROM cache WHERE key = ?", (key,)).fetchone()
        if row is None or (not allow_stale and row[1] < time.time()):
            return None
        return row[0]

    def set(self, key: str, value: str, ttl: int) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)", (key, value, time.time() + ttl))
            self._db.commit()
