FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DOWNLOAD_DIR=/downloads \
    CONFIG_DIR=/config \
    IA_DB=/config/app.sqlite3 \
    PORT=8000 \
    PUID=99 \
    PGID=100 \
    UMASK=022

RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tini passwd ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 100 abc 2>/dev/null || true \
 && useradd -u 99 -g 100 -d /config -s /bin/sh -M abc 2>/dev/null || true

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/config", "/downloads"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,os,sys; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/settings'); " || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
