#!/usr/bin/env node

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- Keep-alive connection pooling ---
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const freekeys = require('freekeys');

// --- Configuration ---
const PORT = process.env.PORT || 7000;
const MOVY_API = 'https://api.wecollege.net';
const MOVY_BASE = 'https://www.movy.bz';
const MOVY_SERVERS = ['miami', 'seattle', 'denver', 'atlanta', 'phoenix', 'portland', 'cancun', 'paris'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Dynamic base URL — works on Vercel, local dev, or any host
function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (req && req.headers && req.headers.host) return `http://${req.headers.host}`;
  return `http://127.0.0.1:${PORT}`;
}

// Cache stream results to avoid re-scanning servers on every request
const streamCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- TMDB metadata lookup ---
const tmdbMetadataCache = new Map();
let tmdbApiKey = null;
let omdbApiKey = null;

async function getKeys() {
  if (tmdbApiKey && omdbApiKey) return { tmdbApiKey, omdbApiKey };
  // Prefer user-supplied keys via env (OMDB_API_KEY is the OMDb key used to
  // bridge episode IMDb ids to their parent series). Fall back to freekeys.
  try {
    const keys = await freekeys().catch(() => ({}));
    tmdbApiKey = process.env.TMDB_API_KEY || keys.tmdb_key;
    omdbApiKey = process.env.OMDB_API_KEY || keys.imdb_key; // freekeys' imdb_key is an OMDb key (8-hex format)
    if (tmdbApiKey && omdbApiKey) console.log('[TMDB] Got API keys');
    return { tmdbApiKey, omdbApiKey };
  } catch (err) {
    console.error('[TMDB] Failed to get key:', err.message);
    return null;
  }
}

async function lookupTmdbMetadata(imdbId, tmdbId, mediaType) {
  const cacheKey = `${imdbId || ''}:${tmdbId || ''}:${mediaType}`;
  const cached = tmdbMetadataCache.get(cacheKey);
  if (cached) return cached;

  const { tmdbApiKey: key, omdbApiKey } = await getKeys() || {};
  if (!key) return {};

  try {
    let result = {};

    // If we have an IMDB ID but no tmdbId, resolve via /find
    if (imdbId && imdbId.startsWith('tt') && !tmdbId) {
      const res = await fetch(
        `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${key}`,
        { signal: AbortSignal.timeout(10000), agent: httpsAgent }
      );
      const data = await res.json();
      const item = data.tv_results?.[0] || data.movie_results?.[0];
      if (item) {
        result.tmdbId = item.id;
        result.title = item.name || item.title || '';
        result.year = (item.first_air_date || item.release_date || '').slice(0, 4);
        result.imdbId = imdbId;
      }
    } else if (imdbId) {
      result.imdbId = imdbId;
    }

    // IMDB id may be an episode id (e.g. tt0752254), which `/find` cannot map.
    // Bridge through OMDb (returns the parent seriesID) then TMDB `/find` on that
    // series to get the series TMDB id + season/episode numbers.
    if (mediaType === 'tv' && !result.tmdbId && imdbId && imdbId.startsWith('tt') && omdbApiKey) {
      try {
        const omdbRes = await fetch(
          `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(omdbApiKey)}`,
          { signal: AbortSignal.timeout(10000), agent: httpsAgent }
        );
        const omdb = await omdbRes.json();
        if (omdb.Response === 'True' && omdb.Type === 'episode' && omdb.seriesID) {
          const seriesImdb = omdb.seriesID;
          const seriesRes = await fetch(
            `https://api.themoviedb.org/3/find/${seriesImdb}?external_source=imdb_id&api_key=${key}`,
            { signal: AbortSignal.timeout(10000), agent: httpsAgent }
          );
          const seriesData = await seriesRes.json();
          const series = seriesData.tv_results?.[0];
          if (series) {
            result.tmdbId = series.id;
            result.title = result.title || series.name || '';
            result.year = result.year || (series.first_air_date || '').slice(0, 4);
            result.imdbId = seriesImdb;
            if (omdb.Season) result.season = parseInt(omdb.Season, 10) || undefined;
            if (omdb.Episode) result.episode = parseInt(omdb.Episode, 10) || undefined;
            console.log(`[TMDB] Episode ${imdbId} -> series ${series.name} (tmdb:${series.id} s${result.season}e${result.episode})`);
          }
        } else {
          console.log(`[TMDB] OMDb: ${omdb.Response === 'True' ? 'not an episode' : 'no match'} for ${imdbId}`);
        }
      } catch (err) {
        console.error(`[TMDB] Episode resolution failed:`, err.message);
      }
    }

    // Fetch details — parallelize with find if we already have a tmdbId
    const resolvedTmdbId = result.tmdbId || tmdbId;
    if (resolvedTmdbId && mediaType === 'tv') {
      const res = await fetch(
        `https://api.themoviedb.org/3/tv/${resolvedTmdbId}?api_key=${key}`,
        { signal: AbortSignal.timeout(10000), agent: httpsAgent }
      );
      const data = await res.json();
      if (data.name) result.title = result.title || data.name;
      if (data.first_air_date) result.year = result.year || data.first_air_date.slice(0, 4);
      result.totalSeasons = data.number_of_seasons || 1;
    } else if (resolvedTmdbId && mediaType === 'movie') {
      const res = await fetch(
        `https://api.themoviedb.org/3/movie/${resolvedTmdbId}?api_key=${key}`,
        { signal: AbortSignal.timeout(10000), agent: httpsAgent }
      );
      const data = await res.json();
      if (data.title) result.title = result.title || data.title;
      if (data.release_date) result.year = result.year || data.release_date.slice(0, 4);
    }

    result.tmdbId = resolvedTmdbId;
    tmdbMetadataCache.set(cacheKey, result);
    console.log(`[TMDB] Metadata: ${result.title} (${result.year}) tmdb:${result.tmdbId} totalSeasons:${result.totalSeasons || 'N/A'}`);
    return result;
  } catch (err) {
    console.error(`[TMDB] Metadata lookup failed:`, err.message);
    return {};
  }
}

