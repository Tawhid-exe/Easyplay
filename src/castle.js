import CryptoJS from "crypto-js";
import { fetchWithTimeout, fetchWithRetry, convertImdbToTmdb } from "./utils.js";
import { CASTLE_ENABLED, CASTLE_API_BASE } from "./config.js";

const CHANNEL = "IndiaA";
const CLIENT = "1";
const LANG = "en-US";
const PKG = "com.external.castle";
const APK_SIGN_KEY = "ED0955EB04E67A1D9F3305B95454FED485261475";
const CASTLE_SUFFIX = "T!BgJB";
const MAX_RESOLUTIONS = 3;
const MAX_VIDEO_REQUESTS = 6;

const API_HEADERS = {
  "user-agent": "okhttp/4.9.3",
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  connection: "Keep-Alive",
  referer: CASTLE_API_BASE,
};

const KEY_TTL = 6 * 60 * 60 * 1000;
const SEARCH_TTL = 12 * 60 * 60 * 1000;
const DETAILS_TTL = 12 * 60 * 60 * 1000;
const STREAM_TTL = 5 * 60 * 1000;

const keyCache = new Map();
const searchCache = new Map();
const detailsCache = new Map();
const streamCache = new Map();

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

function makeApiUrl(path) {
  return `${CASTLE_API_BASE}${path}`;
}

