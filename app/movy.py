"""Movy.bz stream resolution with direct-stream output (ported from addon.js)."""
import asyncio
import json
import logging
import random
import re
import time
from urllib.parse import quote, urlencode

import httpx

from . import config
from .crypto import movy_decrypt

log = logging.getLogger("movy")

# Hardcoded free keys (ported from node `freekeys`, which just picks at random).
_TMDB_KEYS = [
    "fb7bb23f03b6994dafc674c074d01761",
    "e55425032d3d0f371fc776f302e7c09b",
    "8301a21598f8b45668d5711a814f01f6",
    "8cf43ad9c085135b9479ad5cf6bbcbda",
    "da63548086e399ffc910fbc08526df05",
    "13e53ff644a8bd4ba37b3e1044ad24f3",
    "269890f657dddf4635473cf4cf456576",
    "a2f888b27315e62e471b2d587048f32e",
    "8476a7ab80ad76f0936744df0430e67c",
    "5622cafbfe8f8cfe358a29c53e19bba0",
    "ae4bd1b6fce2a5648671bfc171d15ba4",
    "257654f35e3dff105574f97fb4b97035",
    "2f4038e83265214a0dcd6ec2eb3276f5",
    "9e43f45f94705cc8e1d5a0400d19a7b7",
    "af6887753365e14160254ac7f4345dd2",
    "06f10fc8741a672af455421c239a1ffc",
    "fb7bb23f03b6994dafc674c074d01761",
    "09ad8ace66eec34302943272db0e8d2c",
]
_OMDB_KEYS = [
    "4b447405", "eb0c0475", "7776cbde", "ff28f90b",
    "6c3a2d45", "b07b58c8", "ad04b643", "a95b5205",
    "777d9323", "2c2c3314", "b5cff164", "89a9f57d",
    "73a9858a", "efbd8357",
]

# 429s are expected when Movy/TMDB rate-limit free keys
# and 8 servers are queried in parallel. Don't spam stdout
# — back off silently and let the cache handle it.
def _retry_after_seconds(resp: httpx.Response, default: float = 1.5) -> float:
    raw = resp.headers.get("retry-after") or resp.headers.get("Retry-After")
    if raw:
        try:
            return max(0.5, min(float(raw), 10))
        except ValueError:
            pass
    return default


_stream_cache: dict[str, tuple[float, list]] = {}
_pending: dict[str, asyncio.Task] = {}
_meta_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = asyncio.Lock()


def get_keys() -> tuple[str | None, str | None]:
    tmdb = config.TMDB_API_KEY or random.choice(_TMDB_KEYS)
    omdb = config.OMDB_API_KEY or random.choice(_OMDB_KEYS)
    return tmdb, omdb


def extract_imdb_id(stremio_id: str) -> str | None:
    if stremio_id.startswith("tt"):
        return stremio_id
    if stremio_id.startswith("imdb:"):
        return stremio_id[5:]
    return None


def extract_tmdb_id(stremio_id: str) -> str | None:
    if stremio_id.startswith("tmdb:"):
        return stremio_id[5:]
    return None


def parse_stremio_id(type_: str, id_: str) -> tuple[str, int, int]:
    """Return (clean_id, season, episode) — same rules as addon.js."""
    season, episode = 1, 1
    clean_id = id_
    parts = id_.split(":")
    if len(parts) >= 3:
        if parts[0] == "tmdb":
            clean_id = f"tmdb:{parts[1]}"
            try:
                season = int(parts[2]) or 1
            except ValueError:
                season = 1
            try:
                episode = int(parts[3]) if len(parts) > 3 else 1
                episode = episode or 1
            except ValueError:
                episode = 1
        else:
            clean_id = parts[0]
            try:
                season = int(parts[1]) or 1
            except ValueError:
                season = 1
            try:
                episode = int(parts[2]) or 1
            except ValueError:
                episode = 1
    elif len(parts) == 2:
        clean_id = parts[0]
        try:
            season = int(parts[1]) or 1
        except ValueError:
            season = 1
        episode = 1
    return clean_id, season, episode