// --- Helpers ---
function extractImdbId(stremioId) {
  if (stremioId.startsWith('tt')) return stremioId;
  if (stremioId.startsWith('imdb:')) return stremioId.replace('imdb:', '');
  return null;
}

function extractTmdbId(stremioId) {
  if (stremioId.startsWith('tmdb:')) return stremioId.replace('tmdb:', '');
  return null;
}

// --- Movy.bz decryption (ported from their client-side JS) ---
const MOVY_CRYPTO_ROUNDS = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
  0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
  0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174
];
const MOVY_MAGIC = [109, 118, 109, 49]; // "mvm1"

function movyIsLucky(e) { return (e * (e + 1) & 1) === 0; }

function movyM3(e) {
  e >>>= 0;
  e ^= e >>> 16; e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13; e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^ (e >>> 16)) >>> 0;
}

function movyRotl(e, t) {
  e >>>= 0; t &= 31;
  if (t === 0) return e >>> 0;
  return ((e << t) | (e >>> (32 - t))) >>> 0;
}

function movyInitCipherState(key, mix) {
  let a;
  if (((a = key.length) * (a + 1) & 1) === 1) {
    const S = Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key.charCodeAt(i % key.length)) & 255;
      const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
    }
    let acc = 0x67452301;
    for (let i = 0; i < key.length; i++) {
      acc = movyRotl((acc ^ Math.imul(key.charCodeAt(i), MOVY_CRYPTO_ROUNDS[15 & i])) >>> 0, 5);
    }
    acc = movyM3(acc);
    return { S, acc };
  }
  const S = Array(61);
  let r = movyM3(
    (function(e) {
      let t = 0x811c9dc5;
      for (let a = 0; a < e.length; a++) t = Math.imul(t ^ e.charCodeAt(a), 0x1000193) >>> 0;
      return movyM3(t);
    })(key) ^ movyM3((mix >>> 0) ^ 0x9e3779b9)
  ) >>> 0;
  for (let e = 0; e < 8; e++) {
    if (movyIsLucky(e)) {
      const t = r % 61;
      r = movyRotl((r + 0x9e3779b9) >>> 0, 7 + (7 & e));
      S[t] = (r ^ movyM3(r)) >>> 0;
      r = movyM3((r + t) >>> 0);
    } else {
      S[e] = MOVY_CRYPTO_ROUNDS[15 & e];
    }
  }
  return { S, acc: movyM3(0xa5a5a5a5 ^ r) >>> 0 };
}

function movyCipherStep(state, counter) {
  const S = state.S;
  let n = state.acc;
  const i = n % 61;
  const o = 0 - Number(i in S);
  const l = S[i] >>> 0;
  const c = Math.imul(0x9e3779b9, counter + 1) >>> 0;
  const combined = (((n) ^ ((l ^ c) >>> 0)) >>> 0 | (n & ((l ^ c) >>> 0) & o) >>> 0) >>> 0;
  n = movyM3(((movyRotl(combined + n >>> 0, 31 & i) ^ movyRotl(n, 31 & Math.imul(i, 7))) >>> 0) + 0x9e3779b9 >>> 0);
  S[i] = n >>> 0;
  state.acc = n;
  return n >>> 0;
}

