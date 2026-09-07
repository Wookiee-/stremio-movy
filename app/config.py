"""Shared configuration (ported from addon.js)."""
import os

PORT = int(os.getenv("PORT", "7000"))
HOST = os.getenv("HOST", "127.0.0.1")
MOVY_API = os.getenv("MOVY_API", "https://api.wecollege.net")
MOVY_BASE = os.getenv("MOVY_BASE", "https://www.movy.bz")
MOVY_SERVERS = ["miami", "seattle", "denver", "atlanta", "phoenix", "portland", "cancun", "paris"]
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
)

CACHE_TTL = 5 * 60  # seconds, stream results
METADATA_TTL = 60 * 60  # seconds, tmdb metadata

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "")
OMDB_API_KEY = os.getenv("OMDB_API_KEY", "")
