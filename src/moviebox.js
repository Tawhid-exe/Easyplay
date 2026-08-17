import CryptoJS from "crypto-js";
import { fetchWithTimeout, convertImdbToTmdb } from "./utils.js";
import { MOVIEBOX_ENABLED, MOVIEBOX_SECRET, MOVIEBOX_HOSTS } from "./config.js";

const BASE_URL = "https://api.inmoviebox.com/wefeed-mobile-bff";
const MOBILE_UA = "com.community.mbox.in/50020042 (Linux; Android 16; sdk_gphone64_x86_64; Cronet/133.0.6876.3)";

const SEARCH_TTL = 20 * 60 * 1000;
const PLAY_TTL = 5 * 60 * 1000;

const searchCache = new Map();
const playCache = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) { map.delete(key); return null; }
  return hit.value;
}

function cacheSet(map, key, value, ttl) {
  if (map.size >= 400) { const oldest = map.keys().next().value; if (oldest) map.delete(oldest); }
  map.set(key, { ts: Date.now(), ttl, value });
}

function md5Hex(data) {
  if (!data) return "";
  return CryptoJS.MD5(typeof data === "string" ? data : data).toString(CryptoJS.enc.Hex);
}

function signRequest(keyB64, url, method = "GET", body = "") {
  const timestamp = Date.now();
  const u = new URL(url);
  const path = u.pathname || "";
  const params = [];
  u.searchParams.forEach((value, key) => {
    params.push([decodeURIComponent(key), decodeURIComponent(value)]);
  });
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalUrl = qs ? `${path}?${qs}` : path;

  let bodyHash = "";
  let bodyLength = "";
  if (body) {
    const bodyUtf8 = CryptoJS.enc.Utf8.parse(body);
    bodyLength = String(bodyUtf8.sigBytes);
    bodyHash = md5Hex(bodyUtf8);
  }

  const canonical = [
    method.toUpperCase(),
    "application/json",
    "application/json; charset=utf-8",
    bodyLength,
    String(timestamp),
    bodyHash,
    canonicalUrl,
  ].join("\n");

  const key = CryptoJS.enc.Base64.parse(keyB64);
  const sig = CryptoJS.HmacMD5(canonical, key).toString(CryptoJS.enc.Base64);

  const xTrSignature = `${timestamp}|2|${sig}`;
  const rev = String(timestamp).split("").reverse().join("");
  const xClientToken = `${timestamp},${md5Hex(rev)}`;

  return { xTrSignature, xClientToken };
}

async function apiRequest(url, method = "GET", body = "") {
  const { xTrSignature, xClientToken } = signRequest(MOVIEBOX_SECRET, url, method, body);

  const headers = {
    "User-Agent": MOBILE_UA,
    "Accept": "application/json",
    "Content-Type": "application/json; charset=utf-8",
    "x-client-info": JSON.stringify({ package_name: "com.community.mbox.in" }),
    "x-client-token": xClientToken,
    "x-tr-signature": xTrSignature,
    "x-client-status": "0",
  };

  const opts = { method, headers };
  if (method === "POST" && body) opts.body = body;

  return fetchWithTimeout(url, opts, 10000);
}

async function search(keyword) {
  const cacheKey = keyword;
  const cached = cacheGet(searchCache, cacheKey, SEARCH_TTL);
  if (cached) return cached;

  const url = `${BASE_URL}/subject-api/search/v2`;
  const body = JSON.stringify({ page: 1, perPage: 10, keyword });

  const res = await apiRequest(url, "POST", body);
  if (!res) return null;

  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) return null;

  const subjects = [];
  const results = json.data?.results || [];
  for (const r of results) {
    if (Array.isArray(r.subjects)) subjects.push(...r.subjects);
  }

  cacheSet(searchCache, cacheKey, subjects, SEARCH_TTL);
  return subjects;
}