function movyDecrypt(encryptedBase64, seed, mediaId) {
  let b64 = encryptedBase64.replace(/-/g, '+').replace(/_/g, '/');
  b64 = b64.padEnd(4 * Math.ceil(b64.length / 4), '=');
  const r = new Uint8Array(Buffer.from(b64, 'base64'));
  const state = movyInitCipherState(seed, mediaId);
  const ks = new Uint8Array(r.length);
  let counter = 0;
  for (let e = 0; e < r.length; ) {
    const kw = movyCipherStep(state, counter++);
    ks[e++] = kw & 0xff;
    if (e < r.length) ks[e++] = (kw >>> 8) & 0xff;
    if (e < r.length) ks[e++] = (kw >>> 16) & 0xff;
    if (e < r.length) ks[e++] = (kw >>> 24) & 0xff;
  }
  for (let e = 0; e < r.length; e++) r[e] ^= ks[e];
  for (let i = 0; i < MOVY_MAGIC.length; i++) {
    if (r[i] !== MOVY_MAGIC[i]) throw new Error('Movy decrypt failed');
  }
  return Buffer.from(r.subarray(MOVY_MAGIC.length)).toString('utf8');
}

// --- Core: resolve Movy.bz streams ---
async function resolveMovyStream(type, stremioId, season, episode) {
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  let tmdbId = extractTmdbId(stremioId);
  const imdbId = extractImdbId(stremioId);

  // Fetch metadata (title, year, totalSeasons, imdbId) from TMDB
  const meta = await lookupTmdbMetadata(imdbId, tmdbId, mediaType);
  if (meta.tmdbId) tmdbId = meta.tmdbId;

  // If metadata resolved a specific episode (episode IMDb id -> OMDb), prefer its
  // season/episode numbers over whatever was parsed from the Stremio id.
  const resolvedSeason = (meta.season != null) ? meta.season : season;
  const resolvedEpisode = (meta.episode != null) ? meta.episode : episode;

  if (!tmdbId) {
    console.log('[Movy] Skipping: no TMDB ID available');
    return [];
  }

  const cacheKey = `movy:${type}:${tmdbId}:${resolvedSeason}:${resolvedEpisode}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[Movy] Cached: ${cacheKey}`);
    return cached.streams;
  }

  if (pendingRequests.has(cacheKey)) {
    console.log(`[Movy] Waiting for in-flight: ${cacheKey}`);
    return pendingRequests.get(cacheKey);
  }

  const resolvePromise = (async () => {
    try {
      const timeout = 15000;
      const fetchOpts = (opts = {}) => ({ ...opts, signal: AbortSignal.timeout(timeout), agent: httpsAgent });

      // Get seed
      const seedRes = await fetch(`${MOVY_API}/seed?mediaId=${tmdbId}`, fetchOpts({
        headers: { 'User-Agent': UA },
      }));
      if (!seedRes.ok) throw new Error(`Movy seed ${seedRes.status}`);
      const { seed } = await seedRes.json();

      const params = new URLSearchParams({
        title: encodeURIComponent(meta.title || ''),
        mediaType,
        tmdbId: String(tmdbId),
        seasonId: String(resolvedSeason || 1),
        episodeId: String(resolvedEpisode || 1),
        enc: '2',
        seed,
      });
      if (meta.year) params.set('year', meta.year);
      if (meta.totalSeasons) params.set('totalSeasons', String(meta.totalSeasons));
      if (meta.imdbId) params.set('imdbId', meta.imdbId);

      const streams = [];

      // Query each server in parallel
      const serverPromises = MOVY_SERVERS.map(async (server) => {
        try {
          const url = `${MOVY_API}/${server}/sources?${params}`;
          const res = await fetch(url, fetchOpts({ headers: { 'User-Agent': UA } }));
          if (!res.ok) return [];

          const encrypted = await res.text();
          if (!encrypted || encrypted.length < 10) return [];

          const plaintext = movyDecrypt(encrypted, seed, parseInt(tmdbId, 10));
          const data = JSON.parse(plaintext);

          if (!data.sources || data.sources.length === 0) return [];
          console.log(`[Movy] ${server}: ${data.sources.length} source(s)`);

          return data.sources.map((src) => ({
            name: `Movy - ${server}${src.quality ? ' (' + src.quality + ')' : ''}`,
            title: `${server}${src.quality ? ' (' + src.quality + ')' : ''}`,
            url: `${getBaseUrl()}/proxy?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(MOVY_BASE)}`,
          }));
        } catch (err) {
          console.log(`[Movy] ${server}: ${err.message}`);
          return [];
        }
      });

      const results = await Promise.allSettled(serverPromises);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          for (const s of r.value) streams.push(s);
        }
      }

      streamCache.set(cacheKey, { streams, ts: Date.now() });
      return streams;
    } catch (err) {
      console.error(`[Movy] Error: ${err.message}`);
      return [];
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, resolvePromise);
  return resolvePromise;
}

// --- Stremio Addon Builder ---
const manifest = {
  id: 'community.movy',
  version: '1.0.0',
  name: 'Movy Stream',
  description: 'Provides streams from Movy.bz for movies and TV shows',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'imdb:', 'tmdb:'],
};

