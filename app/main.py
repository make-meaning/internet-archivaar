from __future__ import annotations

import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import archive, db
from .config import DOWNLOAD_DIR, DEFAULT_CONCURRENCY
from .downloader import manager

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    manager.start()
    yield
    manager.shutdown()


app = FastAPI(title="Internet Archive Video Downloader", lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json")


# --------------------------------------------------------------------- search
@app.get("/api/search")
def api_search(q: str = "", type: str = Query("collection", pattern="^(collection|video)$"),
               page: int = 1, sort: str = "downloads desc"):
    mediatype = "collection" if type == "collection" else "movies"
    try:
        res = archive.search(q, mediatype=mediatype, page=max(1, page), sort=sort)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"archive.org error: {exc}") from exc
    return res


_IA_URL = re.compile(
    r"archive\.org/(?:details|download|metadata|embed|search)/([^/?#\s]+)", re.I)


def extract_identifier(text: str) -> str | None:
    text = (text or "").strip()
    m = _IA_URL.search(text)
    if m:
        return unquote(m.group(1))
    # a bare identifier: no scheme, no spaces, no slashes
    if text and not text.startswith("http") and "/" not in text and " " not in text:
        return text
    return None


@app.get("/api/resolve")
def api_resolve(input: str):
    """Turn a pasted archive.org URL (or bare identifier) into a routing target."""
    ident = extract_identifier(input)
    if not ident:
        raise HTTPException(400, "No archive.org identifier or URL found in that input.")
    try:
        meta = archive.metadata(ident)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"archive.org error: {exc}") from exc
    md = meta.get("metadata") or {}
    if not md:
        raise HTTPException(404, f"Nothing found for '{ident}'.")
    mt = md.get("mediatype")
    n_video = sum(1 for f in meta.get("files", [])
                  if archive.classify_file(f) == "video")
    return {
        "identifier": ident,
        "title": md.get("title") or ident,
        "mediatype": mt,
        "kind": "collection" if mt == "collection" else "item",
        "video_files": n_video,
    }


@app.get("/api/collection/{cid}")
def api_collection(cid: str, page: int = 1, sort: str = "downloads desc"):
    try:
        res = archive.search(f"collection:{cid}", mediatype="movies",
                             page=max(1, page), sort=sort)
        meta = archive.search(f"identifier:{cid}", mediatype=None, rows=1)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"archive.org error: {exc}") from exc
    res["collection"] = (meta["docs"][0] if meta["docs"] else {"identifier": cid})
    return res


@app.get("/api/item/{identifier}")
def api_item(identifier: str):
    try:
        meta = archive.metadata(identifier)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"archive.org error: {exc}") from exc
    if not meta or "files" not in meta:
        raise HTTPException(404, "item not found")
    md = meta.get("metadata", {})
    files = meta.get("files", [])
    enriched = []
    for fl in files:
        kind = archive.classify_file(fl)
        if kind in ("video", "subtitle"):
            enriched.append({
                "name": fl.get("name"), "format": fl.get("format"),
                "size": int(fl.get("size") or 0), "source": fl.get("source"),
                "original": fl.get("original"),
                "length": fl.get("length"), "height": fl.get("height"),
                "width": fl.get("width"), "kind": kind,
                "url": archive.download_url(identifier, fl.get("name", "")),
            })
    return {
        "identifier": identifier,
        "title": md.get("title") or identifier,
        "description": md.get("description"),
        "creator": md.get("creator"),
        "year": md.get("year") or md.get("date"),
        "collections": md.get("collection") if isinstance(md.get("collection"), list)
        else [md["collection"]] if md.get("collection") else [],
        "mediatype": md.get("mediatype"),
        "formats": archive.item_formats(files),
        "files": enriched,
        "thumb": archive.thumb_url(identifier),
    }


@app.get("/api/thumb/{identifier}")
def api_thumb(identifier: str):
    return RedirectResponse(archive.thumb_url(identifier))


# ---------------------------------------------------------------------- jobs
class JobRequest(BaseModel):
    kind: str                       # file | item | collection
    target: str                     # identifier or collection id
    title: str | None = None
    options: dict = {}


@app.post("/api/jobs")
def api_create_job(req: JobRequest):
    try:
        job_id = manager.create_job(req.kind, req.target, req.options or {}, req.title)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"id": job_id}


@app.get("/api/jobs")
def api_jobs():
    return {"jobs": manager.list_jobs(), "concurrency": manager.concurrency}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: int):
    detail = manager.job_detail(job_id)
    if not detail:
        raise HTTPException(404, "job not found")
    return detail


@app.post("/api/jobs/{job_id}/{action}")
def api_job_action(job_id: int, action: str):
    fn = {"pause": manager.pause, "resume": manager.resume,
          "cancel": manager.cancel, "retry": manager.retry}.get(action)
    if not fn:
        raise HTTPException(400, "unknown action")
    fn(job_id)
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def api_job_delete(job_id: int, delete_files: bool = False):
    manager.delete_job(job_id, delete_files=delete_files)
    return {"ok": True}


# ------------------------------------------------------------------ settings
class Settings(BaseModel):
    concurrency: int | None = None
    archive_cookies: str | None = None


@app.get("/api/settings")
def api_get_settings():
    usage = shutil.disk_usage(DOWNLOAD_DIR)
    return {
        "concurrency": manager.concurrency,
        "default_concurrency": DEFAULT_CONCURRENCY,
        "archive_cookies_set": bool(db.get_setting("archive_cookies", "")),
        "download_dir": str(DOWNLOAD_DIR),
        "disk_total": usage.total,
        "disk_free": usage.free,
        "disk_used": usage.used,
    }


@app.post("/api/settings")
def api_set_settings(s: Settings):
    if s.concurrency is not None:
        db.set_setting("concurrency", max(1, min(10, s.concurrency)))
        manager.ensure_workers()
    if s.archive_cookies is not None:
        db.set_setting("archive_cookies", s.archive_cookies.strip())
    return api_get_settings()


# ------------------------------------------------------------------- static
app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
