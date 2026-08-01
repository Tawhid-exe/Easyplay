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

export async function convertImdbToTmdb(imdbId) {
  const apiKey = globalThis.__tmdbApiKey || TMDB_API_KEY;
  if (!apiKey || apiKey.startsWith("PASTE_")) return null;
  try {
    const res = await fetchWithTimeout(TMDB_FIND_URL(imdbId, apiKey), {
      headers: chromeHeaders({ mode: "api" }),
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data?.movie_results?.[0] || data?.tv_results?.[0] || null;
  } catch {
    return null;
  }
}
