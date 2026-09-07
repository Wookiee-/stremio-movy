"""HLS / MP4 proxy with readahead — ported from addon.js (Node) to FastAPI+httpx.

Implements:
- block cache (1 MB blocks, 160 MB total) with parallel prefetch to hide upstream throttle (~320 KB/s per connection)
- HLS playlist rewriting (m3u8 -> proxy URLs) + segment prefetch
- Range handling (closed ranges via block cache, open-ended via pump)
- 429 backoff + coalesced fetches
"""
import asyncio
import re
import time
import logging
from urllib.parse import quote, unquote, urljoin, urlparse

import httpx
from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from . import config

log = logging.getLogger("proxy")

UA = config.UA
MOVY_BASE = config.MOVY_BASE

BLOCK_SIZE = 1 * 1024 * 1024
READAHEAD_BLOCKS = 2
READAHEAD_MAX_BYTES = 160 * 1024 * 1024
MAX_RANGE_RESPONSE = 16 * 1024 * 1024
HLS_PREFETCH = 2
PUMP_FAST_START = 512 * 1024

# caches
media_cache: dict[str, dict] = {}  # key -> {"buf": bytes, "ts": float}
media_cache_bytes = 0
inflight_prefetch: set[str] = set()
inflight_fetches: dict[str, asyncio.Task] = {}
playlist_segments: dict[str, list[str]] = {}  # playlistUrl -> [segmentUrls]
segment_playlist: dict[str, str] = {}  # segmentUrl -> playlistUrl
total_sizes: dict[str, int] = {}  # mediaUrl -> total
content_types: dict[str, str] = {}  # mediaUrl -> content-type

_cache_lock = asyncio.Lock()


def cache_get(key: str) -> bytes | None:
    entry = media_cache.get(key)
    if not entry:
        return None
    entry["ts"] = time.time()
    return entry["buf"]


def cache_put(key: str, buf: bytes):
    global media_cache_bytes
    if key in media_cache:
        return
    media_cache[key] = {"buf": buf, "ts": time.time()}
    media_cache_bytes += len(buf)
    # evict oldest until under budget
    while media_cache_bytes > READAHEAD_MAX_BYTES and media_cache:
        oldest_key = min(media_cache, key=lambda k: media_cache[k]["ts"])
        oldest = media_cache.pop(oldest_key)
        media_cache_bytes -= len(oldest["buf"])


def _retry_after(resp: httpx.Response, default: float = 1.0) -> float:
    raw = resp.headers.get("retry-after") or resp.headers.get("Retry-After")
    if raw:
        try:
            return max(0.5, min(float(raw), 10))
        except ValueError:
            pass
    return default


async def fetch_range(client: httpx.AsyncClient, url: str, range_header: str | None, referer: str) -> httpx.Response:
    headers = {
        "User-Agent": UA,
        "Referer": referer if referer.endswith("/") else referer + "/",
    }
    if range_header:
        headers["Range"] = range_header
    for attempt in range(3):
        resp = await client.get(url, headers=headers, follow_redirects=True, timeout=httpx.Timeout(20.0))
        if resp.status_code == 429:
            if attempt < 2:
                ra = _retry_after(resp, 1.0)
                delay = min(max(ra, 1) * 1000, 5000) * (attempt + 1) / 1000
                await asyncio.sleep(delay)
                continue
            err = httpx.HTTPStatusError("Upstream 429", request=resp.request, response=resp)
            err.retry_after = resp.headers.get("retry-after") or "2"  # type: ignore
            raise err
        if resp.status_code not in (200, 206) and not resp.is_success:
            # treat 206/200 as ok, others as error
            if resp.status_code >= 400:
                raise httpx.HTTPStatusError(f"Upstream {resp.status_code}", request=resp.request, response=resp)
        return resp
    raise httpx.HTTPStatusError("Upstream 429", request=resp.request, response=resp)


async def _fetch_and_cache(key: str, url: str, range_header: str | None, referer: str, client: httpx.AsyncClient) -> bytes:
    resp = await fetch_range(client, url, range_header, referer)
    buf = resp.content
    ct = resp.headers.get("content-type")
    if ct and "html" not in ct.lower():
        content_types[url] = ct
    cr = resp.headers.get("content-range")
    if cr:
        try:
            total = int(cr.split("/")[-1])
            total_sizes[url] = total
        except Exception:
            pass
    if range_header and resp.status_code == 200 and not cr:
        cl = resp.headers.get("content-length")
        if cl:
            try:
                total_sizes[url] = int(cl)
            except Exception:
                pass
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            s = int(m.group(1))
            e = int(m.group(2)) if m.group(2) else len(buf) - 1
            buf = buf[s : min(e + 1, len(buf))]
    cache_put(key, buf)
    return buf


