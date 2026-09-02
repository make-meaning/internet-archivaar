"""Thin client for the archive.org public APIs."""
from __future__ import annotations

import os
from typing import Iterator
from urllib.parse import quote

import httpx

from .config import USER_AGENT
from . import db

BASE = "https://archive.org"
TIMEOUT = httpx.Timeout(30.0, read=120.0, connect=30.0)

# archive.org derivative / original "format" labels that denote a moving image.
VIDEO_FORMATS = {
    "h.264", "h.264 hd", "h.264 ia", "hd h.264", "mpeg4", "512kb mpeg4",
    "hd mpeg4", "hi-res mpeg4", "mpeg2", "mpeg1", "ogg video", "theora video",
    "webm", "vp8 video", "matroska", "quicktime", "512kb quicktime",
    "64kb quicktime", "windows media", "asf", "cinepack", "divx", "3gp",
    "flash video", "avi", "mp4", "hidef mp4", "mpeg-4",
}
VIDEO_EXTS = {
    ".mp4", ".m4v", ".mkv", ".avi", ".ogv", ".ogg", ".mov", ".webm", ".mpg",
    ".mpeg", ".mp2", ".m2v", ".mj2", ".flv", ".wmv", ".asf", ".ts", ".3gp",
    ".divx", ".rm", ".vob",
}
SUBTITLE_EXTS = {".srt", ".vtt", ".sub", ".ass", ".ssa", ".scc"}
SUBTITLE_FORMATS = {"subrip", "webvtt", "closed caption text", "scc", "srt"}
THUMB_FORMATS = {
    "thumbnail", "jpeg thumb", "item tile", "png", "jpeg", "animated gif",
    "collection header", "item image",
}

SEARCH_FIELDS = [
    "identifier", "title", "mediatype", "downloads", "year", "publicdate",
    "item_size", "creator", "description",
]


def _cookies() -> dict:
    raw = db.get_setting("archive_cookies", "") or ""
    jar = {}
    for part in raw.replace("\n", ";").split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            jar[k.strip()] = v.strip()
    return jar


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        headers={"User-Agent": USER_AGENT},
        cookies=_cookies(),
        timeout=TIMEOUT,
        follow_redirects=True,
    )


def download_url(identifier: str, name: str) -> str:
    parts = "/".join(quote(p) for p in name.split("/"))
    return f"{BASE}/download/{quote(identifier)}/{parts}"


def thumb_url(identifier: str) -> str:
    return f"{BASE}/services/img/{quote(identifier)}"


def search(query: str, mediatype: str | None = "movies", rows: int = 48,
           page: int = 1, sort: str = "downloads desc") -> dict:
    q = (query or "").strip()
    if mediatype:
        q = f"({q}) AND mediatype:{mediatype}" if q else f"mediatype:{mediatype}"
    if not q:
        q = "*:*"
    params: list[tuple[str, str]] = [("q", q), ("output", "json"),
                                     ("rows", str(rows)), ("page", str(page))]
    for f in SEARCH_FIELDS:
        params.append(("fl[]", f))
    if sort:
        params.append(("sort[]", sort))
    with _client() as c:
        r = c.get("/advancedsearch.php", params=params)
        r.raise_for_status()
        data = r.json()
    resp = data.get("response", {})
    return {
        "total": resp.get("numFound", 0),
        "page": page,
        "rows": rows,
        "docs": resp.get("docs", []),
    }


def iter_identifiers(query: str, mediatype: str = "movies",
                     limit: int = 0) -> Iterator[str]:
    """Page through a search, yielding identifiers (used for collections)."""
    page = 1
    seen = 0
    while True:
        res = search(query, mediatype=mediatype, rows=100, page=page,
                     sort="publicdate asc")
        docs = res["docs"]
        if not docs:
            return
        for d in docs:
            ident = d.get("identifier")
            if not ident:
                continue
            yield ident
            seen += 1
            if limit and seen >= limit:
                return
        if seen >= res["total"]:
            return
        page += 1


def metadata(identifier: str) -> dict:
    with _client() as c:
        r = c.get(f"/metadata/{quote(identifier)}")
        r.raise_for_status()
        return r.json()


def classify_file(fl: dict) -> str:
    name = fl.get("name", "")
    fmt = (fl.get("format") or "").lower()
    ext = os.path.splitext(name)[1].lower()
    if fmt in VIDEO_FORMATS or ext in VIDEO_EXTS:
        return "video"
    if fmt in SUBTITLE_FORMATS or ext in SUBTITLE_EXTS:
        return "subtitle"
    if fmt in THUMB_FORMATS:
        return "thumbnail"
    return "other"


def select_files(files: list[dict], options: dict) -> list[dict]:
    """Filter an item's file list according to download options."""
    want = {f.lower() for f in (options.get("formats") or [])}
    source = options.get("source", "any")        # any | original | derivative
    include_subs = options.get("subtitles", True)
    include_thumbs = options.get("thumbnails", False)
    best_only = options.get("mode", "all") == "best"

    videos: list[dict] = []
    extras: list[dict] = []
    for fl in files:
        kind = classify_file(fl)
        src = (fl.get("source") or "").lower()
        if kind == "subtitle":
            if include_subs:
                extras.append(fl)
            continue
        if kind == "thumbnail":
            if include_thumbs:
                extras.append(fl)
            continue
        if kind != "video":
            continue
        if source == "original" and src != "original":
            continue
        if source == "derivative" and src not in ("derivative", ""):
            continue
        if want and (fl.get("format") or "").lower() not in want:
            continue
        videos.append(fl)

    if best_only and videos:
        videos = [max(videos, key=lambda f: int(f.get("size") or 0))]

    return videos + extras


def item_formats(files: list[dict]) -> list[dict]:
    """Distinct video formats present in an item, with counts and total size."""
    agg: dict[str, dict] = {}
    for fl in files:
        if classify_file(fl) != "video":
            continue
        fmt = fl.get("format") or "Unknown"
        a = agg.setdefault(fmt, {"format": fmt, "count": 0, "size": 0,
                                 "source": fl.get("source", "")})
        a["count"] += 1
        a["size"] += int(fl.get("size") or 0)
    return sorted(agg.values(), key=lambda x: -x["size"])
