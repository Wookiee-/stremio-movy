# Movy Stream - Stremio Addon

A local server that provides Stremio with direct streams from [Movy.bz](https://www.movy.bz).

## Features

- 🎬 Movie streaming (by IMDB or TMDB ID)
- 📺 TV series streaming (by IMDB or TMDB ID, with season/episode)
- 🎞️ 8 server backends for reliability
- 🔄 Auto IMDB-to-TMDB ID conversion
- 🔗 Direct streams — video flows straight from host to player, no proxying
- 🖥️ Local server with landing page
- ⚡ Performance optimizations (HTTP/2, connection pooling, smart caching)

## Quick Start (FastAPI + Granian, recommended)

```bash
# Install dependencies
pip install -r requirements.txt

# Start the addon server (Granian, port 7000)
python -m app.main
# or: granian --interface asgi app.main:app --address 127.0.0.1 --port 7000
```

The server will start at `http://127.0.0.1:7000`.

- Upstream calls (TMDB, OMDb, Movy API) use `httpx` with `http2=True`
  (HTTP/2 where supported, HTTP/1.1 fallback).
- Streams are **direct**: the addon returns upstream URLs with
  `behaviorHints.proxyHeaders` (Referer + User-Agent), so video flows
  straight from the host to the player — noone proxies video, no server bandwidth.
- Run tests with `python -m pytest tests/ -q`.

## Quick Start (Node legacy)

`addon.js` is the original Node implementation (proxied streams). It is kept
for reference / Vercel serverless (`api/index.js`). For local use, prefer the
Python server above.

## Install in Stremio

### Option 1: Click Install (from landing page)

Open `http://127.0.0.1:7000` in your browser and click "Install in Stremio".

### Option 2: Manual Install

1. Open Stremio
2. Go to **Add-ons → Community**
3. In the search box, paste: `http://127.0.0.1:7000/manifest.json`
4. Click **Install**

### Option 3: Direct URL

Open this URL in your browser (Stremio must be running):

```
stremio://127.0.0.1:7000/manifest.json
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `7000` | Server port |
| `TMDB_API_KEY` / `OMDB_API_KEY` | free keys | Override the built-in free-key rotation |
| `MOVY_API` / `MOVY_BASE` | wecollege / movy.bz | Override upstream endpoints |

## How It Works

1. Stremio requests a stream for a movie/show
2. If an IMDB ID is provided, converts it to TMDB ID via the TMDB API
3. Fetches a time-limited seed from the Movy API
4. Queries multiple server backends (miami, seattle, denver, atlanta, phoenix, portland, cancun, paris)
5. Decrypts encrypted responses using a custom cipher seeded from the API
6. Returns direct stream URLs to Stremio for playback

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with install instructions |
| `GET /manifest.json` | Stremio addon manifest |
| `GET /stream/:type/:id.json` | Direct Movy streams for the requested title |

## Performance

- **Direct streams** — video flows straight from the host to the player; the server only resolves metadata
- **HTTP keep-alive pooling** — reuses TLS connections across TMDB, Movy API requests (HTTP/2 where supported)
- **Smart TMDB lookups** — skips the `/find` call when a TMDB ID is already provided
- **Stream caching** — results cached for 5 minutes with request deduplication

## License

MIT