async function apiFetch(url, { method = "GET", body } = {}) {
  const res = await fetchWithRetry(url, {
    method,
    headers: { ...API_HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, { attempts: 2, baseDelay: 300, maxDelay: 900 });
  if (!res) return null;
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const json = JSON.parse(trimmed);
    if (json && json.data && typeof json.data === "string") return json.data.trim();
  } catch {}
  return trimmed;
}

function decryptCastle(encryptedB64, securityKeyB64) {
  try {
    const keyWords = CryptoJS.enc.Base64.parse(securityKeyB64);
    const suffixWords = CryptoJS.enc.Utf8.parse(CASTLE_SUFFIX);
    const keyMaterial = keyWords.concat(suffixWords);

    let finalKey;
    if (keyMaterial.sigBytes < 16) {
      const padding = CryptoJS.lib.WordArray.create(new Array(16 - keyMaterial.sigBytes).fill(0));
      finalKey = keyMaterial.concat(padding);
    } else if (keyMaterial.sigBytes > 16) {
      finalKey = CryptoJS.lib.WordArray.create(keyMaterial.words.slice(0, 4), 16);
    } else {
      finalKey = keyMaterial;
    }

    const decrypted = CryptoJS.AES.decrypt(encryptedB64, finalKey, {
      iv: finalKey,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (!result) return null;
    return result;
  } catch (err) {
    console.error(`[scraper] castle decrypt error:`, err.message);
    return null;
  }
}

async function decryptResponse(cipher, securityKey) {
  const plain = decryptCastle(cipher, securityKey);
  if (!plain) return null;
  try {
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

async function getSecurityKey() {
  const cached = cacheGet(keyCache, "key", KEY_TTL);
  if (cached) return cached;
  const url = makeApiUrl(`/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`);
  const res = await fetchWithRetry(url, { headers: API_HEADERS }, { attempts: 2, baseDelay: 300, maxDelay: 900 });
  if (!res) return null;
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 200 || !json.data) return null;
  cacheSet(keyCache, "key", json.data, KEY_TTL);
  return json.data;
}

async function searchCastle(securityKey, keyword) {
  const params = new URLSearchParams({
    channel: CHANNEL,
    clientType: CLIENT,
    keyword,
    lang: LANG,
    mode: "1",
    packageName: PKG,
    page: "1",
    size: "30",
  });
  const url = makeApiUrl(`/film-api/v1.1.0/movie/searchByKeyword?${params}`);
  const cipher = await apiFetch(url);
  if (!cipher) return [];
  const data = await decryptResponse(cipher, securityKey);
  if (!data) return [];
  const rows = data?.data?.rows || data?.rows || [];
  return Array.isArray(rows) ? rows : [];
}

async function getDetails(securityKey, movieId) {
  const url = makeApiUrl(`/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`);
  const cipher = await apiFetch(url);
  if (!cipher) return null;
  const data = await decryptResponse(cipher, securityKey);
  return data?.data || data || null;
}

async function getVideo(securityKey, movieId, episodeId, resolution, languageId) {
  const params = new URLSearchParams({ clientType: CLIENT, packageName: PKG, channel: CHANNEL, lang: LANG });
  const url = makeApiUrl(`/film-api/v2.0.1/movie/getVideo2?${params}`);
  const body = {
    mode: "1",
    appMarket: "GuanWang",
    clientType: CLIENT,
    woolUser: "false",
    apkSignKey: APK_SIGN_KEY,
    androidVersion: "13",
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: "true",
    resolution: String(resolution),
    packageName: PKG,
  };
  if (languageId) body.languageId = String(languageId);
  const cipher = await apiFetch(url, { method: "POST", body });
  if (!cipher) return null;
  const data = await decryptResponse(cipher, securityKey);
  return data?.data || data || null;
}

function titleWords(title) {
  return (String(title).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
}

function matchScore(row, title, year) {
  const rowTitle = String(row.title || row.name || "").toLowerCase();
  if (!rowTitle) return 0;
  const q = String(title).toLowerCase();
  let score = 0;
  if (rowTitle === q) score += 20;
  else if (rowTitle.includes(q) || q.includes(rowTitle)) score += 10;
  if (year) {
    const ctx = `${rowTitle} ${row.description || ""} ${row.year || ""} ${row.publishTime || ""}`.toLowerCase();
    if (ctx.includes(String(year))) score += 5;
  }
  return score;
}

function findCastleMovieId(rows, title, year) {
  if (!rows.length) return null;
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = matchScore(row, title, year);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  const picked = bestScore >= 8 ? best : rows[0];
  return String(picked.id || picked.redirectId || picked.redirectIdStr || "");
}

function normalizeQuality(desc) {
  if (!desc) return null;
  const clean = String(desc).replace(/^(sd|hd|fhd|uhd)\s*/i, "").trim().toLowerCase();
  return clean || null;
}

function originOf(url) {
  try {
    return new URL(url).origin + "/";
  } catch {
    return undefined;
  }
}

function toCaptions(subtitles) {
  if (!Array.isArray(subtitles)) return null;
  const caps = subtitles
    .filter((s) => s && s.url)
    .map((s, i) => ({
      id: `${s.abbreviate || s.title || "sub"}-${i}`,
      url: s.url,
      lang: s.abbreviate || s.title || "English",
    }));
  return caps.length ? caps : null;
}

async function fetchAllVideoStreams(securityKey, movieId, episodeId, resolutions, tracks) {
  const jobs = [];
  const individualTracks = (tracks || []).filter((t) => t.existIndividualVideo && t.languageId);

  if (individualTracks.length) {
    for (const track of individualTracks.slice(0, 2)) {
      for (const res of resolutions) {
        jobs.push({
          resolution: res,
          languageId: track.languageId,
          langName: track.languageName || track.abbreviate || "English",
          captions: track.subtitles,
        });
      }
    }
  } else {
    for (const res of resolutions) {
      jobs.push({ resolution: res, languageId: null, langName: null, captions: null });
    }
  }

  const capped = jobs.slice(0, MAX_VIDEO_REQUESTS);
  const results = await Promise.allSettled(
    capped.map((job) => getVideo(securityKey, movieId, episodeId, job.resolution.resolution, job.languageId))
  );

  const streams = [];
  const seenUrls = new Set();
  results.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    const data = result.value;
    const job = capped[i];
    if (!data || !data.videoUrl) return;
    const key = data.videoUrl.split("?")[0];
    if (seenUrls.has(key)) return;
    seenUrls.add(key);

    const qual = normalizeQuality(job.resolution.resolutionDescription) || normalizeQuality(data.resolutionDescription);
    streams.push({
      url: data.videoUrl,
      quality: qual || "Auto",
      name: job.langName || undefined,
      referer: originOf(data.videoUrl),
      captions: toCaptions(job.captions || data.subtitles),
    });
  });

  streams.sort((a, b) => {
    const qa = parseInt(a.quality, 10) || 0;
    const qb = parseInt(b.quality, 10) || 0;
    return qb - qa;
  });
  return streams;
}

export async function tryCastle(imdbId, type, season, episode) {
  if (!CASTLE_ENABLED) return null;
  const cacheKey = `${type}:${imdbId}:${season ?? ""}:${episode ?? ""}`;
  const cached = cacheGet(streamCache, cacheKey, STREAM_TTL);
  if (cached) return cached;

  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;
    const title = tmdb.title || tmdb.name;
    if (!title) return null;
    const year = tmdb.release_date
      ? parseInt(tmdb.release_date.split("-")[0], 10)
      : tmdb.first_air_date
        ? parseInt(tmdb.first_air_date.split("-")[0], 10)
        : null;

    const securityKey = await getSecurityKey();
    if (!securityKey) return null;

    const searchKey = `${title}|${year ?? ""}`;
    let rows = cacheGet(searchCache, searchKey, SEARCH_TTL);
    if (!rows) {
      rows = await searchCastle(securityKey, year ? `${title} ${year}` : title);
      if (rows.length) cacheSet(searchCache, searchKey, rows, SEARCH_TTL);
    }
    const movieId = findCastleMovieId(rows, title, year);
    if (!movieId) return null;

    let movieIdKey = movieId;
    let details = cacheGet(detailsCache, movieIdKey, DETAILS_TTL);
    if (!details) {
      details = await getDetails(securityKey, movieIdKey);
      if (details) cacheSet(detailsCache, movieIdKey, details, DETAILS_TTL);
    }
    if (!details) return null;

    if (type === "series" && season != null) {
      const seasons = details.seasons || [];
      const seasonRow = seasons.find((s) => Number(s.number) === Number(season));
      if (seasonRow && seasonRow.movieId && String(seasonRow.movieId) !== movieIdKey) {
        movieIdKey = String(seasonRow.movieId);
        details = cacheGet(detailsCache, movieIdKey, DETAILS_TTL);
        if (!details) {
          details = await getDetails(securityKey, movieIdKey);
          if (details) cacheSet(detailsCache, movieIdKey, details, DETAILS_TTL);
        }
        if (!details) return null;
      }
    }

    const episodes = details.episodes || [];
    if (!episodes.length) return null;

    let target = null;
    if (type === "series" && episode != null) {
      target = episodes.find((e) => Number(e.number) === Number(episode)) || null;
    }
    if (!target) target = episodes[0];
    const episodeId = target.id || target.episodeId;
    if (!episodeId) return null;

    let resolutions = (target.videos || [])
      .filter((v) => v && v.resolution != null)
      .sort((a, b) => Number(b.resolution) - Number(a.resolution))
      .slice(0, MAX_RESOLUTIONS);
    if (!resolutions.length) resolutions = [{ resolution: 2, resolutionDescription: "HD 720P" }];

    const streams = await fetchAllVideoStreams(securityKey, movieIdKey, episodeId, resolutions, target.tracks);
    if (!streams.length) return null;

    cacheSet(streamCache, cacheKey, streams, STREAM_TTL);
    return streams;
  } catch (err) {
    console.error(`[scraper] castle error:`, err.message);
    return null;
  }
}
