import { STREAMDATA_API_URL, VIDLINK_BASE, ENC_VIDLINK_URL, BATCH_TIMEOUT, VIDAPI_ENABLED } from "./config.js";
import { tryVixSrc } from "./vixsrc.js";
import { try4KHDHub } from "./4khdhub.js";
import { tryHDHub4u } from "./hdhub4u.js";
import { tryMoviesDrive } from "./moviesdrive.js";
import { tryHiAnime } from "./hianime.js";
import { encryptVidlinkToken } from "./vidlink.js";
import { fetchWithTimeout, chromeHeaders, fetchWithRetry, headers, convertImdbToTmdb, sleep } from "./utils.js";
import { collectCookies, cookieString } from "./cookies.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function getVidApiSession(imdbId, type, season, episode) {
  try {
    const path = type === "series"
      ? `/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
      : `/embed/movie/${imdbId}`;
    const playerUrl = `https://nextgencloudfabric.com${path}`;

    const res = await fetchWithRetry(playerUrl, {
      headers: headers("https://streamimdb.ru/"),
      redirect: "follow",
    }, { attempts: 2, baseDelay: 250, maxDelay: 800 });
    if (!res || !res.ok) return null;

    const html = await res.text();
    const playToken = html.match(/"playToken"\s*:\s*"([^"]+)"/);

    if (!playToken) return null;

    return {
      playToken: playToken[1],
      cookies: collectCookies(res),
      playerUrl,
    };
  } catch {
    return null;
  }
}

function labelQuality(height) {
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 540) return "540p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return "240p";
}

async function extractVariants(masterUrl, referer, cookie) {
  try {
    const proxyOrigin = globalThis.__proxyOrigin || "http://localhost:8788";
    const encodedUrl = encodeURIComponent(masterUrl);
    const proxyUrl = `${proxyOrigin}/proxy/hls/stream.m3u8?url=${encodedUrl}&referer=${encodeURIComponent(referer)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ""}`;
    const res = await fetchWithRetry(proxyUrl, {
      headers: { "user-agent": UA, accept: "*/*" },
      redirect: "follow",
    }, { attempts: 2, baseDelay: 200, maxDelay: 600 });
    if (!res || !res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n");
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      if (!resolutionMatch) continue;
      const height = parseInt(resolutionMatch[2], 10);
      if (isNaN(height)) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const urlLine = lines[j].trim();
        if (!urlLine || urlLine.startsWith("#")) continue;
        variants.push({ proxyUrl: urlLine, quality: labelQuality(height), height });
        break;
      }
    }

    if (!variants.length) return null;
    variants.sort((a, b) => b.height - a.height);
    return variants;
  } catch {
    return null;
  }
}

