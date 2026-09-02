# Internet Archive Video Downloader

A self-hosted web GUI for browsing video collections on [archive.org](https://archive.org)
and downloading individual videos or entire collections — with format selection, a job
queue, resumable downloads, and pause / resume / retry. Packaged as a Docker container
with an Unraid Community Applications template.

![tab: Browse / Queue / Settings]

## Features

- **Browse** – search archive.org for *collections* or *individual videos*, page through
  results, open a collection to see its items, open an item to see every file.
- **Paste a link** – drop an `archive.org/details/…` URL (or bare identifier) into the
  search box and it jumps straight to that collection or item. Example:
  `https://archive.org/details/WildlifeDocumentaries/` — an item bundling ~1,165 videos.
- **Download** – a single file, everything in one format, a whole item, or an entire
  collection.
- **By format** – the item view lists every video format present
  (`h.264 — 341 files, 84.7 GB`, `Cinepack — 340 files, 165 GB`, …) each with a one-click
  *Download all* button.
- **Sortable file list** – click the File / Format / Source / Size headers to sort;
  the list scrolls inside its card instead of overflowing.
- **Format options** – per download you choose:
  - which video formats to keep (populated from the item's actual files), or leave blank
    for *all*
  - *All matching files* vs *best video only* (largest per item)
  - originals only / derivatives only / any
  - also grab subtitles / captions and/or thumbnails
  - optional output subfolder override; collections can cap the number of items
- **Queue** – multiple concurrent jobs, live progress bars, per-file status,
  pause / resume / cancel / retry, and remove.
- **Resumable** – interrupted files continue via HTTP range requests; the queue survives
  container restarts.
- **Members-only items** – paste your archive.org session cookies in Settings.

Files are saved as:

```
/downloads/<collection>/<identifier>/<file>          # collection jobs
/downloads/<identifier>/<file>                       # single item / file jobs
```

## Run with Docker

```bash
docker run -d --name ia-video-downloader \
  -p 8000:8000 \
  -e PUID=1000 -e PGID=1000 \
  -v /path/to/appdata:/config \
  -v /path/to/media/archive.org:/downloads \
  ghcr.io/OWNER/ia-video-downloader:latest
```

Open <http://localhost:8000>.

### docker compose

```bash
docker compose up -d --build
```

## Unraid

1. Build/push the image (or use the published one) and edit `unraid/ia-video-downloader.xml`,
   replacing `OWNER` with your GitHub user / registry.
2. In Unraid: **Docker → Add Container → Template**, point it at the XML (or drop it in
   `/boot/config/plugins/dockerMan/templates-user/`).
3. Set the **Downloads** path to a share (e.g. `/mnt/user/media/archive.org`) and
   **Config** to `/mnt/user/appdata/ia-video-downloader`.
4. Apply, then open the WebUI.

## Configuration

| Env var                 | Default            | Meaning                                        |
|-------------------------|--------------------|------------------------------------------------|
| `PORT`                  | `8000`             | HTTP port inside the container                 |
| `PUID` / `PGID`         | `99` / `100`       | ownership of created files                     |
| `UMASK`                 | `022`              | umask for created files                        |
| `CONCURRENCY`           | `3`                | simultaneous file downloads (editable in UI)   |
| `MAX_COLLECTION_ITEMS`  | `0`                | default per-collection item cap (0 = all)      |
| `DOWNLOAD_DIR`          | `/downloads`       | output root                                    |
| `CONFIG_DIR`            | `/config`          | database + settings                            |

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
DOWNLOAD_DIR=./data/downloads CONFIG_DIR=./data/config \
  python -m uvicorn app.main:app --reload --port 8000
```

API docs at `/api/docs`.

### Layout

```
app/
  main.py        FastAPI routes + static hosting
  archive.py     archive.org search / metadata client, file classification
  downloader.py  job + task queue, worker pool, resumable downloads (SQLite-backed)
  db.py          SQLite schema and helpers
  static/        vanilla-JS single-page UI
```

## Notes

- Respect archive.org's bandwidth — keep concurrency modest and don't hammer huge
  collections. This tool only downloads content the site already serves publicly.
- No affiliation with the Internet Archive.
