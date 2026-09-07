"""Stremio Movy addon — FastAPI + Granian + httpx[http2], direct streams only."""
import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from . import config
from .movy import parse_stremio_id, resolve_movy_streams

log = logging.getLogger("addon")
logging.basicConfig(level=logging.INFO)
# httpx logs every upstream GET at INFO (including 500/429) — noisy
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

MANIFEST = {
    "id": "community.movy",
    "version": "1.1.0",
    "name": "Movy Stream",
    "description": "Provides direct streams from Movy.bz for movies and TV shows (FastAPI + Granian + HTTP/2)",
    "catalogs": [],
    "resources": ["stream"],
    "types": ["movie", "series"],
    "idPrefixes": ["tt", "imdb:", "tmdb:"],
    "behaviorHints": {"configurable": False},
}

_client: httpx.AsyncClient | None = None
_client_loop: object | None = None


def _make_client() -> httpx.AsyncClient:
    limits = httpx.Limits(max_connections=64, max_keepalive_connections=32)
    return httpx.AsyncClient(
        http2=True,  # HTTP/2 where supported, HTTP/1.1 fallback otherwise
        limits=limits,
        timeout=httpx.Timeout(15.0, read=30.0),
        headers={"User-Agent": config.UA},
        follow_redirects=True,
    )


async def _ensure_client() -> httpx.AsyncClient:
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop or _client.is_closed:
        if _client is not None and not _client.is_closed:
            try:
                await _client.aclose()
            except Exception:
                pass
        _client = _make_client()
        _client_loop = loop
    return _client


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    _client = _make_client()
    log.info("httpx client ready (http2=True)")
    yield
    if _client is not None:
        await _client.aclose()
        _client = None


app = FastAPI(title="Movy Stream", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
)


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@app.get("/manifest.json")
async def manifest():
    return JSONResponse(MANIFEST)


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/stream/{type_}/{video_id:path}")
async def stream(type_: str, video_id: str, request: Request):
    if video_id.endswith(".json"):
        video_id = video_id[: -len(".json")]
    if type_ not in ("movie", "series"):
        return JSONResponse({"streams": []})
    clean_id, season, episode = parse_stremio_id(type_, video_id)
    log.info("stream request: type=%s id=%s -> %s s=%s e=%s", type_, video_id, clean_id, season, episode)
    client = await _ensure_client()
    streams = await resolve_movy_streams(client, type_, clean_id, season, episode)
    log.info("returning %d direct stream(s)", len(streams))
    return JSONResponse({"streams": streams})


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    base = _base_url(request)
    host = request.headers.get("host", f"127.0.0.1:{config.PORT}")
    install = f"stremio://{host}/manifest.json"
    return HTMLResponse(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Movy Stream - Stremio Addon</title>
<style>*{{margin:0;padding:0;box-sizing:border-box}}body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center}}.container{{max-width:600px;padding:40px;text-align:center}}h1{{font-size:2.5rem;margin-bottom:10px;color:#7b2ff7}}.subtitle{{color:#aaa;margin-bottom:30px;font-size:1.1rem}}.card{{background:#16213e;border-radius:12px;padding:30px;margin-bottom:20px}}.install-btn{{display:inline-block;background:#7b2ff7;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:1.1rem;font-weight:600}}code{{background:#0f3460;padding:2px 8px;border-radius:4px}}</style>
</head><body><div class="container">
<h1>&#9654; Movy Stream</h1>
<p class="subtitle">FastAPI + Granian + HTTP/2 &middot; direct streams</p>
<div class="card"><a href="{install}" class="install-btn">Install in Stremio</a>
<p style="color:#888;margin-top:15px">Direct upstream URLs with Referer via proxyHeaders &mdash; no server bandwidth.</p></div>
<div class="card"><h3>Manual install</h3><p><code>{base}/manifest.json</code></p></div>
</div></body></html>""")


if __name__ == "__main__":
    from granian import Granian

    host = config.HOST
    port = config.PORT
    log.info("serving with Granian on http://%s:%s", host, port)
    Granian("app.main:app", interface="asgi", address=host, port=port).serve()
