import { TMDB_FIND_URL, TMDB_API_KEY, FETCH_TIMEOUT, RETRY_ATTEMPTS } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not=A?Brand";v="99"';
const SEC_CH_UA_PLATFORM = '"Windows"';
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const API_ACCEPT = "application/json, text/plain, */*";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch {
    clearTimeout(id);
    return null;
  }
}

export function chromeHeaders({ referer, origin, mode = "html", site = "cross-site", accept } = {}) {
  const isHtml = mode === "html";
  const h = {
    "user-agent": UA,
    accept: accept || (isHtml ? HTML_ACCEPT : API_ACCEPT),
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": SEC_CH_UA_PLATFORM,
    "sec-fetch-dest": isHtml ? "document" : "empty",
    "sec-fetch-mode": isHtml ? "navigate" : "cors",
    "sec-fetch-site": site,
  };
  if (isHtml) h["upgrade-insecure-requests"] = "1";
  if (referer) h.referer = referer;
  if (origin) h.origin = origin;
  return h;
}

export function headers(referer) {
  let origin;
  try {
    origin = referer ? new URL(referer).origin : undefined;
  } catch {
    origin = undefined;
  }
  return chromeHeaders({ referer, origin, mode: "html" });
}

function retryableStatus(status) {
  if (!status) return true;
  return status === 403 || status === 429 || status === 502 || status === 503 || status === 504;
}

export async function fetchWithRetry(url, options = {}, { attempts = RETRY_ATTEMPTS, baseDelay = 300, maxDelay = 1200, timeout = FETCH_TIMEOUT } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchWithTimeout(url, options, timeout);
    if (res && !retryableStatus(res.status)) return res;
    last = res;
    if (i < attempts - 1) {
      let delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
      if (res && res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const secs = retryAfter ? parseInt(retryAfter, 10) : NaN;
        if (!Number.isNaN(secs)) delay = Math.min(secs * 1000, maxDelay);
      }
      await sleep(delay);
    }
  }
  return last;
}

export function extractM3u8(text) {
  const m = text.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/);
  return m ? m[0].replace(/\\/g, "") : null;
}

export function rot13(str) {
  return str.replace(/[a-zA-Z]/g, c => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

export function base64Decode(str) {
  try { return atob(str); } catch { return null; }
}

export function parseSize(text) {
  const m = text.match(/([\d.]+)\s*(TB|GB|MB)/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "TB") return num * 1024;
  if (unit === "GB") return num;
  if (unit === "MB") return num / 1024;
  return null;
}

export function formatSize(size) {
  if (size == null || !Number.isFinite(size)) return "";
  return size >= 1024
    ? `${(size / 1024).toFixed(1)} TB`
    : `${size.toFixed(1)} GB`;
}

export function parseQuality(text) {
  if (/\b2160p\b|2160|(?:^|[^\w])4k\b/i.test(text)) return "2160p";
  if (/\b1080p\b|1080|(?:^|[^\w])fhd\b/i.test(text)) return "1080p";
  if (/\b720p\b|(?:^|[^\w])720\b/i.test(text)) return "720p";
  const m = text.match(/(\d{3,4}p)/i);
  return m ? m[1].toLowerCase() : null;
}

export function extractAll(html, left, right) {
  const results = [];
  let idx = 0;
  while (true) {
    const l = html.indexOf(left, idx);
    if (l === -1) break;
    const r = html.indexOf(right, l + left.length);
    if (r === -1) break;
    results.push(html.slice(l + left.length, r));
    idx = r + right.length;
  }
  return results;
}

export function extractBlocks(html, className) {
  const blocks = [];
  const re = new RegExp(`<div class="${className}[\\s\\S]*?<\\/div>\\s*<\\/div>`, "g");
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[0]);
  return blocks;
}

export function parseCodec(text) {
  if (/HEVC|H\.?265/i.test(text)) return "HEVC";
  if (/H\.?264|AVC/i.test(text)) return "H.264";
  return "";
}

export function parseHdr(text) {
  if (/Dolby\s*Vision|DV[^A-Za-z]|HDR(?:10)?/i.test(text)) return "HDR";
  return "";
}

export function linkPriority(url) {
  if (/r2\.cloudflarestorage|\.(mp4|mkv|avi)(\?|$)/i.test(url)) return 3;
  if (/pixeldrain/i.test(url)) return 2;
  return 1;
}

export async function isSeekable(url, { referer, timeout = 6000 } = {}) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": UA, Referer: referer, range: "bytes=0-0" },
    }, timeout);
    if (!res) return "inconclusive";
    if (res.status === 206 || res.status === 200) return "ok";
    return "dead";
  } catch {
    return "inconclusive";
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const domainCache = new Map();

export async function fetchLiveDomains({ domainsUrl, key = "", fallback = [], ttl = 12 * 60 * 60 * 1000 } = {}) {
  const cached = domainCache.get(domainsUrl);
  if (cached && Date.now() - cached.ts < ttl && cached.urls.length) return cached.urls;
  let urls = [];
  if (domainsUrl) {
    const res = await fetchWithTimeout(domainsUrl, {
      headers: { "user-agent": UA, accept: "application/json" },
    });
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (Array.isArray(data)) {
        urls = data.filter(u => typeof u === "string" && /^https?:/i.test(u));
      } else if (data && typeof data === "object") {
        const foundKey = key
          ? Object.keys(data).find(k => k.toLowerCase().includes(key.toLowerCase()))
          : null;
        const val = foundKey ? data[foundKey] : null;
        const arr = Array.isArray(val) ? val : val ? [val] : [];
        urls = arr.filter(u => typeof u === "string" && /^https?:/i.test(u));
      }
    }
  }
  if (!urls.length) urls = fallback.slice();
  if (urls.length) domainCache.set(domainsUrl, { ts: Date.now(), urls });
  return urls;
}

const tmdbCache = new Map();

export async function convertImdbToTmdb(imdbId) {
  const apiKey = globalThis.__tmdbApiKey || TMDB_API_KEY;
  if (!apiKey || apiKey.startsWith("PASTE_")) return null;
  const cached = tmdbCache.get(imdbId);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(TMDB_FIND_URL(imdbId, apiKey), {
      headers: chromeHeaders({ mode: "api" }),
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const result = data?.movie_results?.[0] || data?.tv_results?.[0] || null;
    if (result) {
      if (tmdbCache.size >= 400) {
        const oldest = tmdbCache.keys().next().value;
        if (oldest) tmdbCache.delete(oldest);
      }
      tmdbCache.set(imdbId, result);
    }
    return result;
  } catch {
    return null;
  }
}
