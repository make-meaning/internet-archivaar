import sqlite3
import threading
import time

from .config import DB_PATH

_write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,              -- file | item | collection
    target      TEXT NOT NULL,              -- identifier or collection id
    title       TEXT,
    options     TEXT NOT NULL DEFAULT '{}', -- json
    status      TEXT NOT NULL,              -- resolving|queued|running|paused|completed|error|cancelled
    error       TEXT,
    created     REAL NOT NULL,
    updated     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    identifier  TEXT NOT NULL,
    file_name   TEXT NOT NULL,
    format      TEXT,
    dest        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    bytes_done  INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,              -- queued|running|done|error|skipped|cancelled|paused
    error       TEXT,
    updated     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
    # Recover from an unclean shutdown: anything mid-flight goes back to the queue.
    with write() as conn:
        conn.execute(
            "UPDATE tasks SET status='queued', updated=? WHERE status='running'",
            (time.time(),),
        )
        conn.execute(
            "UPDATE jobs SET status='queued', updated=? WHERE status IN ('running','resolving')",
            (time.time(),),
        )


class _WriteCtx:
    def __enter__(self):
        _write_lock.acquire()
        self.conn = connect()
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            self.conn.close()
            _write_lock.release()
        return False


def write() -> _WriteCtx:
    """Serialized write transaction: `with db.write() as conn: ...`"""
    return _WriteCtx()


def get_setting(key: str, default=None):
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value) -> None:
    with write() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