const builder = addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[Stream] Request: type=${type}, id=${id}`);

  let season = 1;
  let episode = 1;
  let cleanId = id;

  const parts = id.split(':');
  if (parts.length >= 3) {
    if (parts[0] === 'tmdb') {
      cleanId = `tmdb:${parts[1]}`;
      season = parseInt(parts[2], 10) || 1;
      episode = parseInt(parts[3], 10) || 1;
    } else {
      cleanId = parts[0];
      season = parseInt(parts[1], 10) || 1;
      episode = parseInt(parts[2], 10) || 1;
    }
  } else if (parts.length === 2) {
    cleanId = parts[0];
    season = parseInt(parts[1], 10) || 1;
    episode = 1;
  }

  try {
    const streams = await resolveMovyStream(type, cleanId, season, episode);
    console.log(`[Stream] Returning ${streams.length} stream(s)`);
    return { streams };
  } catch (err) {
    console.error(`[Stream] Error: ${err.message}`);
    return { streams: [] };
  }
});

// --- Proxy endpoint ---
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

// --- Proxy helpers ---
// node-fetch 2.x cannot follow relative redirect Locations ("Only absolute
// URLs are supported"), which 502s whole streams. Follow redirects manually.
async function fetchWithRedirects(url, opts, maxHops = 5) {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(current, { ...opts, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { response: res, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

// --- Readahead cache ---
// Upstream hosts throttle per connection (~320 KB/s), while Stremio's player
// fetches sequentially with a small readahead. The movy.bz website stays
// smooth because the browser opens several segment requests in parallel.
// The proxy compensates: it caches media and prefetches ahead in parallel,
// so sequential players get served from memory at LAN speed.
// Small blocks keep the parallel pipeline flowing even when the upstream
// throttles a single connection hard: several 1MB fetches finish quickly and
// the pump always has the next chunk ready.
const BLOCK_SIZE = 1 * 1024 * 1024;
const READAHEAD_BLOCKS = 2;
const READAHEAD_MAX_BYTES = 160 * 1024 * 1024;
const MAX_RANGE_RESPONSE = 16 * 1024 * 1024;
const HLS_PREFETCH = 2;
// Small fast-start window so the player gets data immediately while the
// first blocks prefetch in parallel.
const PUMP_FAST_START = 512 * 1024;

const mediaCache = new Map();
let mediaCacheBytes = 0;
const inflightPrefetch = new Set();
const inflightFetches = new Map();  // key -> Promise<Buffer> (coalesces duplicate fetches)
const playlistSegments = new Map(); // upstream playlist URL -> [segment URLs]
const segmentPlaylist = new Map();  // segment URL -> upstream playlist URL
const totalSizes = new Map();       // media URL -> total byte size
const contentTypes = new Map();     // media URL -> upstream content-type

function cacheGet(key) {
  const entry = mediaCache.get(key);
  if (!entry) return null;
  entry.ts = Date.now();
  return entry.buf;
}

function cachePut(key, buf) {
  if (mediaCache.has(key)) return;
  mediaCache.set(key, { buf, ts: Date.now() });
  mediaCacheBytes += buf.length;
  while (mediaCacheBytes > READAHEAD_MAX_BYTES) {
    const oldestKey = mediaCache.keys().next().value;
    const oldest = mediaCache.get(oldestKey);
    mediaCacheBytes -= oldest.buf.length;
    mediaCache.delete(oldestKey);
  }
}

async function fetchRange(url, rangeHeader, referer) {
  const agent = url.startsWith('https') ? httpsAgent : httpAgent;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { response } = await fetchWithRedirects(url, {
      headers: {
        'User-Agent': UA,
        'Referer': referer.endsWith('/') ? referer : referer + '/',
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      agent,
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429) {
      // silent backoff — don't spam logs, just respect Retry-After
      if (attempt < 2) {
        const ra = parseInt(response.headers.get('retry-after') || '1', 10);
        const delay = Math.min(Math.max(isNaN(ra) ? 1 : ra, 1) * 1000, 5000) * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const err = new Error('Upstream 429');
      err.statusCode = 429;
      err.retryAfter = response.headers.get('retry-after') || '2';
      throw err;
    }
    if (!response.ok && response.status !== 206) throw new Error(`Upstream ${response.status}`);
    return response;
  }
}

// Single shared fetch per URL: concurrent client requests and prefetches
// for the same resource coalesce into one upstream connection.
function fetchBufferCoalesced(key, url, rangeHeader, referer) {
  if (inflightFetches.has(key)) return inflightFetches.get(key);
  const p = fetchRange(url, rangeHeader, referer)
    .then(async (res) => {
      let buf = await res.buffer();
      const ct = res.headers.get('content-type');
      if (ct && !ct.includes('html')) contentTypes.set(url, ct);
      const cr = res.headers.get('content-range');
      if (cr) {
        const total = parseInt(cr.split('/')[1], 10);
        if (!isNaN(total)) totalSizes.set(url, total);
      }
      if (rangeHeader && res.status === 200 && !cr) {
        // Upstream ignored Range and returned the whole file — slice it.
        const cl = parseInt(res.headers.get('content-length'), 10);
        if (!isNaN(cl)) totalSizes.set(url, cl);
        const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (m) {
          const s = parseInt(m[1], 10);
          const e = m[2] ? parseInt(m[2], 10) : buf.length - 1;
          buf = Buffer.from(buf.subarray(s, Math.min(e + 1, buf.length)));
        }
      }
      cachePut(key, buf);
      inflightFetches.delete(key);
      return buf;
    })
    .catch((err) => {
      inflightFetches.delete(key);
      throw err;
    });
  inflightFetches.set(key, p);
  return p;
}

function registerPlaylist(playlistUrl, segmentUrls) {
  playlistSegments.set(playlistUrl, segmentUrls);
  for (const seg of segmentUrls) segmentPlaylist.set(seg, playlistUrl);
}

// Upstream hosts label segments inconsistently (mpegurl, text/html); the
// player sniffs anyway, but pick a correct type from the extension for
// players that trust the header (e.g. Stremio web / hls.js).
function segmentContentType(url) {
  if (/\.ts(\?|$)/i.test(url)) return 'video/mp2t';
  if (/\.(m4s|mp4)(\?|$)/i.test(url)) return 'video/iso.segment';
  if (/\.aac(\?|$)/i.test(url)) return 'audio/aac';
  return null;
}

function scheduleHlsPrefetch(segUrl, referer) {
  const list = playlistSegments.get(segmentPlaylist.get(segUrl));
  if (!list) return;
  const idx = list.indexOf(segUrl);
  if (idx === -1) return;
  for (let n = 1; n <= HLS_PREFETCH; n++) {
    const next = list[idx + n];
    if (!next || cacheGet(next) || inflightPrefetch.has(next)) continue;
    inflightPrefetch.add(next);
    fetchBufferCoalesced(next, next, null, referer)
      .catch(() => {})
      .finally(() => inflightPrefetch.delete(next));
  }
}

function scheduleInitialPrefetch(playlistUrl, referer) {
  const list = playlistSegments.get(playlistUrl);
  if (!list || list.length === 0) return;
  const first = list[0];
  if (!cacheGet(first) && !inflightPrefetch.has(first)) {
    inflightPrefetch.add(first);
    fetchBufferCoalesced(first, first, null, referer)
      .catch(() => {})
      .finally(() => inflightPrefetch.delete(first));
  }
}

async function getBlock(url, blockIndex, referer) {
  const key = `${url}#b${blockIndex}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const start = blockIndex * BLOCK_SIZE;
  let buf = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2 && !buf; attempt++) {
    try {
      buf = await fetchBufferCoalesced(key, url, `bytes=${start}-${start + BLOCK_SIZE - 1}`, referer);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!buf) throw lastErr || new Error('block fetch failed');
  if (start + buf.length < (blockIndex + 1) * BLOCK_SIZE) {
    // short response = upstream EOF
    totalSizes.set(url, start + buf.length);
  }
  return cacheGet(key) || buf;
}