def fetch_buffer_coalesced(key: str, url: str, range_header: str | None, referer: str, client: httpx.AsyncClient) -> asyncio.Task:
    if key in inflight_fetches:
        return inflight_fetches[key]

    async def _run():
        try:
            return await _fetch_and_cache(key, url, range_header, referer, client)
        except Exception:
            raise
        finally:
            inflight_fetches.pop(key, None)

    task = asyncio.create_task(_run())
    inflight_fetches[key] = task
    return task


def segment_content_type(url: str) -> str | None:
    if re.search(r"\.ts(\?|$)", url, re.I):
        return "video/mp2t"
    if re.search(r"\.(m4s|mp4)(\?|$)", url, re.I):
        return "video/iso.segment"
    if re.search(r"\.aac(\?|$)", url, re.I):
        return "audio/aac"
    return None


def register_playlist(playlist_url: str, segment_urls: list[str]):
    playlist_segments[playlist_url] = segment_urls
    for seg in segment_urls:
        segment_playlist[seg] = playlist_url


def schedule_hls_prefetch(seg_url: str, referer: str, client: httpx.AsyncClient):
    lst = playlist_segments.get(segment_playlist.get(seg_url, ""))
    if not lst:
        return
    try:
        idx = lst.index(seg_url)
    except ValueError:
        return
    for n in range(1, HLS_PREFETCH + 1):
        if idx + n >= len(lst):
            break
        nxt = lst[idx + n]
        if cache_get(nxt) or nxt in inflight_prefetch:
            continue
        inflight_prefetch.add(nxt)
        task = fetch_buffer_coalesced(nxt, nxt, None, referer, client)
        task.add_done_callback(lambda t, k=nxt: inflight_prefetch.discard(k))


def schedule_initial_prefetch(playlist_url: str, referer: str, client: httpx.AsyncClient):
    lst = playlist_segments.get(playlist_url)
    if not lst:
        return
    first = lst[0]
    if not cache_get(first) and first not in inflight_prefetch:
        inflight_prefetch.add(first)
        task = fetch_buffer_coalesced(first, first, None, referer, client)
        task.add_done_callback(lambda t, k=first: inflight_prefetch.discard(k))


async def get_block(client: httpx.AsyncClient, url: str, block_index: int, referer: str) -> bytes:
    key = f"{url}#b{block_index}"
    hit = cache_get(key)
    if hit is not None:
        return hit
    start = block_index * BLOCK_SIZE
    last_err = None
    for _ in range(2):
        try:
            task = fetch_buffer_coalesced(key, url, f"bytes={start}-{start + BLOCK_SIZE - 1}", referer, client)
            buf = await task
            if start + len(buf) < (block_index + 1) * BLOCK_SIZE:
                total_sizes[url] = start + len(buf)
            return cache_get(key) or buf
        except Exception as e:
            last_err = e
            await asyncio.sleep(0.3)
    raise last_err or RuntimeError("block fetch failed")


def rewrite_playlist(body: str, playlist_url: str, base_url: str, referer: str) -> tuple[str, list[str]]:
    # base proxy prefix - will be replaced per-request with actual host, but for cache we store absolute segment URLs
    base_proxy = f"{base_url.rstrip('/')}/proxy?referer={quote(referer, safe='')}&url="
    segment_urls: list[str] = []
    lines = body.split("\n")
    out = []
    for line in lines:
        trimmed = line.strip()
        if not trimmed:
            out.append(line)
            continue
        if trimmed.startswith("#"):
            # Rewrite URI="..."
            def repl(m):
                uri = m.group(1)
                try:
                    abs_url = urljoin(playlist_url, uri)
                except Exception:
                    return m.group(0)
                return f'URI="{base_proxy}{quote(abs_url, safe="")}"'
            out.append(re.sub(r'URI="([^"]+)"', repl, line))
            continue
        try:
            abs_url = urljoin(playlist_url, trimmed)
            if not re.search(r"\.m3u8(\?|$)", abs_url, re.I):
                segment_urls.append(abs_url)
        except Exception:
            pass
        try:
            abs_url = urljoin(playlist_url, trimmed)
            out.append(f"{base_proxy}{quote(abs_url, safe='')}")
        except Exception:
            out.append(line)
    return "\n".join(out), segment_urls


