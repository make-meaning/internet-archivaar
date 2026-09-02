import os
from pathlib import Path

DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/downloads"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
DB_PATH = Path(os.environ.get("IA_DB", str(CONFIG_DIR / "app.sqlite3")))
PORT = int(os.environ.get("PORT", "8000"))

# Defaults; the live value is stored in the settings table and editable in the UI.
DEFAULT_CONCURRENCY = int(os.environ.get("CONCURRENCY", "3"))
DEFAULT_MAX_COLLECTION_ITEMS = int(os.environ.get("MAX_COLLECTION_ITEMS", "0"))  # 0 = unlimited

USER_AGENT = "unraid-internet-archive/1.0 (+https://github.com/)"