async def lookup_tmdb_metadata(
    client: httpx.AsyncClient, imdb_id: str | None, tmdb_id: str | None, media_type: str
) -> dict:
    cache_key = f"{imdb_id or ''}:{tmdb_id or ''}:{media_type}"
    async with _cache_lock:
        hit = _meta_cache.get(cache_key)
        if hit and time.time() - hit[0] < config.METADATA_TTL:
            return hit[1]

    tmdb_key, omdb_key = get_keys()
    if not tmdb_key:
        return {}
    result: dict = {}

    async def _get_with_backoff(url: str, params: dict) -> httpx.Response | None:
        for attempt in range(3):
            resp = await client.get(url, params=params, timeout=10)
            if resp.status_code == 429:
                if attempt < 2:
                    await asyncio.sleep(_retry_after_seconds(resp, 1.0 + attempt))
                    continue
            return resp
        return None

    try:
        if imdb_id and imdb_id.startswith("tt") and not tmdb_id:
            r = await _get_with_backoff(
                f"https://api.themoviedb.org/3/find/{imdb_id}",
                {"external_source": "imdb_id", "api_key": tmdb_key},
            )
            if r is None or r.status_code != 200:
                data = {}
            else:
                data = r.json()
            item = (data.get("tv_results") or [None])[0] or (data.get("movie_results") or [None])[0]
            if item:
                result["tmdbId"] = item.get("id")
                result["title"] = item.get("name") or item.get("title") or ""
                date = item.get("first_air_date") or item.get("release_date") or ""
                result["year"] = date[:4]
                result["imdbId"] = imdb_id
        elif imdb_id:
            result["imdbId"] = imdb_id

        if media_type == "tv" and not result.get("tmdbId") and imdb_id and imdb_id.startswith("tt") and omdb_key:
            try:
                r = await client.get(
                    "https://www.omdbapi.com/",
                    params={"i": imdb_id, "apikey": omdb_key},
                    timeout=10,
                )
                omdb = r.json()
                if omdb.get("Response") == "True" and omdb.get("Type") == "episode" and omdb.get("seriesID"):
                    series_imdb = omdb["seriesID"]
                    sr = await _get_with_backoff(
                        f"https://api.themoviedb.org/3/find/{series_imdb}",
                        {"external_source": "imdb_id", "api_key": tmdb_key},
                    )
                    series = ((sr.json().get("tv_results") or [None])[0]) if sr and sr.status_code == 200 else None
                    if series:
                        result["tmdbId"] = series.get("id")
                        result["title"] = result.get("title") or series.get("name") or ""
                        fad = series.get("first_air_date") or ""
                        result["year"] = result.get("year") or fad[:4]
                        result["imdbId"] = series_imdb
                        try:
                            if omdb.get("Season"):
                                result["season"] = int(omdb["Season"])
                        except ValueError:
                            pass
                        try:
                            if omdb.get("Episode"):
                                result["episode"] = int(omdb["Episode"])
                        except ValueError:
                            pass
            except Exception as e:
                log.warning("episode resolution failed: %s", e)

        resolved = result.get("tmdbId") or tmdb_id
        if resolved and media_type == "tv":
            r = await _get_with_backoff(
                f"https://api.themoviedb.org/3/tv/{resolved}",
                {"api_key": tmdb_key},
            )
            data = r.json() if r and r.status_code == 200 else {}
            if data.get("name"):
                result.setdefault("title", data["name"])
            if data.get("first_air_date"):
                result.setdefault("year", data["first_air_date"][:4])
            result["totalSeasons"] = data.get("number_of_seasons") or 1
        elif resolved and media_type == "movie":
            r = await _get_with_backoff(
                f"https://api.themoviedb.org/3/movie/{resolved}",
                {"api_key": tmdb_key},
            )
            data = r.json() if r and r.status_code == 200 else {}
            if data.get("title"):
                result.setdefault("title", data["title"])
            if data.get("release_date"):
                result.setdefault("year", data["release_date"][:4])

        if resolved:
            result["tmdbId"] = resolved
        async with _cache_lock:
            _meta_cache[cache_key] = (time.time(), result)
        log.info("tmdb metadata: %s (%s) tmdb:%s", result.get("title"), result.get("year"), result.get("tmdbId"))
        return result
    except Exception as e:
        log.warning("tmdb lookup failed: %s", e)
        return result


def _quality_rank(q: str | None) -> int:
    if not q:
        return 0
    q = q.lower()
    if "2160" in q or "4k" in q:
        return 4000
    if "1080" in q:
        return 3000
    if "720" in q:
        return 2000
    if "480" in q:
        return 1000
    if "360" in q:
        return 500
    try:
        return int(re.search(r"\d+", q).group())  # type: ignore
    except Exception:
        return 0


def _build_stream(server: str, quality: str | None, src_url: str, base_url: str | None = None) -> dict:
    label = f"{server}" + (f" ({quality})" if quality else "")
    # proxied HLS/MP4 via FastAPI /proxy (readahead) — same as Node addon.js
    if base_url:
        proxied = f"{base_url.rstrip('/')}/proxy?url={quote(src_url, safe='')}&referer={quote(config.MOVY_BASE, safe='')}"
        url = proxied
        behavior = {"bingeGroup": f"movy-{quality or 'auto'}"}
    else:
        url = src_url
        behavior = {
            "bingeGroup": f"movy-{quality or server}",
            "proxyHeaders": {"request": {"Referer": config.MOVY_BASE + "/", "User-Agent": config.UA}},
        }
    return {
        "name": f"Movy {label}",
        "title": label,
        "url": url,
        "behaviorHints": behavior,
    }