async function tryVidApiDirect(imdbId, type, season, episode) {
  if (!VIDAPI_ENABLED) return null;
  try {
    const session = await getVidApiSession(imdbId, type, season, episode);

    let url = `${STREAMDATA_API_URL}?imdb=${imdbId}&type=${type === "series" ? "tv" : "movie"}`;
    if (type === "series" && season != null && episode != null) {
      url += `&season=${season}&episode=${episode}`;
    }
    if (session?.playToken) {
      url += `&playToken=${session.playToken}`;
    }

    const cookieHeader = session?.cookies ? cookieString(session.cookies) : "";
    const playerUrl = session?.playerUrl || "https://nextgencloudfabric.com/";

    const res = await fetchWithRetry(url, {
      headers: {
        ...chromeHeaders({ referer: playerUrl, origin: "https://nextgencloudfabric.com", mode: "api" }),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    }, { attempts: 2, baseDelay: 250, maxDelay: 800 });
    if (!res || !res.ok) return null;

    const data = await res.json();
    if (data.status_code !== "200" || !data.data?.stream_urls?.length) return null;

    const referer = playerUrl;
    const variants = await extractVariants(data.data.stream_urls[0], referer, cookieHeader);
    if (!variants) return null;

    return variants.map(v => ({
      url: v.proxyUrl,
      quality: v.quality,
      originalUrl: "",
      referer,
      cookie: cookieHeader,
    }));
  } catch (err) {
    console.error(`[scraper] vidapi direct error:`, err.message);
    return null;
  }
}

const vidlinkStreamCache = new Map();
const vidlinkEncCache = new Map();
const VIDLINK_STREAM_TTL = 5 * 60 * 1000;
const VIDLINK_ENC_TTL = 3 * 60 * 1000;
const VIDLINK_LINK_MAX_AGE = 72 * 3600 * 1000;
const VIDLINK_LIMIT_CAPTION = "Limit reached - link expired, will refresh later";

function vidlinkLinkNote(url) {
  const m = url && url.match(/t=(\d{9,})/);
  if (!m) return undefined;
  const issued = Number(m[1]) * 1000;
  if (!Number.isFinite(issued)) return undefined;
  return Date.now() - issued > VIDLINK_LINK_MAX_AGE ? VIDLINK_LIMIT_CAPTION : undefined;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) {
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

function buildProxyUrl(targetUrl, referer, cookie) {
  const proxyOrigin = globalThis.__proxyOrigin || "http://localhost:8788";
  const proxyUrl = new URL("/proxy/hls/stream.m3u8", proxyOrigin);
  proxyUrl.searchParams.set("url", targetUrl);
  if (referer) proxyUrl.searchParams.set("referer", referer);
  if (cookie) proxyUrl.searchParams.set("cookie", cookie);
  return proxyUrl.href;
}

async function getVidlinkEncodedId(tmdbId, preferEncDec = false) {
  const key = String(tmdbId);
  const cacheKey = `${preferEncDec ? "ed" : "local"}:${key}`;
  const cached = cacheGet(vidlinkEncCache, cacheKey);
  if (cached) return cached;

  let encoded = null;
  if (!preferEncDec) {
    try {
      encoded = encryptVidlinkToken(tmdbId);
    } catch (err) {
      console.error(`[scraper] vidlink in-code encrypt error:`, err.message);
    }
  }

  if (!encoded) {
    try {
      const encRes = await fetchWithRetry(`${ENC_VIDLINK_URL}?text=${encodeURIComponent(key)}`, {
        headers: chromeHeaders({ mode: "api" }),
      });
      if (encRes && encRes.ok) {
        const encData = await encRes.json().catch(() => null);
        encoded = encData?.result || null;
      }
    } catch (err) {
      console.error(`[scraper] vidlink enc-dec fallback error:`, err.message);
    }
  }

  if (!encoded) return null;
  cacheSet(vidlinkEncCache, cacheKey, encoded, VIDLINK_ENC_TTL);
  return encoded;
}

async function probeStreamUrl(url, referer) {
  const res = await fetchWithTimeout(url, {
    headers: {
      ...chromeHeaders({ referer, mode: "api" }),
      range: "bytes=0-0",
    },
  }, 4000);
  if (!res) return false;
  return res.status === 200 || res.status === 206 || res.status === 304;
}

async function tryVidlink(imdbId, type, season, episode) {
  const cacheKey = `${type}:${imdbId}:${season ?? ""}:${episode ?? ""}`;
  const cached = cacheGet(vidlinkStreamCache, cacheKey);
  if (cached) return cached;

  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;

    const fetchVidlink = async (enc) => {
      const apiUrl = type === "series"
        ? `${VIDLINK_BASE}/api/b/tv/${enc}/${season}/${episode}?multiLang=0`
        : `${VIDLINK_BASE}/api/b/movie/${enc}?multiLang=0`;
      return fetchWithRetry(apiUrl, {
        headers: chromeHeaders({ referer: VIDLINK_BASE, origin: VIDLINK_BASE, mode: "api", site: "same-origin" }),
      });
    };

    const encoded = await getVidlinkEncodedId(tmdb.id);
    if (!encoded) return null;

    let res = await fetchVidlink(encoded);
    if (!res || !res.ok) {
      const fallbackEnc = await getVidlinkEncodedId(tmdb.id, true);
      if (fallbackEnc && fallbackEnc !== encoded) {
        res = await fetchVidlink(fallbackEnc);
      }
    }
    if (!res || !res.ok) return null;

    const data = await res.json();
    const streamData = data?.stream;
    if (!streamData) return null;

    const corsAllowed = Array.isArray(streamData.flags) && streamData.flags.includes("cors-allowed");
    const captions = Array.isArray(streamData.captions) ? streamData.captions : undefined;

    let streams = null;

    if (streamData.qualities) {
      const entries = [];
      for (const [quality, info] of Object.entries(streamData.qualities)) {
        if (!info?.url) continue;
        const headerObj = info.headers && Object.keys(info.headers).length ? info.headers : null;
        entries.push({
          quality: quality + "p",
          url: info.url,
          needsProxy: (info.requiresProxy === true && !corsAllowed) || !!headerObj,
          headerObj,
        });
      }
      if (entries.length) {
        const probes = await Promise.all(entries.map(e => probeStreamUrl(e.url, VIDLINK_BASE + "/")));
        const passing = entries.filter((_, i) => probes[i]);
        const chosen = passing.length ? passing : entries;
        streams = chosen.map(e => {
          const note = vidlinkLinkNote(e.url);
          return {
            url: e.needsProxy ? buildProxyUrl(e.url, VIDLINK_BASE + "/") : e.url,
            quality: e.quality,
            referer: VIDLINK_BASE + "/",
            ...(e.headerObj && !e.needsProxy ? { headers: e.headerObj } : {}),
            ...(note ? { note } : {}),
          };
        });
      }
    } else {
      const playlist = streamData.playlist || streamData.stream || streamData.url || streamData.sourceId;
      if (playlist) {
        const note = vidlinkLinkNote(playlist);
        streams = [{
          url: playlist,
          quality: "Auto",
          referer: VIDLINK_BASE + "/",
          ...(note ? { note } : {}),
        }];
      }
    }

    if (!streams || !streams.length) return null;

    if (captions) {
      for (const s of streams) s.captions = captions;
    }

    cacheSet(vidlinkStreamCache, cacheKey, streams, VIDLINK_STREAM_TTL);
    return streams;
  } catch (err) {
    console.error(`[scraper] vidlink error:`, err.message);
    return null;
  }
}

// When running on Cloudflare (phone offline), only these sources are reachable
// from CF datacenter IPs. Every other source blocks or silently rejects them.
const CF_SAFE_SOURCES = new Set(["Vidlink"]);

function buildSourceFunctions(imdbId, type, season, episode) {
  const all = [
    { name: "VidAPI", fn: () => tryVidApiDirect(imdbId, type, season, episode) },
    { name: "Vidlink", fn: () => tryVidlink(imdbId, type, season, episode) },
    { name: "VixSrc", fn: () => tryVixSrc(imdbId, type, season, episode) },
    { name: "4KHDHub", fn: () => try4KHDHub(imdbId, type, season, episode) },
    { name: "HDHub4u", fn: () => tryHDHub4u(imdbId, type, season, episode) },
    { name: "MoviesDrive", fn: () => tryMoviesDrive(imdbId, type, season, episode) },
    { name: "HiAnime", fn: () => tryHiAnime(imdbId, type, season, episode) },
  ];
  return globalThis.__cfSafeOnly ? all.filter(s => CF_SAFE_SOURCES.has(s.name)) : all;
}

export async function scrapeStreams({ type, imdbId, season, episode }, batchTimeout = BATCH_TIMEOUT) {
  const sourceFunctions = buildSourceFunctions(imdbId, type, season, episode);

  const settled = new Array(sourceFunctions.length).fill(null);
  const promises = sourceFunctions.map((sf, i) =>
    (async () => {
      try {
        const v = await sf.fn();
        settled[i] = { status: "fulfilled", value: v };
      } catch (e) {
        settled[i] = { status: "rejected", reason: e };
      }
    })()
  );

  await Promise.race([Promise.all(promises), sleep(batchTimeout)]);

  const allStreams = [];
  const seenUrls = new Set();

  for (let i = 0; i < sourceFunctions.length; i++) {
    const sf = sourceFunctions[i];
    const result = settled[i];
    if (!result || result.status !== "fulfilled" || !result.value?.length) continue;
    for (const s of result.value) {
      const key = s.url || s.originalUrl;
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      allStreams.push({ ...s, source: sf.name });
    }
  }

  return allStreams;
}

async function probeVidlink(imdbId, type, season, episode) {
  const steps = {};
  const tmdb = await convertImdbToTmdb(imdbId);
  steps.tmdb = tmdb ? { ok: true, title: tmdb.title || tmdb.name, id: tmdb.id } : { ok: false, error: "tmdb lookup failed" };
  if (!tmdb) return { steps, decoded: null, playlist: null };
  const encRes = await fetchWithTimeout(`${ENC_VIDLINK_URL}?text=${encodeURIComponent(String(tmdb.id))}`, { headers: chromeHeaders({ mode: "api" }) });
  steps.encDec = encRes ? { ok: true, status: encRes.status } : { ok: false, error: "enc-dec.app unreachable" };
  if (!encRes) return { steps, decoded: null, playlist: null };
  let encData;
  try { encData = await encRes.json(); } catch { encData = null; }
  steps.encDecData = encData ? { keys: Object.keys(encData) } : { ok: false, error: "invalid json" };
  const encoded = encData?.result;
  steps.encoded = encoded ? { ok: true, value: encoded.slice(0, 20) + "..." } : { ok: false, error: "no result field" };
  if (!encoded) return { steps, decoded: null, playlist: null };
  const apiUrl = type === "series"
    ? `${VIDLINK_BASE}/api/b/tv/${encoded}/${season}/${episode}?multiLang=0`
    : `${VIDLINK_BASE}/api/b/movie/${encoded}?multiLang=0`;
  const res = await fetchWithTimeout(apiUrl, { headers: chromeHeaders({ referer: VIDLINK_BASE, origin: VIDLINK_BASE, mode: "api", site: "same-origin" }) });
  steps.vidlinkApi = res ? { ok: true, status: res.status } : { ok: false, error: "vidlink.pro unreachable" };
  if (!res) return { steps, decoded: encoded, playlist: null };
  let data;
  try { data = await res.json(); } catch { data = null; }
  steps.vidlinkData = data ? { keys: Object.keys(data), hasStream: !!data?.stream } : { ok: false, error: "invalid json" };
  steps.streamObject = data?.stream;
  if (data?.stream) {
    const s = data.stream;
    steps.streamFields = Object.keys(s);
    steps.streamSample = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      steps.streamSample[k] = typeof v === "string" ? v.slice(0, 120) : typeof v === "object" ? `[${v.constructor.name}]` : v;
    }
  }
  const playlist = data?.stream?.playlist || data?.stream?.stream || data?.stream?.url || data?.stream?.sourceId;
  steps.playlist = playlist ? { ok: true, foundIn: playlist === data?.stream?.playlist ? "playlist" : playlist === data?.stream?.stream ? "stream" : playlist === data?.stream?.url ? "url" : "sourceId", preview: (playlist || "").slice(0, 80) } : { ok: false, error: "no playable field found" };
  return { steps, decoded: encoded, playlist };
}