async function serveRangeFromCache(req, res, targetUrl, referer) {
  const match = /^bytes=(\d*)-(\d*)/.exec(req.headers.range);
  const start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : NaN;
  let total = totalSizes.get(targetUrl) || null;

  if (isNaN(end)) {
    if (total == null) {
      try {
        const probe = await fetchRange(targetUrl, `bytes=${start}-${start}`, referer);
        const cr = probe.headers.get('content-range');
        if (cr) {
          const t = parseInt(cr.split('/')[1], 10);
          if (!isNaN(t)) { total = t; totalSizes.set(targetUrl, t); }
        }
      } catch (err) { /* probe failed; cap response below */ }
    }
    if (total != null && start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    end = total != null ? Math.min(total - 1, start + MAX_RANGE_RESPONSE - 1) : start + MAX_RANGE_RESPONSE - 1;
  }

  const chunks = [];
  let served = 0;
  const blockIndexes = [];
  for (let bi = Math.floor(start / BLOCK_SIZE); bi * BLOCK_SIZE <= end; bi++) blockIndexes.push(bi);
  // Fetch the needed blocks in parallel (coalescing prevents duplicates)
  const blocks = await Promise.all(blockIndexes.map((bi) => getBlock(targetUrl, bi, referer).catch(() => null)));
  for (let i = 0; i < blockIndexes.length; i++) {
    const bi = blockIndexes[i];
    const block = blocks[i];
    if (!block) break;
    const bStart = Math.max(start, bi * BLOCK_SIZE);
    const bEnd = Math.min(end, (bi + 1) * BLOCK_SIZE - 1);
    const from = bStart - bi * BLOCK_SIZE;
    const to = Math.min(bEnd - bi * BLOCK_SIZE + 1, block.length);
    if (to <= from) break; // upstream EOF
    chunks.push(block.subarray(from, to));
    served += to - from;
    if (to - from < bEnd - bStart + 1) { // upstream EOF inside this block
      totalSizes.set(targetUrl, bi * BLOCK_SIZE + block.length);
      total = bi * BLOCK_SIZE + block.length;
      break;
    }
  }

  const lastBlock = Math.floor((start + served - 1) / BLOCK_SIZE);
  for (let n = 1; n <= READAHEAD_BLOCKS; n++) {
    const bi = lastBlock + n;
    const key = `${targetUrl}#b${bi}`;
    if (total != null && bi * BLOCK_SIZE >= total) break;
    if (!cacheGet(key) && !inflightPrefetch.has(key)) {
      inflightPrefetch.add(key);
      getBlock(targetUrl, bi, referer).catch(() => {}).finally(() => inflightPrefetch.delete(key));
    }
  }

  const headers = {
    'Content-Type': contentTypes.get(targetUrl) || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': served,
    'Content-Range': `bytes ${start}-${start + served - 1}/${total != null ? total : '*'}`,
    'Cache-Control': 'no-cache',
  };
  res.writeHead(206, headers);
  res.end(Buffer.concat(chunks));
}

function scheduleBlockPrefetch(url, fromBlock, count, referer, total) {
  for (let n = 0; n < count; n++) {
    const bi = fromBlock + n;
    const key = `${url}#b${bi}`;
    if (total != null && bi * BLOCK_SIZE >= total) break;
    if (!cacheGet(key) && !inflightPrefetch.has(key)) {
      inflightPrefetch.add(key);
      getBlock(url, bi, referer).catch(() => {}).finally(() => inflightPrefetch.delete(key));
    }
  }
}

function drain(res) {
  return new Promise((resolve) => res.once('drain', resolve));
}

// Progressive stream for open-ended ("bytes=N-") or range-less MP4 requests.
// The upstream throttles a single connection below the bitrate Stremio's
// player expects, so beyond a small fast-start window the file is pumped
// block-by-block while the next blocks download in parallel.
async function pumpOpenEnded(req, res, targetUrl, start, referer) {
  const hasRange = !!req.headers.range;
  let total = totalSizes.get(targetUrl) || null;
  if (total == null) {
    try {
      const probe = await fetchRange(targetUrl, `bytes=${start}-${start}`, referer);
      if (probe.status === 200 && !probe.headers.get('content-range')) {
        // Upstream ignores Range — fall back to a plain stream of the file.
        const ct = probe.headers.get('content-type');
        if (ct && !ct.includes('html')) contentTypes.set(targetUrl, ct);
        res.writeHead(200, { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        probe.body.pipe(res);
        probe.body.on('error', () => res.destroy());
        return;
      }
      const cr = probe.headers.get('content-range');
      if (cr) {
        const t = parseInt(cr.split('/')[1], 10);
        if (!isNaN(t)) { total = t; totalSizes.set(targetUrl, t); }
      }
    } catch (err) { /* total stays unknown */ }
  }
  if (total != null && start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': contentTypes.get(targetUrl) || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (hasRange) {
    headers['Content-Range'] = `bytes ${start}-${total != null ? total - 1 : ''}/${total != null ? total : '*'}`;
    res.writeHead(206, headers);
  } else {
    if (total != null) headers['Content-Length'] = total - start;
    res.writeHead(200, headers);
  }

  // Fast start: pipe the first window straight from its own upstream
  // connection so the player gets data immediately.
  const hardEnd = total != null ? total - 1 : start + PUMP_FAST_START - 1;
  const fastEnd = Math.min(start + PUMP_FAST_START - 1, hardEnd);
  scheduleBlockPrefetch(targetUrl, Math.floor(fastEnd / BLOCK_SIZE), READAHEAD_BLOCKS + 1, referer, total);

  let cursor = start;
  try {
    if (fastEnd >= start) {
      const response = await fetchRange(targetUrl, `bytes=${start}-${fastEnd}`, referer);
      const abort = () => response.body.destroy();
      res.on('close', abort);
      if (response.status === 200 && !response.headers.get('content-range')) {
        // Inconsistent upstream: pipe the whole file to completion.
        response.body.pipe(res);
        response.body.on('error', () => res.destroy());
        res.off('close', abort);
        return;
      }
      await new Promise((resolve, reject) => {
        response.body.on('error', reject);
        response.body.on('end', resolve);
        response.body.pipe(res, { end: false });
      });
      res.off('close', abort);
      const cr = response.headers.get('content-range');
      if (cr) {
        const t = parseInt(cr.split('/')[1], 10);
        if (!isNaN(t)) { total = t; totalSizes.set(targetUrl, t); }
      }
      cursor = fastEnd + 1;
    }

    // Continue from the block cache, keeping parallel prefetches running.
    while (!res.destroyed && !res.writableEnded) {
      if (total != null && cursor >= total) break;
      const bi = Math.floor(cursor / BLOCK_SIZE);
      const block = await getBlock(targetUrl, bi, referer);
      const from = cursor - bi * BLOCK_SIZE;
      if (from >= block.length) {
        totalSizes.set(targetUrl, bi * BLOCK_SIZE + block.length);
        break;
      }
      const slice = block.subarray(from, Math.min(total != null ? total - bi * BLOCK_SIZE : block.length, block.length));
      if (!res.write(slice)) await drain(res);
      cursor += slice.length;
      scheduleBlockPrefetch(targetUrl, bi + 1, READAHEAD_BLOCKS, referer, total);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) throw err;
    res.destroy();
  }
}

// Rewrite an HLS playlist body: every entry is resolved against the upstream
// playlist URL and routed back through the proxy. Used for both .m3u8 URLs
// and extension-less playlists (sniffed via the #EXTM3U header at serve time).
function rewritePlaylist(body, playlistUrl, req, referer) {
  const baseProxy = `${getBaseUrl(req)}/proxy?referer=${encodeURIComponent(referer)}&url=`;
  const toProxy = (raw) => {
    try {
      return baseProxy + encodeURIComponent(new URL(raw, playlistUrl).toString());
    } catch (err) {
      return raw;
    }
  };
  const segmentUrls = [];
  const rewritten = body.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // Rewrite URI="..." attributes (variant playlists, keys, init maps)
      return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${toProxy(uri)}"`);
    }
    try {
      const abs = new URL(trimmed, playlistUrl).toString();
      if (!/\.m3u8(\?|$)/i.test(abs)) segmentUrls.push(abs);
    } catch (err) { /* leave unrewritten lines as-is */ }
    return toProxy(trimmed);
  }).join('\n');
  return { rewritten, segmentUrls };
}

