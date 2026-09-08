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
    """Live integration: Reacher S01E01 should yield direct upstream URLs, never proxied."""
    from httpx import ASGITransport
    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=60) as c:
        r = await c.get("/stream/series/tt9288030:1:1.json")
        assert r.status_code == 200
        streams = r.json()["streams"]
        assert len(streams) > 0
        assert all(s["url"].startswith("http") and "/proxy" not in s["url"] for s in streams)