def schedule_block_prefetch(url: str, from_block: int, count: int, referer: str, client: httpx.AsyncClient, total: int | None):
    for n in range(count):
        bi = from_block + n
        key = f"{url}#b{bi}"
        if total is not None and bi * BLOCK_SIZE >= total:
            break
        if cache_get(key) or key in inflight_prefetch:
            continue
        inflight_prefetch.add(key)

        async def _prefetch(bi=bi, key=key):
            try:
                await get_block(client, url, bi, referer)
            except Exception:
                pass
            finally:
                inflight_prefetch.discard(key)

        asyncio.create_task(_prefetch())


# ---- proxy handler ----
async def handle_proxy(request: Request, client: httpx.AsyncClient):
    target_url = request.query_params.get("url")
    referer = request.query_params.get("referer") or MOVY_BASE
    base_url = str(request.base_url).rstrip("/")

    if not target_url:
        return Response(content='{"error":"Missing url parameter"}', status_code=400, media_type="application/json")

    # CORS
    cors_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Content-Type",
    }

    if request.method == "OPTIONS":
        return Response(status_code=204, headers=cors_headers)

    is_known_segment = target_url in segment_playlist

    try:
        # 1) cached HLS segment
        if is_known_segment:
            cached = cache_get(target_url)
            if cached is not None:
                if cached[:7] == b"#EXTM3U":
                    # extensionless playlist mis-registered as segment
                    segment_playlist.pop(target_url, None)
                    text = cached.decode("utf-8", errors="ignore")
                    rewritten, segs = rewrite_playlist(text, target_url, base_url, referer)
                    register_playlist(target_url, segs)
                    schedule_initial_prefetch(target_url, referer, client)
                    headers = {"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache", **cors_headers}
                    return Response(content=rewritten, media_type="application/vnd.apple.mpegurl", headers=headers)
                # serve cached segment with optional range
                rng = request.headers.get("range")
                m = re.match(r"bytes=(\d+)-(\d*)", rng) if rng else None
                if m:
                    s = int(m.group(1))
                    e = int(m.group(2)) + 1 if m.group(2) else len(cached)
                    body = cached[s:e]
                    headers = {
                        "Content-Type": segment_content_type(target_url) or content_types.get(target_url) or "application/octet-stream",
                        "Content-Length": str(len(body)),
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes {s}-{s+len(body)-1}/{len(cached)}",
                        "Cache-Control": "no-cache",
                        **cors_headers,
                    }
                    # prefetch next
                    schedule_hls_prefetch(target_url, referer, client)
                    return Response(content=body, status_code=206, headers=headers)
                headers = {
                    "Content-Type": segment_content_type(target_url) or content_types.get(target_url) or "application/octet-stream",
                    "Content-Length": str(len(cached)),
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "no-cache",
                    **cors_headers,
                }
                schedule_hls_prefetch(target_url, referer, client)
                return Response(content=cached, headers=headers)

        # 2) MP4 etc via block cache (exclude playlists)
        looks_like_m3u8 = bool(re.search(r"\.m3u8(\?|$)", target_url, re.I))
        if not is_known_segment and not looks_like_m3u8 and request.method == "GET":
            rng = request.headers.get("range")
            closed = bool(rng and re.match(r"^\s*bytes=\d+-\d+\s*$", rng))
            if closed:
                return await serve_range_from_cache(request, target_url, referer, client, cors_headers)
            else:
                start = 0
                if rng:
                    m = re.match(r"bytes=(\d+)", rng)
                    if m:
                        start = int(m.group(1))
                return await pump_open_ended(request, target_url, start, referer, client, cors_headers)

        # 3) Generic proxy (playlists + uncached segments + non-range)
        headers = {
            "User-Agent": UA,
            "Referer": referer if referer.endswith("/") else referer + "/",
        }
        if request.headers.get("range"):
            headers["Range"] = request.headers["range"]

        # fetch upstream (follow redirects)
        resp = await fetch_range(client, target_url, request.headers.get("range"), referer) if request.headers.get("range") else await client.get(target_url, headers=headers, follow_redirects=True, timeout=httpx.Timeout(20.0))
        # detect content type after redirects
        ct = resp.headers.get("content-type") or ""
        final_url = str(resp.url) if hasattr(resp, "url") else target_url
        is_m3u8 = ".m3u8" in target_url or "mpegurl" in ct.lower()

        if is_m3u8:
            if resp.status_code >= 400:
                return Response(content=f"Upstream playlist error: {resp.status_code}", status_code=resp.status_code, media_type="text/plain", headers=cors_headers)
            body = resp.text
            rewritten, segs = rewrite_playlist(body, final_url, base_url, referer)
            register_playlist(final_url, segs)
            schedule_initial_prefetch(final_url, referer, client)
            headers_out = {"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache", **cors_headers}
            return Response(content=rewritten, media_type="application/vnd.apple.mpegurl", headers=headers_out)

        if is_known_segment:
            # uncached HLS segment
            key = target_url
            task = fetch_buffer_coalesced(key, target_url, None, referer, client)
            buf = await task
            if buf[:7] == b"#EXTM3U":
                segment_playlist.pop(target_url, None)
                text = buf.decode("utf-8", errors="ignore")
                rewritten, segs = rewrite_playlist(text, target_url, base_url, referer)
                register_playlist(target_url, segs)
                schedule_initial_prefetch(target_url, referer, client)
                return Response(content=rewritten, media_type="application/vnd.apple.mpegurl", headers={"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache", **cors_headers})
            headers_out = {
                "Content-Type": segment_content_type(target_url) or content_types.get(target_url) or "application/octet-stream",
                "Content-Length": str(len(buf)),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
                **cors_headers,
            }
            schedule_hls_prefetch(target_url, referer, client)
            return Response(content=buf, headers=headers_out)

        # passthrough for other content
        headers_out = {"Cache-Control": "no-cache", **cors_headers}
        # forward relevant upstream headers
        for k in ("content-type", "content-length", "content-range", "accept-ranges"):
            v = resp.headers.get(k)
            if v:
                headers_out[k.title()] = v
        # if body is small, just return it; else stream
        return Response(content=resp.content, status_code=resp.status_code, headers=headers_out)

    except httpx.HTTPStatusError as e:
        is429 = e.response.status_code == 429 if e.response is not None else "429" in str(e)
        if is429:
            ra = e.response.headers.get("retry-after") if e.response else "2"
            headers = {"Retry-After": ra or "2", **cors_headers}
            return Response(content='{"error":"Upstream rate limited","retryAfter":"%s"}' % (ra or "2"), status_code=429, media_type="application/json", headers=headers)
        log.error("proxy error: %s", e)
        return Response(content='{"error":"Proxy error","message":"%s"}' % str(e), status_code=502, media_type="application/json", headers=cors_headers)
    except Exception as e:
        if "429" in str(e):
            return Response(content='{"error":"Upstream rate limited","retryAfter":"2"}', status_code=429, media_type="application/json", headers=cors_headers)
        log.error("proxy error: %s", e)
        return Response(content='{"error":"Proxy error","message":"%s"}' % str(e), status_code=502, media_type="application/json", headers=cors_headers)


