"""Thin client for the archive.org public APIs."""
from __future__ import annotations

import json
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


# ------------------------------------------------------------------ accounts
# archive.org user profiles live at /details/@<screenname>. The public account
# page is driven by this "page_production" search service — the same endpoint
# the site itself calls — which returns a user's uploads, collections,
# favorites and reviews in one shot, with per-section totals and paging.
ACCOUNT_API = "/services/search/beta/page_production/"
ACCOUNT_SECTIONS = ("uploads", "collections", "favorites", "reviews")


def normalize_handle(handle: str) -> str:
    return (handle or "").strip().lstrip("@").strip()


def _account_page(handle: str, sections: tuple[str, ...], page: int = 1,
                  rows: int = 100, sort: str = "publicdate:desc") -> dict:
    handle = normalize_handle(handle)
    if not handle:
        raise ValueError("empty account handle")
    params: list[tuple[str, str]] = [
        ("page_type", "account_details"),
        ("page_target", f"@{handle}"),
        ("page_elements", json.dumps(list(sections))),
        ("hits_per_page", str(rows)),
        ("page", str(page)),
        ("aggregations", "false"),
    ]
    if sort:
        params.append(("sort", sort))
    last_exc: Exception | None = None
    for _ in range(2):                       # the service is occasionally flaky
        with _client() as c:
            r = c.get(ACCOUNT_API, params=params)
            r.raise_for_status()
            data = r.json()
        resp = data.get("response") or {}
        if (resp.get("header") or {}).get("succeeded") and resp.get("body"):
            return resp
        last_exc = httpx.HTTPError(
            f"archive.org account lookup failed for @{handle}")
    raise last_exc  # type: ignore[misc]


def _hit_to_doc(hit: dict) -> dict:
    f = hit.get("fields", {}) or {}
    pub = f.get("publicdate") or f.get("addeddate") or ""
    return {
        "identifier": f.get("identifier"),
        "title": f.get("title") or f.get("identifier"),
        "mediatype": f.get("mediatype"),
        "downloads": f.get("downloads") or 0,
        "year": f.get("year") or (str(pub)[:4] if pub else ""),
        "publicdate": pub,
        "item_size": f.get("item_size") or f.get("collection_size") or 0,
        "files_count": f.get("files_count") or f.get("item_count") or 0,
    }


def _section_hits(resp: dict, section: str) -> dict:
    pe = ((resp.get("body") or {}).get("page_elements") or {})
    sect = pe.get(section) or {}
    hits = sect.get("hits") if isinstance(sect, dict) else None
    return hits if isinstance(hits, dict) else {}


def account_profile(handle: str) -> dict:
    """Screenname, blurb and per-section counts for a user profile."""
    handle = normalize_handle(handle)
    resp = _account_page(handle, ACCOUNT_SECTIONS, page=1, rows=1)
    extra = ((resp.get("body") or {}).get("account_extra_info") or {})
    ad = extra.get("account_details", {}) or {}
    uim = extra.get("user_item_metadata", {}) or {}
    counts = {s: (_section_hits(resp, s).get("total") or 0)
              for s in ACCOUNT_SECTIONS}
    return {
        "identifier": f"@{handle}",
        "handle": handle,
        "screenname": ad.get("screenname") or handle,
        "title": uim.get("title") or ad.get("screenname") or handle,
        "description": uim.get("description"),
        "member_since": ad.get("user_since"),
        "counts": counts,
    }


def account_section(handle: str, section: str, page: int = 1, rows: int = 48,
                    sort: str = "publicdate:desc") -> dict:
    if section not in ACCOUNT_SECTIONS:
        raise ValueError(f"unknown account section: {section}")
    resp = _account_page(handle, (section,), page=page, rows=rows, sort=sort)
    hits = _section_hits(resp, section)
    return {
        "total": hits.get("total") or 0,
        "page": page,
        "rows": rows,
        "docs": [_hit_to_doc(h) for h in hits.get("hits", [])],
    }


def iter_account_uploads(handle: str, limit: int = 0,
                         mediatype: str = "movies") -> Iterator[str]:
    """Page through a user's uploads, yielding item identifiers."""
    handle = normalize_handle(handle)
    page, seen = 1, 0
    while True:
        resp = _account_page(handle, ("uploads",), page=page, rows=100,
                             sort="publicdate:asc")
        hits = _section_hits(resp, "uploads")
        rows = hits.get("hits", [])
        if not rows:
            return
        for h in rows:
            f = h.get("fields", {}) or {}
            ident = f.get("identifier")
            if not ident:
                continue
            if mediatype and f.get("mediatype") != mediatype:
                continue
            yield ident
            seen += 1
            if limit and seen >= limit:
                return
        if page * 100 >= (hits.get("total") or 0):
            return
        page += 1


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