async function probeVixsrc(imdbId, type, season, episode) {
  const steps = {};
  const tmdb = await convertImdbToTmdb(imdbId);
  steps.tmdb = tmdb ? { ok: true, title: tmdb.title || tmdb.name, id: tmdb.id } : { ok: false, error: "tmdb lookup failed" };
  if (!tmdb) return { steps, api: null, playerUrl: null };

  const apiUrl = type === "series"
    ? `https://vixsrc.to/api/tv/${tmdb.id}/${season}/${episode}`
    : `https://vixsrc.to/api/movie/${tmdb.id}`;
  const apiRes = await fetchWithTimeout(apiUrl, { headers: chromeHeaders({ referer: "https://vixsrc.to/", origin: "https://vixsrc.to", mode: "api", site: "same-origin" }) });
  steps.api = apiRes ? { ok: true, status: apiRes.status, url: apiUrl } : { ok: false, error: "unreachable" };
  if (!apiRes) return { steps, data: null, playerUrl: null };
  let apiData;
  try { apiData = await apiRes.json(); } catch { apiData = null; }
  steps.apiData = apiData ? { keys: Object.keys(apiData), src: apiData.src } : { ok: false, error: "invalid json" };
  if (!apiData?.src) return { steps, data: apiData, playerUrl: null };
  const playerUrl = `https://vixsrc.to${apiData.src}`;
  steps.playerUrl = playerUrl;
  const playerRes = await fetchWithTimeout(playerUrl, { headers: chromeHeaders({ referer: "https://vixsrc.to/", origin: "https://vixsrc.to", mode: "html", site: "same-origin" }) });
  steps.playerPage = playerRes ? { ok: true, status: playerRes.status } : { ok: false, error: "unreachable" };
  if (!playerRes) return { steps, data: apiData, playerUrl };
  const html = await playerRes.text();
  const token = html.match(/['"]token['"]\s*:\s*['"](\w+)['"]/);
  const expires = html.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
  const urlMatch = html.match(/masterPlaylist\s*=\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/);
  steps.extracted = {
    token: token ? token[1].slice(0, 20) + "..." : null,
    expires: expires ? expires[1] : null,
    url: urlMatch ? urlMatch[1].slice(0, 60) + "..." : null,
    canPlayFHD: html.includes("canPlayFHD = true"),
  };
  return { steps, data: apiData, playerUrl };
}

export async function debugSources({ type, imdbId, season, episode }) {
  const sourceFunctions = buildSourceFunctions(imdbId, type, season, episode);

  const results = [];
  for (const sf of sourceFunctions) {
    const start = Date.now();
    try {
      const streams = await sf.fn();
      results.push({
        source: sf.name,
        status: streams && streams.length ? "success" : "empty",
        streamCount: streams ? streams.length : 0,
        duration: Date.now() - start,
        error: null,
        sampleUrls: (streams || []).slice(0, 2).map(s => s.url?.slice(0, 150)),
      });
    } catch (err) {
      results.push({
        source: sf.name,
        status: "error",
        streamCount: 0,
        duration: Date.now() - start,
        error: err.message || String(err),
        stack: (err.stack || "").split("\n").slice(0, 3).join(" | "),
        sampleUrls: [],
      });
    }
  }

  const [vidlinkProbe, vixsrcProbe] = await Promise.all([
    probeVidlink(imdbId, type, season, episode),
    probeVixsrc(imdbId, type, season, episode),
  ]);
  const vidlinkResult = results.find(r => r.source === "Vidlink");
  const vixsrcResult = results.find(r => r.source === "VixSrc");
  if (vidlinkResult) vidlinkResult.vidlinkProbe = vidlinkProbe;
  if (vixsrcResult) vixsrcResult.vixsrcProbe = vixsrcProbe;

  return results;
}
