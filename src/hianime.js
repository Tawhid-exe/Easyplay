import { fetchWithTimeout, convertImdbToTmdb } from "./utils.js";
import { HIANIME_ENABLED, HIANIME_API_BASES, HIANIME_REFERER } from "./config.js";

const API_TTL = 10 * 60 * 1000;
const apiCache = new Map();
const aliveBases = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttl) {
  if (map.size >= 400) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { ts: Date.now(), ttl, value });
}

function pickBase() {
  for (const base of HIANIME_API_BASES) {
    if (aliveBases.get(base) === false) continue;
    return base;
  }
  return HIANIME_API_BASES[0];
}

function markDead(base) {
  aliveBases.set(base, false);
}

async function apiGet(path) {
  const cached = cacheGet(apiCache, path, API_TTL);
  if (cached) return cached;

  const bases = HIANIME_API_BASES;
  for (let i = 0; i < bases.length; i++) {
    const base = i === 0 ? pickBase() : bases[i];
    const url = `${base}${path}`;
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", Referer: HIANIME_REFERER },
    });
    if (!res) {
      markDead(base);
      continue;
    }
    if (res.status === 500 || res.status === 502 || res.status === 503) {
      markDead(base);
      continue;
    }
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    if (!data || data.success === false) {
      markDead(base);
      continue;
    }
    if (data) cacheSet(apiCache, path, { base, data }, API_TTL);
    return { base, data };
  }
  return null;
}

function findAnime(results, title, year) {
  let shows = results?.data?.shows || results?.data?.anime || results?.data || null;
  if (shows && !Array.isArray(shows)) {
    shows = Object.values(shows).find(Array.isArray);
  }
  if (!Array.isArray(shows)) return null;

  const q = title.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const s of shows) {
    const name = String(s.name || "").toLowerCase();
    const jname = String(s.jname || "").toLowerCase();
    if (!name && !jname) continue;
    let score = 0;
    if (name === q || jname === q) score += 20;
    else if ((name && (name.includes(q) || q.includes(name))) || (jname && (jname.includes(q) || q.includes(jname)))) score += 10;
    if (year) {
      const ry = parseInt(s.released || s.year, 10);
      if (ry && ry === year) score += 5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best && bestScore >= 10 ? best : null;
}

function buildProxyUrl(targetUrl, referer) {
  const proxyOrigin = globalThis.__proxyOrigin;
  if (!proxyOrigin) return null;
  const proxyUrl = new URL("/proxy/hls/stream.m3u8", proxyOrigin);
  proxyUrl.searchParams.set("url", targetUrl);
  if (referer) proxyUrl.searchParams.set("referer", referer);
  return proxyUrl.href;
}

function normalizeCaptions(tracks) {
  if (!Array.isArray(tracks)) return null;
  const caps = tracks
    .filter(t => t && (t.kind === "captions" || t.kind === "subtitles" || !t.kind) && t.file)
    .map((t, i) => ({
      id: `${t.label || t.lang || "sub"}-${i}`,
      url: t.file,
      lang: (t.label || t.lang || "English").replace(/\s*\(.*\)$/, ""),
    }));
  return caps.length ? caps : null;
}

async function parseStreams(streamData, base) {
  const streams = [];

  if (Array.isArray(streamData.streams)) {
    for (const server of streamData.streams) {
      const serverReferer = server?.headers?.Referer || HIANIME_REFERER;
      const serverCaps = normalizeCaptions(server?.subtitles);
      const sources = server?.sources || [];
      for (const src of sources) {
        const raw = src?.file || src?.url;
        if (!raw || !/^https?:/.test(raw)) continue;
        const qual = src.quality && src.quality !== "default" && src.quality !== "auto" ? String(src.quality) : "Auto";
        const proxyUrl = src.proxy_url ? `${base}${src.proxy_url}` : null;
        const url = proxyUrl || buildProxyUrl(raw, serverReferer) || raw;
        streams.push({
          url,
          quality: qual,
          referer: serverReferer,
          captions: serverCaps,
          headers: server?.headers || null,
        });
      }
    }
  }

  const nested = streamData?.data?.sources || streamData?.sources || [];
  if (Array.isArray(nested) && !streams.length) {
    const caps = normalizeCaptions(streamData?.data?.tracks || streamData?.tracks);
    for (const src of nested) {
      const raw = src?.file || src?.url;
      if (!raw || !/^https?:/.test(raw)) continue;
      const qual = src.quality && src.quality !== "default" && src.quality !== "auto" ? String(src.quality) : "Auto";
      streams.push({
        url: buildProxyUrl(raw, HIANIME_REFERER) || raw,
        quality: qual,
        referer: HIANIME_REFERER,
        captions: caps,
      });
    }
  }

  if (!streams.length) {
    const fallback = streamData?.data?.sources?.[0]?.file || streamData?.sources?.[0]?.file || streamData?.data?.file;
    if (fallback && /^https?:/.test(fallback)) {
      streams.push({
        url: buildProxyUrl(fallback, HIANIME_REFERER) || fallback,
        quality: "Auto",
        referer: HIANIME_REFERER,
        captions: normalizeCaptions(streamData?.data?.tracks || streamData?.tracks),
      });
    }
  }

  const seen = new Set();
  return streams.filter(s => {
    const key = s.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function tryHiAnime(imdbId, type, season, episode) {
  if (!HIANIME_ENABLED || type !== "series" || season == null || episode == null) return null;
  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb || !tmdb.name) return null;

    const title = tmdb.name;
    const year = tmdb.first_air_date
      ? parseInt(tmdb.first_air_date.split("-")[0], 10)
      : tmdb.release_date
        ? parseInt(tmdb.release_date.split("-")[0], 10)
        : null;

    const search = await apiGet(`/api/search?keyword=${encodeURIComponent(title)}`);
    if (!search) return null;

    const anime = findAnime(search.data, title, year);
    if (!anime || !anime.id) return null;

    const epData = await apiGet(`/api/episodes/${encodeURIComponent(anime.id)}`);
    if (!epData) return null;

    const episodes = epData.data?.data?.episodes || epData.data?.episodes || [];
    if (!episodes.length) return null;

    const target = Number(episode);
    const ep = episodes.find(e => Number(e.number) === target);
    const episodeId = ep?.id;
    if (!episodeId) return null;

    const streamData = await apiGet(`/api/stream/${encodeURIComponent(episodeId)}?server_type=sub&include_proxy_url=true`);
    if (!streamData) return null;

    const streams = await parseStreams(streamData.data, streamData.base);
    return streams.length ? streams : null;
  } catch (err) {
    console.error(`[scraper] hianime error:`, err.message);
    return null;
  }
}
