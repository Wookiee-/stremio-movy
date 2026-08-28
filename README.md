# Movy Stream - Stremio Addon

A local proxy server that provides Stremio streams from [Movy.bz](https://www.movy.bz).

## Features

- 🎬 Movie streaming (by IMDB or TMDB ID)
- 📺 TV series streaming (by IMDB or TMDB ID, with season/episode)
- 🎞️ 8 server backends for reliability
- 🔄 Auto IMDB-to-TMDB ID conversion
- 🌐 Proxied streaming for reliable playback
- 🖥️ Local server with landing page

## Quick Start

```bash
# Install dependencies
npm install

# Start the addon server
npm start
```

The server will start at `http://127.0.0.1:7000`.

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

## How It Works

1. Stremio requests a stream for a movie/show
2. If an IMDB ID is provided, converts it to TMDB ID via the TMDB API
3. Fetches a time-limited seed from the Movy API
4. Queries multiple server backends (miami, seattle, denver, atlanta, phoenix, portland, cancun, paris)
5. Decrypts encrypted responses using a custom cipher seeded from the API
6. Returns proxied stream URLs to Stremio for playback

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with install instructions |
| `GET /manifest.json` | Stremio addon manifest |
| `GET /proxy?url=<url>&referer=<referer>` | Proxies Movy video streams through the local server |

## License

MIT