async def serve_range_from_cache(request: Request, target_url: str, referer: str, client: httpx.AsyncClient, cors_headers: dict):
    rng = request.headers.get("range") or ""
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    start = int(m.group(1)) if m and m.group(1) else 0
    end_raw = m.group(2) if m else ""
    total = total_sizes.get(target_url)
    if not end_raw:
        if total is None:
            try:
                probe = await fetch_range(client, target_url, f"bytes={start}-{start}", referer)
                cr = probe.headers.get("content-range")
                if cr and "/" in cr:
                    total = int(cr.split("/")[-1])
                    total_sizes[target_url] = total
            except Exception:
                pass
        if total is not None and start >= total:
            headers = {"Content-Range": f"bytes */{total}", **cors_headers}
            return Response(status_code=416, headers=headers)
        end = (total - 1 if total is not None else start + MAX_RANGE_RESPONSE - 1)
    else:
        end = int(end_raw)

    block_indexes = []
    for bi in range(start // BLOCK_SIZE, end // BLOCK_SIZE + 1):
        block_indexes.append(bi)
    blocks = await asyncio.gather(*(get_block(client, target_url, bi, referer) for bi in block_indexes), return_exceptions=True)
    chunks = []
    served = 0
    for bi, blk in zip(block_indexes, blocks):
        if isinstance(blk, Exception) or blk is None:
            break
        b_start = max(start, bi * BLOCK_SIZE)
        b_end = min(end, (bi + 1) * BLOCK_SIZE - 1)
        frm = b_start - bi * BLOCK_SIZE
        to = min(b_end - bi * BLOCK_SIZE + 1, len(blk))
        if to <= frm:
            break
        chunks.append(blk[frm:to])
        served += to - frm
        if to - frm < b_end - b_start + 1:
            total_sizes[target_url] = bi * BLOCK_SIZE + len(blk)
            break

    last_block = (start + served - 1) // BLOCK_SIZE if served else start // BLOCK_SIZE
    schedule_block_prefetch(target_url, last_block + 1, READAHEAD_BLOCKS, referer, client, total)

    total = total_sizes.get(target_url)
    body = b"".join(chunks)
    headers = {
        "Content-Type": content_types.get(target_url) or "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": str(len(body)),
        "Content-Range": f"bytes {start}-{start+len(body)-1}/{total if total is not None else '*'}",
        "Cache-Control": "no-cache",
        **cors_headers,
    }
    return Response(content=body, status_code=206, headers=headers)


async def pump_open_ended(request: Request, target_url: str, start: int, referer: str, client: httpx.AsyncClient, cors_headers: dict):
    # probe total
    total = total_sizes.get(target_url)
    has_range = bool(request.headers.get("range"))
    if total is None:
        try:
            probe = await fetch_range(client, target_url, f"bytes={start}-{start}", referer)
            if probe.status_code == 200 and not probe.headers.get("content-range"):
                ct = probe.headers.get("content-type") or "application/octet-stream"
                if ct and "html" not in ct.lower():
                    content_types[target_url] = ct
                headers = {"Content-Type": ct, "Cache-Control": "no-cache", **cors_headers}
                # stream whole file (upstream ignores Range)
                return StreamingResponse(probe.aiter_bytes(), media_type=ct, headers=headers, status_code=200)
            cr = probe.headers.get("content-range")
            if cr and "/" in cr:
                total = int(cr.split("/")[-1])
                total_sizes[target_url] = total
        except Exception:
            pass
    if total is not None and start >= total:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total}", **cors_headers})

    headers = {
        "Content-Type": content_types.get(target_url) or "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        **cors_headers,
    }
    if has_range:
        headers["Content-Range"] = f"bytes {start}-{total-1 if total is not None else ''}/{total if total is not None else '*'}"
        status = 206
    else:
        if total is not None:
            headers["Content-Length"] = str(total - start)
        status = 200

    # fast start
    fast_end = min(start + PUMP_FAST_START - 1, (total - 1) if total is not None else start + PUMP_FAST_START - 1)
    schedule_block_prefetch(target_url, fast_end // BLOCK_SIZE, READAHEAD_BLOCKS + 1, referer, client, total)

    async def gen():
        cursor = start
        # fast start direct range fetch
        if fast_end >= start:
            try:
                resp = await fetch_range(client, target_url, f"bytes={start}-{fast_end}", referer)
                if resp.status_code == 200 and not resp.headers.get("content-range"):
                    async for chunk in resp.aiter_bytes(chunk_size=64*1024):
                        yield chunk
                    return
                cr = resp.headers.get("content-range")
                if cr and "/" in cr:
                    try:
                        t = int(cr.split("/")[-1])
                        total_sizes[target_url] = t
                    except Exception:
                        pass
                for chunk in [resp.content[i:i+64*1024] for i in range(0, len(resp.content), 64*1024)]:
                    yield chunk
                cursor = fast_end + 1
            except Exception:
                # fallback to block loop
                pass

        while True:
            if total is not None and cursor >= total:
                break
            # check if client disconnected (FastAPI handles via generator cancel)
            try:
                bi = cursor // BLOCK_SIZE
                blk = await get_block(client, target_url, bi, referer)
                frm = cursor - bi * BLOCK_SIZE
                if frm >= len(blk):
                    total_sizes[target_url] = bi * BLOCK_SIZE + len(blk)
                    break
                # slice remainder of block
                total_rem = None
                if total is not None:
                    total_rem = total - bi * BLOCK_SIZE
                    slc = blk[frm:min(len(blk), total_rem)]
                else:
                    slc = blk[frm:]
                # yield in chunks
                for i in range(0, len(slc), 64*1024):
                    yield slc[i:i+64*1024]
                cursor += len(slc)
                schedule_block_prefetch(target_url, bi+1, READAHEAD_BLOCKS, referer, client, total)
                if len(slc) < BLOCK_SIZE - frm:
                    # short block = EOF
                    total_sizes[target_url] = bi * BLOCK_SIZE + len(blk)
                    break
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("pump error: %s", e)
                break

    return StreamingResponse(gen(), headers=headers, status_code=status, media_type=headers["Content-Type"])