async function getPlayInfo(subjectId, season, episode) {
  const cacheKey = `${subjectId}:${season ?? ""}:${episode ?? ""}`;
  const cached = cacheGet(playCache, cacheKey, PLAY_TTL);
  if (cached) return cached;

  let url;
  if (season != null && episode != null) {
    url = `${BASE_URL}/subject-api/play-info?subjectId=${subjectId}&se=${season}&ep=${episode}`;
  } else {
    url = `${BASE_URL}/subject-api/play-info?subjectId=${subjectId}`;
  }

  const res = await apiRequest(url);
  if (!res) return null;

  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) return null;

  const data = json.data || {};
  const streams = data.streams || data.playInfo?.streams || [];

  for (const s of streams) {
    if (typeof s.resolutions === "string") {
      s.resolutions = s.resolutions.split(",").map(v => v.trim()).filter(Boolean);
    } else if (s.resolution && !Array.isArray(s.resolutions)) {
      s.resolutions = [s.resolution];
    } else if (!s.resolutions) {
      s.resolutions = [];
    }
  }

  cacheSet(playCache, cacheKey, streams, PLAY_TTL);
  return streams;
}

function titleWords(title) {
  return (String(title).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length >= 2);
}

function matchScore(item, targetTitle, targetYear) {
  const itemTitle = String(item.title || "").toLowerCase();
  if (!itemTitle) return 0;
  const q = String(targetTitle).toLowerCase();
  let score = 0;
  if (itemTitle === q) score += 20;
  else if (itemTitle.includes(q) || q.includes(itemTitle)) score += 10;
  else {
    const iw = new Set(titleWords(item.title));
    const tw = titleWords(targetTitle);
    const common = tw.filter(w => iw.has(w));
    if (tw.length > 0) score += Math.round((common.length / tw.length) * 8);
  }
  if (targetYear) {
    const ctx = `${item.title || ""} ${item.releaseDate || ""}`.toLowerCase();
    if (ctx.includes(String(targetYear))) score += 5;
  }
  return score;
}

function findBestMatch(items, title, year, type) {
  if (!items || !items.length) return null;
  const typeMap = { movie: 1, series: 2 };
  let filtered = items;
  if (typeMap[type]) {
    const typed = items.filter(i => i.subjectType === typeMap[type]);
    if (typed.length) filtered = typed;
  }
  let best = null;
  let bestScore = 0;
  for (const item of filtered) {
    const score = matchScore(item, title, year);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 8 ? best : filtered[0];
}

function extractQualityLabel(stream) {
  const candidates = [
    stream.quality, stream.definition, stream.label,
    stream.videoQuality, stream.profile,
  ].filter(Boolean);
  if (Array.isArray(stream.resolutions) && stream.resolutions.length) {
    candidates.push(...stream.resolutions.map(String));
  }
  for (const c of candidates) {
    const s = String(c).toLowerCase();
    if (s.includes("2160") || s.includes("4k")) return "2160p";
    if (s.includes("1080")) return "1080p";
    if (s.includes("720")) return "720p";
    if (s.includes("480")) return "480p";
  }
  return "Auto";
}

function extractStreams(streams) {
  if (!streams || !streams.length) return [];
  const result = [];
  for (const s of streams) {
    if (!s.url) continue;
    result.push({
      url: s.url,
      quality: extractQualityLabel(s),
      name: s.audioTrack?.language || s.language || undefined,
    });
  }
  return result;
}

async function tryHost(imdbId, type, season, episode) {
  const tmdb = await convertImdbToTmdb(imdbId);
  if (!tmdb) return null;

  const title = tmdb.title || tmdb.name;
  if (!title) return null;

  const year = tmdb.release_date
    ? parseInt(tmdb.release_date.split("-")[0], 10)
    : tmdb.first_air_date
      ? parseInt(tmdb.first_air_date.split("-")[0], 10)
      : null;

  const items = await search(year ? `${title} ${year}` : title);
  if (!items || !items.length) return null;

  const match = findBestMatch(items, title, year, type);
  if (!match || !match.subjectId) return null;

  const streams = await getPlayInfo(
    match.subjectId,
    season != null ? season : undefined,
    season != null ? (episode || 1) : undefined,
  );
  return extractStreams(streams);
}

export async function tryMoviebox(imdbId, type, season, episode) {
  if (!MOVIEBOX_ENABLED) return null;

  const cacheKey = `${type}:${imdbId}:${season ?? ""}:${episode ?? ""}`;
  const cached = cacheGet(playCache, cacheKey, PLAY_TTL);
  if (cached) return cached;

  try {
    const streams = await tryHost(imdbId, type, season, episode);
    if (streams && streams.length) {
      cacheSet(playCache, cacheKey, streams, PLAY_TTL);
      return streams;
    }
  } catch (err) {
    console.error("[scraper] moviebox error:", err.message);
  }

  return null;
}