router.get('/proxy', async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const targetUrl = parsedUrl.searchParams.get('url');
  const referer = parsedUrl.searchParams.get('referer') || MOVY_BASE;

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type');

  const isKnownSegment = segmentPlaylist.has(targetUrl);

  try {
    // Cached HLS segment — serve from memory immediately, keep prefetching ahead
    if (isKnownSegment) {
      const cached = cacheGet(targetUrl);
      if (cached) {
        // Extension-less playlists can be misregistered as segments; sniff
        // for the playlist header and rewrite them instead of serving raw.
        if (cached.subarray(0, 7).toString('latin1') === '#EXTM3U') {
          segmentPlaylist.delete(targetUrl);
          const { rewritten, segmentUrls } = rewritePlaylist(cached.toString('utf8'), targetUrl, req, referer);
          registerPlaylist(targetUrl, segmentUrls);
          scheduleInitialPrefetch(targetUrl, referer);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
          res.end(rewritten);
          return;
        }
        const match = req.headers.range ? /^bytes=(\d+)-(\d*)/.exec(req.headers.range) : null;
        const body = match ? cached.subarray(parseInt(match[1], 10), match[2] ? parseInt(match[2], 10) + 1 : undefined) : cached;
        const headers = {
          'Content-Type': segmentContentType(targetUrl) || contentTypes.get(targetUrl) || 'application/octet-stream',
          'Content-Length': body.length,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        };
        if (match) headers['Content-Range'] = `bytes ${parseInt(match[1], 10)}-${parseInt(match[1], 10) + body.length - 1}/${cached.length}`;
        res.writeHead(match ? 206 : 200, headers);
        res.end(body);
        scheduleHlsPrefetch(targetUrl, referer);
        return;
      }
    }

    // Media requests (MP4 etc.) — served through the parallel block cache.
    // Playlists are excluded: they must go through the rewrite path below.
    const looksLikeM3u8 = /\.m3u8(\?|$)/i.test(targetUrl);
    if (!isKnownSegment && !looksLikeM3u8 && req.method === 'GET') {
      const range = req.headers.range;
      const closedRange = range && /^bytes=\d+-\d+\s*$/.test(range.trim());
      if (closedRange) {
        await serveRangeFromCache(req, res, targetUrl, referer);
      } else {
        const start = range ? parseInt(/^bytes=(\d+)/.exec(range)[1], 10) : 0;
        await pumpOpenEnded(req, res, targetUrl, start, referer);
      }
      return;
    }

    const proxyHeaders = {
      'User-Agent': UA,
      'Referer': referer.endsWith('/') ? referer : referer + '/',
    };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const agent = targetUrl.startsWith('https') ? httpsAgent : httpAgent;
    const { response, finalUrl } = await fetchWithRedirects(targetUrl, { headers: proxyHeaders, agent });

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');

    const isM3u8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

    if (isM3u8) {
      if (!response.ok) {
        res.writeHead(response.status, { 'Content-Type': 'text/plain' });
        res.end(`Upstream playlist error: ${response.status}`);
        return;
      }
      const body = await response.text();
      const playlistUrl = finalUrl || targetUrl;
      const { rewritten, segmentUrls } = rewritePlaylist(body, playlistUrl, req, referer);
      registerPlaylist(playlistUrl, segmentUrls);
      scheduleInitialPrefetch(playlistUrl, referer);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewritten);
      return;
    }

    if (isKnownSegment) {
      // Uncached HLS segment — one coalesced upstream fetch, cached for
      // replay, then prefetch the next segments in parallel.
      const buf = await fetchBufferCoalesced(targetUrl, targetUrl, null, referer);
      // Extension-less playlists get registered as segments — sniff and
      // rewrite them instead of serving raw.
      if (buf.subarray(0, 7).toString('latin1') === '#EXTM3U') {
        segmentPlaylist.delete(targetUrl);
        const { rewritten, segmentUrls } = rewritePlaylist(buf.toString('utf8'), targetUrl, req, referer);
        registerPlaylist(targetUrl, segmentUrls);
        scheduleInitialPrefetch(targetUrl, referer);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
        res.end(rewritten);
        return;
      }
      const headers = {
        'Content-Type': segmentContentType(targetUrl) || contentTypes.get(targetUrl) || 'application/octet-stream',
        'Content-Length': buf.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      res.writeHead(200, headers);
      res.end(buf);
      scheduleHlsPrefetch(targetUrl, referer);
      return;
    }

    const headers = { 'Content-Type': contentType || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (contentLength) headers['Content-Length'] = contentLength;
    if (contentRange) headers['Content-Range'] = contentRange;

    res.writeHead(response.status, headers);
    // Stream the body directly — never buffer video in memory
    if (response.body && typeof response.body.pipe === 'function') {
      response.body.pipe(res);
      response.body.on('error', (err) => {
        if (!String(err.message).includes('429')) console.error(`[Proxy] Stream error: ${err.message}`);
        res.destroy();
      });
    } else {
      // Fallback: fetch and stream chunks instead of buffering
      const buf = await response.buffer();
      res.end(buf);
    }
  } catch (err) {
    const is429 = err.statusCode === 429 || String(err.message).includes('429');
    if (is429) {
      // silent — don't spam logs, return 429 so Stremio/player backs off
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': err.retryAfter || '2' });
        res.end(JSON.stringify({ error: 'Upstream rate limited', retryAfter: err.retryAfter || '2' }));
      } else {
        res.destroy();
      }
      return;
    }
    console.error(`[Proxy] Error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    } else {
      res.destroy();
    }
  }
});

router.options('/proxy', (req, res) => {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
  });
  res.end();
});

// --- Landing page ---
router.get('/', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const installUrl = `stremio://${req.headers.host || '127.0.0.1:' + PORT}/manifest.json`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Movy Stream - Stremio Addon</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 600px; padding: 40px; text-align: center; }
    h1 { font-size: 2.5rem; margin-bottom: 10px; color: #7b2ff7; }
    .subtitle { color: #aaa; margin-bottom: 30px; font-size: 1.1rem; }
    .card { background: #16213e; border-radius: 12px; padding: 30px; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .install-btn { display: inline-block; background: #7b2ff7; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 1.1rem; font-weight: 600; transition: background 0.2s; }
    .install-btn:hover { background: #6a1fd6; }
    .info { color: #888; font-size: 0.9rem; margin-top: 15px; }
    .features { text-align: left; margin-top: 20px; }
    .features li { margin: 8px 0; color: #ccc; }
    code { background: #0f3460; padding: 2px 8px; border-radius: 4px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>&#9654; Movy Stream</h1>
    <p class="subtitle">Stremio Addon for Movy.bz Streams</p>
    <div class="card">
      <a href="${installUrl}" class="install-btn">Install in Stremio</a>
      <p class="info">Click to install this addon in Stremio</p>
    </div>
    <div class="card">
      <h3 style="margin-bottom: 15px;">Manual Install</h3>
      <p>In Stremio, go to <strong>Add-ons &#8594; Community</strong> and paste:</p>
      <p style="margin-top: 10px;"><code>${baseUrl}/manifest.json</code></p>
    </div>
    <div class="card">
      <h3 style="margin-bottom: 15px;">Supported Content</h3>
      <ul class="features">
        <li>&#127916; Movies (by IMDB or TMDB ID)</li>
        <li>&#128250; TV Series (by IMDB or TMDB ID, with season/episode)</li>
        <li>&#128260; 8 server backends for reliability</li>
        <li>&#127760; Proxied streaming for reliable playback</li>
      </ul>
    </div>
  </div>
</body>
</html>`);
});

// --- Handler (exported for Vercel / serverless) ---
function handler(req, res) {
  router(req, res, (err) => {
    if (err) {
      console.error('[Server] Router error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

module.exports = { handler };

// --- Start server (local dev only) ---
if (require.main === module) {
  const server = http.createServer(handler);

  server.listen(PORT, () => {
    console.log(`\n  Movy Stream - Stremio Addon\n  Server running at: http://127.0.0.1:${PORT}\n  Manifest:           http://127.0.0.1:${PORT}/manifest.json\n  Install in Stremio: stremio://127.0.0.1:${PORT}/manifest.json\n  `);
  });

  process.on('SIGINT', () => { server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}
