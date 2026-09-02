import json
import sqlite3
import threading
import time

from .config import DB_PATH

HISTORY_LIMIT = 200

_write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,              -- file | item | collection | account
    target      TEXT NOT NULL,              -- identifier, collection id or @screenname
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

CREATE TABLE IF NOT EXISTS history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    kind    TEXT NOT NULL,               -- search | collection | item | account
    key     TEXT NOT NULL,               -- dedupe key within a kind
    label   TEXT NOT NULL,               -- text shown in the UI
    data    TEXT NOT NULL DEFAULT '{}',  -- json: how to replay the entry
    created REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_key ON history(kind, key);
"""


_journal_mode: str | None = None


def _pick_journal_mode(conn: sqlite3.Connection) -> str:
    """WAL gives the best read/write concurrency, but it needs shared-memory
    mmap which several filesystems this app runs on can't provide — Unraid
    /mnt/user FUSE shares and Docker bind mounts both raise
    'disk I/O error' on `PRAGMA journal_mode=WAL`. Fall back to a rollback
    journal there; writes are already serialized by `_write_lock`."""
    for mode in ("WAL", "TRUNCATE", "DELETE"):
        try:
            got = conn.execute(f"PRAGMA journal_mode={mode}").fetchone()[0]
        except sqlite3.OperationalError:
            continue
        if str(got).lower() == mode.lower():
            return mode
    return "delete"


def connect() -> sqlite3.Connection:
    global _journal_mode
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    if _journal_mode is None:
        _journal_mode = _pick_journal_mode(conn)
    else:
        try:
            conn.execute(f"PRAGMA journal_mode={_journal_mode}")
        except sqlite3.OperationalError:
            pass
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


# ------------------------------------------------------------------- history
def add_history(kind: str, key: str, label: str, data: dict | None = None) -> None:
    now = time.time()
    with write() as conn:
        conn.execute(
            "INSERT INTO history(kind, key, label, data, created) VALUES(?,?,?,?,?) "
            "ON CONFLICT(kind, key) DO UPDATE SET "
            "label=excluded.label, data=excluded.data, created=excluded.created",
            (kind, key, label, json.dumps(data or {}), now),
        )
        conn.execute(
            "DELETE FROM history WHERE id NOT IN "
            "(SELECT id FROM history ORDER BY created DESC LIMIT ?)",
            (HISTORY_LIMIT,),
        )


def list_history(limit: int = 50) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT kind, key, label, data, created FROM history "
            "ORDER BY created DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        try:
            data = json.loads(r["data"] or "{}")
        except ValueError:
            data = {}
        out.append({"kind": r["kind"], "key": r["key"], "label": r["label"],
                    "data": data, "created": r["created"]})
    return out


def history_count() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM history").fetchone()[0]


def clear_history() -> None:
    with write() as conn:
        conn.execute("DELETE FROM history")
