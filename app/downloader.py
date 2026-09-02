"""Background download manager: job/task queue, worker pool, resume support."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
from pathlib import Path

import httpx

from . import archive, db
from .config import (DEFAULT_CONCURRENCY, DEFAULT_MAX_COLLECTION_ITEMS,
                     DOWNLOAD_DIR, USER_AGENT)

CHUNK = 1024 * 256
PROGRESS_FLUSH_SECS = 1.0
_INVALID = re.compile(r'[<>:"\\|?*\x00-\x1f]')


def _sanitize(part: str) -> str:
    part = _INVALID.sub("_", part or "").strip().strip(".")
    return part[:180] or "_"


def _sanitize_rel(name: str) -> str:
    segs = [s for s in name.replace("\\", "/").split("/") if s not in ("", ".", "..")]
    return "/".join(_sanitize(s) for s in segs) or "file"


class Manager:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._workers: list[threading.Thread] = []
        self._resolvers: dict[int, threading.Thread] = {}
        self._live: dict[int, int] = {}          # task_id -> bytes_done (in-flight)
        self._job_status_cache: dict[int, str] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ config
    @property
    def concurrency(self) -> int:
        try:
            return max(1, min(10, int(db.get_setting("concurrency", DEFAULT_CONCURRENCY))))
        except (TypeError, ValueError):
            return DEFAULT_CONCURRENCY

    # ------------------------------------------------------------------ start
    def start(self) -> None:
        db.set_setting("concurrency", self.concurrency)
        for i in range(self.concurrency):
            self._spawn_worker(i)
        # resume any jobs that still have work
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT id, kind, target, options FROM jobs "
                "WHERE status IN ('queued','running','resolving')"
            ).fetchall()
        for row in rows:
            if row["kind"] in ("collection", "account"):
                # re-resolve to pick up where it left off (tasks are deduped)
                self._start_resolver(row["id"], row["kind"], row["target"],
                                     json.loads(row["options"]))
        self._wake.set()

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()

    def _spawn_worker(self, idx: int) -> None:
        t = threading.Thread(target=self._worker_loop, name=f"dl-worker-{idx}",
                             daemon=True)
        t.start()
        self._workers.append(t)

    def ensure_workers(self) -> None:
        """Called after the concurrency setting changes."""
        while len(self._workers) < self.concurrency:
            self._spawn_worker(len(self._workers))
        self._wake.set()

    # ------------------------------------------------------------------ jobs
    def create_job(self, kind: str, target: str, options: dict,
                   title: str | None = None) -> int:
        if kind not in ("file", "item", "collection", "account"):
            raise ValueError("bad kind")
        now = time.time()
        with db.write() as conn:
            cur = conn.execute(
                "INSERT INTO jobs(kind, target, title, options, status, created, updated) "
                "VALUES(?,?,?,?,?,?,?)",
                (kind, target, title or target, json.dumps(options),
                 "resolving", now, now),
            )
            job_id = cur.lastrowid
        self._start_resolver(job_id, kind, target, options)
        return job_id

    def _start_resolver(self, job_id: int, kind: str, target: str,
                        options: dict) -> None:
        t = threading.Thread(
            target=self._resolve, args=(job_id, kind, target, options),
            name=f"resolve-{job_id}", daemon=True,
        )
        self._resolvers[job_id] = t
        t.start()

    def _resolve(self, job_id: int, kind: str, target: str, options: dict) -> None:
        try:
            if kind == "file":
                self._resolve_file(job_id, target, options)
            elif kind == "item":
                self._resolve_item(job_id, target, options, collection=None)
            elif kind == "collection":
                self._resolve_collection(job_id, target, options)
            elif kind == "account":
                self._resolve_account(job_id, target, options)
            self._set_job_status(job_id, "queued", clear_error=True)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._set_job_status(job_id, "error", error=str(exc))
        finally:
            self._resolvers.pop(job_id, None)
            self._wake.set()
            self._recompute_job(job_id)

    # ---- resolvers -----------------------------------------------------
    def _resolve_file(self, job_id: int, identifier: str, options: dict) -> None:
        names = options.get("files") or []
        meta = archive.metadata(identifier)
        by_name = {f.get("name"): f for f in meta.get("files", [])}
        title = meta.get("metadata", {}).get("title") or identifier
        self._maybe_set_title(job_id, identifier, title)
        for name in names:
            fl = by_name.get(name, {"name": name, "format": "", "size": 0})
            self._add_task(job_id, identifier, fl, options, collection=None)

    def _resolve_item(self, job_id: int, identifier: str, options: dict,
                      collection: str | None) -> None:
        meta = archive.metadata(identifier)
        md = meta.get("metadata", {})
        title = md.get("title") or identifier
        if collection is None:
            self._maybe_set_title(job_id, identifier, title)
        chosen = archive.select_files(meta.get("files", []), options)
        if not chosen:
            raise RuntimeError("no matching files for the selected options")
        for fl in chosen:
            self._add_task(job_id, identifier, fl, options, collection=collection)

    def _resolve_collection(self, job_id: int, coll: str, options: dict) -> None:
        limit = int(options.get("max_items", DEFAULT_MAX_COLLECTION_ITEMS) or 0)
        query = f"collection:{coll}"
        count = 0
        for ident in archive.iter_identifiers(query, mediatype="movies", limit=limit):
            if self._job_status(job_id) in ("cancelled", "paused"):
                return
            try:
                self._resolve_item(job_id, ident, options, collection=coll)
            except Exception as exc:  # noqa: BLE001 -- skip broken items, keep going
                print(f"[resolve] {ident}: {exc}")
            count += 1
            self._set_job_title(job_id, f"{coll}  ({count} items)")
            self._wake.set()
            time.sleep(0.2)
        if count == 0:
            raise RuntimeError("collection has no video items")

    def _resolve_account(self, job_id: int, handle: str, options: dict) -> None:
        limit = int(options.get("max_items", DEFAULT_MAX_COLLECTION_ITEMS) or 0)
        handle = archive.normalize_handle(handle)
        folder = f"@{handle}"
        count = 0
        for ident in archive.iter_account_uploads(handle, limit=limit):
            if self._job_status(job_id) in ("cancelled", "paused"):
                return
            try:
                self._resolve_item(job_id, ident, options, collection=folder)
            except Exception as exc:  # noqa: BLE001 -- skip broken items, keep going
                print(f"[resolve] {ident}: {exc}")
            count += 1
            self._set_job_title(job_id, f"@{handle} uploads  ({count} items)")
            self._wake.set()
            time.sleep(0.2)
        if count == 0:
            raise RuntimeError("this account has no video uploads")

    def _add_task(self, job_id: int, identifier: str, fl: dict, options: dict,
                  collection: str | None) -> None:
        name = fl.get("name") or ""
        dest = self._dest_path(options, identifier, name, collection)
        size = int(fl.get("size") or 0)
        now = time.time()
        with db.write() as conn:
            exists = conn.execute(
                "SELECT id FROM tasks WHERE job_id=? AND identifier=? AND file_name=?",
                (job_id, identifier, name),
            ).fetchone()
            if exists:
                return
            status = "queued"
            if dest.exists() and size and dest.stat().st_size == size:
                status = "skipped"
            conn.execute(
                "INSERT INTO tasks(job_id, identifier, file_name, format, dest, "
                "size, bytes_done, status, updated) VALUES(?,?,?,?,?,?,?,?,?)",
                (job_id, identifier, name, fl.get("format") or "", str(dest),
                 size, size if status == "skipped" else 0, status, now),
            )

    def _dest_path(self, options: dict, identifier: str, name: str,
                   collection: str | None) -> Path:
        sub = options.get("subfolder")
        if sub:
            base = DOWNLOAD_DIR / _sanitize(sub)
        elif collection:
            base = DOWNLOAD_DIR / _sanitize(collection) / _sanitize(identifier)
        else:
            base = DOWNLOAD_DIR / _sanitize(identifier)
        return base / _sanitize_rel(name)

    # ---- worker loop -------------------------------------------------------
    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            task = self._claim_task()
            if task is None:
                self._wake.wait(2.0)
                self._wake.clear()
                continue
            try:
                self._run_task(task)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._finish_task(task["id"], "error", error=str(exc))
            finally:
                self._recompute_job(task["job_id"])

    def _claim_task(self):
        with db.write() as conn:
            row = conn.execute(
                "SELECT t.* FROM tasks t JOIN jobs j ON j.id = t.job_id "
                "WHERE t.status='queued' AND j.status IN "
                "('queued','running','resolving') "
                "ORDER BY t.id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            conn.execute("UPDATE tasks SET status='running', updated=? WHERE id=?",
                         (time.time(), row["id"]))
            conn.execute(
                "UPDATE jobs SET status='running', updated=? "
                "WHERE id=? AND status='queued'",
                (time.time(), row["job_id"]),
            )
        return row

    def _run_task(self, task) -> None:
        job_id = task["job_id"]
        dest = Path(task["dest"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")

        if dest.exists() and task["size"] and dest.stat().st_size == task["size"]:
            self._finish_task(task["id"], "done", bytes_done=task["size"])
            return

        resume = part.stat().st_size if part.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if resume:
            headers["Range"] = f"bytes={resume}-"

        url = archive.download_url(task["identifier"], task["file_name"])
        last_flush = 0.0
        with httpx.Client(follow_redirects=True, timeout=archive.TIMEOUT,
                          cookies=archive._cookies()) as client:
            with client.stream("GET", url, headers=headers) as r:
                if r.status_code == 416:  # range not satisfiable -> already done
                    if part.exists():
                        part.replace(dest)
                    self._finish_task(task["id"], "done",
                                      bytes_done=dest.stat().st_size)
                    return
                r.raise_for_status()
                append = r.status_code == 206 and resume > 0
                if not append:
                    resume = 0
                clen = int(r.headers.get("Content-Length") or 0)
                total = (resume + clen) or task["size"]
                if total and total != task["size"]:
                    self._set_task_size(task["id"], total)
                done = resume
                mode = "ab" if append else "wb"
                with open(part, mode) as fh:
                    for chunk in r.iter_bytes(CHUNK):
                        st = self._job_status(job_id)
                        if st == "paused":
                            fh.flush()
                            self._live.pop(task["id"], None)
                            self._finish_task(task["id"], "paused", bytes_done=done)
                            return
                        if st == "cancelled":
                            fh.flush()
                            self._live.pop(task["id"], None)
                            self._finish_task(task["id"], "cancelled", bytes_done=done)
                            return
                        fh.write(chunk)
                        done += len(chunk)
                        self._live[task["id"]] = done
                        now = time.time()
                        if now - last_flush >= PROGRESS_FLUSH_SECS:
                            self._set_task_progress(task["id"], done)
                            last_flush = now
        part.replace(dest)
        self._live.pop(task["id"], None)
        self._finish_task(task["id"], "done", bytes_done=dest.stat().st_size)

    # ---- job control -----------------------------------------------------
    def pause(self, job_id: int) -> None:
        self._transition(job_id, new_job="paused",
                         task_from=("queued", "running"), task_to="paused")

    def resume(self, job_id: int) -> None:
        self._transition(job_id, new_job="queued",
                         task_from=("paused",), task_to="queued")
        self._wake.set()
        self._recompute_job(job_id)

    def cancel(self, job_id: int) -> None:
        self._transition(job_id, new_job="cancelled",
                         task_from=("queued", "running", "paused"),
                         task_to="cancelled")
        self._recompute_job(job_id)

    def retry(self, job_id: int) -> None:
        self._transition(job_id, new_job="queued",
                         task_from=("error", "cancelled", "paused"),
                         task_to="queued")
        self._wake.set()
        self._recompute_job(job_id)

    def _transition(self, job_id: int, new_job: str, task_from, task_to) -> None:
        now = time.time()
        placeholders = ",".join("?" * len(task_from))
        with db.write() as conn:
            conn.execute("UPDATE jobs SET status=?, updated=? WHERE id=?",
                         (new_job, now, job_id))
            conn.execute(
                f"UPDATE tasks SET status=?, updated=? "
                f"WHERE job_id=? AND status IN ({placeholders})",
                (task_to, now, job_id, *task_from),
            )
        with self._lock:
            self._job_status_cache[job_id] = new_job

    def delete_job(self, job_id: int, delete_files: bool = False) -> None:
        self.cancel(job_id)
        if delete_files:
            with db.connect() as conn:
                rows = conn.execute(
                    "SELECT dest FROM tasks WHERE job_id=?", (job_id,)
                ).fetchall()
            for row in rows:
                for p in (Path(row["dest"]), Path(row["dest"] + ".part")):
                    try:
                        if p.exists():
                            p.unlink()
                    except OSError:
                        pass
        with db.write() as conn:
            conn.execute("DELETE FROM tasks WHERE job_id=?", (job_id,))
            conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))

    # ---- small db helpers ----------------------------------------------
    def _job_status(self, job_id: int) -> str:
        with self._lock:
            cached = self._job_status_cache.get(job_id)
        if cached is not None:
            return cached
        with db.connect() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE id=?",
                               (job_id,)).fetchone()
        status = row["status"] if row else "cancelled"
        with self._lock:
            self._job_status_cache[job_id] = status
        return status

    def _set_job_status(self, job_id: int, status: str, error: str | None = None,
                        clear_error: bool = False) -> None:
        with db.write() as conn:
            if error is not None:
                conn.execute("UPDATE jobs SET status=?, error=?, updated=? WHERE id=?",
                             (status, error, time.time(), job_id))
            elif clear_error:
                conn.execute("UPDATE jobs SET status=?, error=NULL, updated=? WHERE id=?",
                             (status, time.time(), job_id))
            else:
                conn.execute("UPDATE jobs SET status=?, updated=? WHERE id=?",
                             (status, time.time(), job_id))
        with self._lock:
            self._job_status_cache[job_id] = status

    def _maybe_set_title(self, job_id: int, target: str, title: str) -> None:
        """Set a title only if the caller didn't already provide a real one."""
        with db.connect() as conn:
            row = conn.execute("SELECT title FROM jobs WHERE id=?", (job_id,)).fetchone()
        current = (row["title"] if row else "") or ""
        if not current or current == target:
            self._set_job_title(job_id, title)

    def _set_job_title(self, job_id: int, title: str) -> None:
        with db.write() as conn:
            conn.execute("UPDATE jobs SET title=?, updated=? WHERE id=?",
                         (title, time.time(), job_id))

    def _set_task_progress(self, task_id: int, done: int) -> None:
        with db.write() as conn:
            conn.execute("UPDATE tasks SET bytes_done=?, updated=? WHERE id=?",
                         (done, time.time(), task_id))

    def _set_task_size(self, task_id: int, size: int) -> None:
        with db.write() as conn:
            conn.execute("UPDATE tasks SET size=?, updated=? WHERE id=?",
                         (size, time.time(), task_id))

    def _finish_task(self, task_id: int, status: str, bytes_done: int | None = None,
                     error: str | None = None) -> None:
        self._live.pop(task_id, None)
        with db.write() as conn:
            if bytes_done is not None:
                conn.execute(
                    "UPDATE tasks SET status=?, bytes_done=?, error=?, updated=? WHERE id=?",
                    (status, bytes_done, error, time.time(), task_id))
            else:
                conn.execute(
                    "UPDATE tasks SET status=?, error=?, updated=? WHERE id=?",
                    (status, error, time.time(), task_id))

    def _recompute_job(self, job_id: int) -> None:
        with db.connect() as conn:
            job = conn.execute("SELECT status FROM jobs WHERE id=?",
                               (job_id,)).fetchone()
            if job is None:
                return
            counts = dict(conn.execute(
                "SELECT status, COUNT(*) c FROM tasks WHERE job_id=? GROUP BY status",
                (job_id,)).fetchall())
        if job["status"] in ("cancelled", "resolving"):
            return
        active = counts.get("queued", 0) + counts.get("running", 0)
        paused = counts.get("paused", 0)
        if active:
            return  # workers still have things to do
        if paused:
            new = "paused"
        elif counts.get("error", 0):
            new = "error"
        else:
            new = "completed"
        if new != job["status"]:
            self._set_job_status(job_id, new)

    # ---- read models for the API -------------------------------------
    def list_jobs(self) -> list[dict]:
        with db.connect() as conn:
            jobs = conn.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
            agg = {
                r["job_id"]: r for r in conn.execute(
                    "SELECT job_id, COUNT(*) files, "
                    "SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) done, "
                    "SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errored, "
                    "SUM(size) size, SUM(bytes_done) bytes_done "
                    "FROM tasks GROUP BY job_id"
                ).fetchall()
            }
        out = []
        for j in jobs:
            a = agg.get(j["id"])
            bytes_done = (a["bytes_done"] if a else 0) or 0
            row = {
                "id": j["id"], "kind": j["kind"], "target": j["target"],
                "title": j["title"], "status": j["status"], "error": j["error"],
                "created": j["created"], "updated": j["updated"],
                "options": json.loads(j["options"]),
                "files": (a["files"] if a else 0) or 0,
                "files_done": (a["done"] if a else 0) or 0,
                "files_errored": (a["errored"] if a else 0) or 0,
                "bytes_total": (a["size"] if a else 0) or 0,
                "bytes_done": bytes_done,
            }
            out.append(row)
        # fold in live byte counts for a smoother bar
        self._apply_live(out)
        return out

    def _apply_live(self, jobs: list[dict]) -> None:
        if not self._live:
            return
        with db.connect() as conn:
            rows = conn.execute(
                "SELECT id, job_id, bytes_done FROM tasks WHERE id IN (%s)" %
                ",".join("?" * len(self._live)), tuple(self._live)
            ).fetchall()
        delta: dict[int, int] = {}
        for r in rows:
            live = self._live.get(r["id"])
            if live and live > r["bytes_done"]:
                delta[r["job_id"]] = delta.get(r["job_id"], 0) + (live - r["bytes_done"])
        for j in jobs:
            if j["id"] in delta:
                j["bytes_done"] += delta[j["id"]]

    def job_detail(self, job_id: int) -> dict | None:
        with db.connect() as conn:
            j = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not j:
                return None
            tasks = conn.execute(
                "SELECT * FROM tasks WHERE job_id=? ORDER BY identifier, file_name",
                (job_id,)).fetchall()
        tlist = []
        for t in tasks:
            d = dict(t)
            live = self._live.get(t["id"])
            if live and live > d["bytes_done"]:
                d["bytes_done"] = live
            tlist.append(d)
        detail = dict(j)
        detail["options"] = json.loads(j["options"])
        detail["tasks"] = tlist
        return detail


manager = Manager()
