import httpx
import pytest

from app.movy import _build_stream, parse_stremio_id


def test_parse_ids():
    assert parse_stremio_id("series", "tt9288030:1:2") == ("tt9288030", 1, 2)
    assert parse_stremio_id("series", "tmdb:108978:1:2") == ("tmdb:108978", 1, 2)
    assert parse_stremio_id("movie", "tt1234567") == ("tt1234567", 1, 1)
    assert parse_stremio_id("series", "tt123:3") == ("tt123", 3, 1)


def test_direct_stream_has_proxy_headers():
    s = _build_stream("miami", "1080p", "https://x/y.m3u8")
    assert s["url"] == "https://x/y.m3u8"
    assert "proxyHeaders" in s["behaviorHints"]
    assert s["behaviorHints"]["proxyHeaders"]["request"]["Referer"].startswith("https://")


def test_proxied_stream_has_proxy_url():
    s = _build_stream("miami", "1080p", "https://x/y.m3u8", base_url="http://127.0.0.1:7000")
    assert "/proxy?url=" in s["url"]
    assert "https%3A%2F%2Fx%2Fy.m3u8" in s["url"]
    assert "proxyHeaders" not in s["behaviorHints"]
    assert s["behaviorHints"]["bingeGroup"] == "movy-1080p"


@pytest.mark.asyncio
async def test_manifest_and_health():
    from httpx import ASGITransport
    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/manifest.json")).json()["id"] == "community.movy"
        assert (await c.get("/health")).json()["ok"] is True
        assert (await c.get("/")).status_code == 200


@pytest.mark.asyncio
async def test_live_stream_direct():
    """Live integration: Reacher S01E01 should yield proxied upstream URLs (HLS readahead)."""
    from httpx import ASGITransport
    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=60) as c:
        r = await c.get("/stream/series/tt9288030:1:1.json")
        assert r.status_code == 200
        streams = r.json()["streams"]
        assert len(streams) > 0
        assert all(s["url"].startswith("http") and "/proxy?url=" in s["url"] for s in streams)


@pytest.mark.asyncio
async def test_proxy_missing_url():
    from httpx import ASGITransport
    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/proxy")
        assert r.status_code == 400
        r = await c.get("/proxy?url=https://example.com/video.mp4")
        # should proxy (or 502 if blocked) but not 400
        assert r.status_code != 400


@pytest.mark.asyncio
async def test_proxy_playlist_rewrite():
    from app.proxy import rewrite_playlist

    body = "#EXTM3U\n#EXT-X-STREAM-INF:URI=\"chunk.m3u8\"\nsegment0.ts\nsegment1.ts\n"
    rewritten, segs = rewrite_playlist(body, "https://cdn.example.com/path/playlist.m3u8", "http://127.0.0.1:7000", "https://www.movy.bz")
    assert "/proxy?" in rewritten and "url=" in rewritten
    assert len(segs) == 2
    assert segs[0] == "https://cdn.example.com/path/segment0.ts"
