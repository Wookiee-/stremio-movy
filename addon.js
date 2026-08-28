#!/usr/bin/env node

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// --- Keep-alive connection pooling ---
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const freekeys = require('freekeys');

// --- Configuration ---
const PORT = process.env.PORT || 7000;
const MOVY_API = 'https://api.wecollege.net';
const MOVY_BASE = 'https://www.movy.bz';
const MOVY_SERVERS = ['miami', 'seattle', 'denver', 'atlanta', 'phoenix', 'portland', 'cancun', 'paris'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Cache stream results to avoid re-scanning servers on every request
const streamCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- TMDB metadata lookup ---
const tmdbMetadataCache = new Map();
let tmdbApiKey = null;

async function getTmdbKey() {
  if (tmdbApiKey) return tmdbApiKey;
  try {
    const keys = await freekeys();
    tmdbApiKey = keys.tmdb_key;
    console.log('[TMDB] Got API key');
    return tmdbApiKey;
  } catch (err) {
    console.error('[TMDB] Failed to get key:', err.message);
    return null;
  }
}

async function lookupTmdbMetadata(imdbId, tmdbId, mediaType) {
  const cacheKey = `${imdbId || ''}:${tmdbId || ''}:${mediaType}`;
  const cached = tmdbMetadataCache.get(cacheKey);
  if (cached) return cached;

  const key = await getTmdbKey();
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

  if (!tmdbId) {
    console.log('[Movy] Skipping: no TMDB ID available');
    return [];
  }

  const cacheKey = `movy:${type}:${tmdbId}:${season}:${episode}`;
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
        seasonId: String(season || 1),
        episodeId: String(episode || 1),
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
            url: `http://127.0.0.1:${PORT}/proxy?url=${encodeURIComponent(src.url)}&referer=${encodeURIComponent(MOVY_BASE)}`,
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

router.get('/proxy', async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const targetUrl = parsedUrl.searchParams.get('url');
  const referer = parsedUrl.searchParams.get('referer') || MOVY_BASE;

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  try {
    const proxyHeaders = {
      'User-Agent': UA,
      'Referer': referer.endsWith('/') ? referer : referer + '/',
    };
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const agent = targetUrl.startsWith('https') ? httpsAgent : httpAgent;
    const response = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow', agent });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Type');

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');

    const isM3u8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl');

    if (isM3u8) {
      const body = await response.text();
      const baseProxy = `http://127.0.0.1:${PORT}/proxy?referer=${encodeURIComponent(referer)}&url=`;
      let rewritten = body.replace(/^(https?:\/\/\S+)$/gm, (line) => baseProxy + encodeURIComponent(line));
      rewritten = rewritten.replace(/URI="(https?:\/\/[^"\s]+)"/g, (match, url) => `URI="${baseProxy + encodeURIComponent(url)}"`);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewritten);
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
        console.error(`[Proxy] Stream error: ${err.message}`);
        res.destroy();
      });
    } else {
      // Fallback: fetch and stream chunks instead of buffering
      const buf = await response.buffer();
      res.end(buf);
    }
  } catch (err) {
    console.error(`[Proxy] Error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
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
      <p style="margin-top: 10px;"><code>http://127.0.0.1:${PORT}/manifest.json</code></p>
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

// --- Start server ---
const server = http.createServer((req, res) => {
  router(req, res, (err) => {
    if (err) {
      console.error('[Server] Router error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Movy Stream - Stremio Addon\n  Server running at: http://127.0.0.1:${PORT}\n  Manifest:           http://127.0.0.1:${PORT}/manifest.json\n  Install in Stremio: stremio://127.0.0.1:${PORT}/manifest.json\n  `);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