async def _fetch_server(
    client: httpx.AsyncClient, server: str, query: str, tmdb_id: str, seed: str
) -> list[dict]:
    # 429 is silent — just back off, don't spam logs.
    for attempt in range(3):
        try:
            r = await client.get(
                f"{config.MOVY_API}/{server}/sources?{query}",
                headers={"User-Agent": config.UA},
                timeout=15,
            )
            if r.status_code == 429:
                if attempt < 2:
                    await asyncio.sleep(_retry_after_seconds(r, 1.0 + attempt))
                    continue
                return []
            if r.status_code != 200:
                return []
            encrypted = r.text
            if not encrypted or len(encrypted) < 10:
                return []
            plaintext = movy_decrypt(encrypted, seed, int(tmdb_id))
            data = json.loads(plaintext)
            sources = data.get("sources") or []
            if sources:
                log.debug("%s: %d source(s)", server, len(sources))
            return sources
        except Exception as e:
            if attempt < 1:
                await asyncio.sleep(0.3)
                continue
            log.debug("%s: %s", server, e)
            return []
    return []


async def resolve_movy_streams(
    client: httpx.AsyncClient,
    type_: str,
    stremio_id: str,
    season: int = 1,
    episode: int = 1,
    base_url: str | None = None,
) -> list[dict]:
    media_type = "movie" if type_ == "movie" else "tv"
    tmdb_id = extract_tmdb_id(stremio_id)
    imdb_id = extract_imdb_id(stremio_id)

    meta = await lookup_tmdb_metadata(client, imdb_id, tmdb_id, media_type)
    if meta.get("tmdbId"):
        tmdb_id = str(meta["tmdbId"])
    if meta.get("season") is not None:
        season = meta["season"]
    if meta.get("episode") is not None:
        episode = meta["episode"]

    if not tmdb_id:
        log.info("skipping: no TMDB id")
        return []

    cache_key = f"movy:{type_}:{tmdb_id}:{season}:{episode}:{base_url or 'direct'}"
    async with _cache_lock:
        hit = _stream_cache.get(cache_key)
        if hit and time.time() - hit[0] < config.CACHE_TTL:
            log.info("cached: %s", cache_key)
            return hit[1]
        task = _pending.get(cache_key)

    if task is not None:
        log.info("waiting for in-flight: %s", cache_key)
        return await task

    async def _run() -> list[dict]:
        try:
            # Seed fetch with silent 429 backoff
            seed = None
            for attempt in range(3):
                r = await client.get(
                    f"{config.MOVY_API}/seed",
                    params={"mediaId": tmdb_id},
                    headers={"User-Agent": config.UA},
                    timeout=15,
                )
                if r.status_code == 429:
                    if attempt < 2:
                        await asyncio.sleep(_retry_after_seconds(r, 1.5 + attempt))
                        continue
                    return []
                r.raise_for_status()
                seed = r.json()["seed"]
                break
            if seed is None:
                return []

            # NOTE: keep the original double-encoding of title
            # (encodeURIComponent + URLSearchParams) so Movy parses it identically.
            params = {
                "title": quote(meta.get("title") or ""),
                "mediaType": media_type,
                "tmdbId": str(tmdb_id),
                "seasonId": str(season or 1),
                "episodeId": str(episode or 1),
                "enc": "2",
                "seed": seed,
            }
            if meta.get("year"):
                params["year"] = str(meta["year"])
            if meta.get("totalSeasons"):
                params["totalSeasons"] = str(meta["totalSeasons"])
            if meta.get("imdbId"):
                params["imdbId"] = str(meta["imdbId"])
            query = urlencode(params)

            # stagger 8 servers slightly to avoid thundering-herd 429s (like Node)
            # launch with 50ms jitter between servers
            async def _gather_staggered():
                tasks = []
                for i, s in enumerate(config.MOVY_SERVERS):
                    if i:
                        await asyncio.sleep(0.05)
                    tasks.append(asyncio.create_task(_fetch_server(client, s, query, str(tmdb_id), seed)))
                return await asyncio.gather(*tasks)

            results = await _gather_staggered()
            streams: list[dict] = []
            seen: set[str] = set()
            tmp: list[tuple[int, dict]] = []
            for server, sources in zip(config.MOVY_SERVERS, results):
                for src in sources:
                    url = src.get("url", "")
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    quality = src.get("quality")
                    tmp.append((_quality_rank(quality), _build_stream(server, quality, url, base_url)))
            # highest quality first — player picks first entry
            tmp.sort(key=lambda x: x[0], reverse=True)
            streams = [s for _, s in tmp]
            async with _cache_lock:
                _stream_cache[cache_key] = (time.time(), streams)
            return streams
        except Exception as e:
            # Don't spam stdout on rate-limits — degrade silently
            if "429" in str(e):
                log.debug("movy 429 suppressed: %s", e)
            else:
                log.warning("movy error: %s", e)
            return []
        finally:
            async with _cache_lock:
                _pending.pop(cache_key, None)

    task = asyncio.create_task(_run())
    async with _cache_lock:
        _pending[cache_key] = task
    return await task
