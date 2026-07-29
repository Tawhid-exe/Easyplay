import { TMDB_FIND_URL } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const FETCH_TIMEOUT = 10000;

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

export function headers(referer) {
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: referer || "https://nextgencloudfabric.com/",
  };
}

export function extractM3u8(text) {
  const m = text.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/);
  return m ? m[0].replace(/\\/g, "") : null;
}

export async function convertImdbToTmdb(imdbId) {
  const apiKey = globalThis.__tmdbApiKey;
  if (!apiKey) return null;
  try {
    const res = await fetchWithTimeout(TMDB_FIND_URL(imdbId, apiKey), {
      headers: { "User-Agent": UA },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data?.movie_results?.[0] || data?.tv_results?.[0] || null;
  } catch {
    return null;
  }
}
