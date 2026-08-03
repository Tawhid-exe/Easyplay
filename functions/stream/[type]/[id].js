import { jsonResponse, handleOptions } from "../../../src/cors.js";
import addonInterface from "../../../src/addon.js";
import { TMDB_API_KEY } from "../../../src/config.js";

function readQualityConfig(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/quality_config=([^;]+)/);
  if (m) {
    try { return JSON.parse(decodeURIComponent(m[1])); } catch {}
  }
  return {};
}

const QUALITY_KEYS = ["q_240","q_360","q_480","q_720","q_1080","q_2160"];

function readQueryConfig(url) {
  const config = {};
  for (const key of QUALITY_KEYS) {
    const val = url.searchParams.get(key);
    if (val !== null) config[key] = val;
  }
  return config;
}

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

// The phone runs on a residential IP and returns playable URLs. CDN links pass
// through untouched; anything pointing at the phone's LAN address (or relative)
// is rewritten to the phone's public tunnel URL so remote players can fetch it.
function rewriteForRemote(streams, phoneUrl) {
  const phoneOrigin = new URL(phoneUrl).origin;
  return streams.map(s => {
    let url = s.url;
    if (!url) return s;
    if (url.startsWith("/")) {
      url = phoneOrigin + url;
    } else {
      try {
        const u = new URL(url);
        if (u.protocol === "http:" && PRIVATE_HOST.test(u.hostname.split(":")[0])) {
          url = phoneOrigin + u.pathname + u.search + u.hash;
        }
      } catch {}
    }
    return { ...s, url };
  });
}

async function relayToPhone(phoneUrl, url, request) {
  const target = phoneUrl.replace(/\/+$/, "") + url.pathname + url.search;
  const res = await fetch(target, {
    method: "GET",
    headers: {
      "user-agent": request.headers.get("user-agent") || "Mozilla/5.0",
      cookie: request.headers.get("cookie") || "",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(16000),
  });
  if (!res.ok) throw new Error("phone returned " + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.streams)) throw new Error("bad phone payload");
  return data.streams;
}

export async function onRequestGet(context) {
  try {
    const { type, id } = context.params;
    const cleanId = decodeURIComponent(String(id)).replace(/\.json$/, "");
    const url = new URL(context.request.url);
    const origin = url.origin;

    const kv = context.env.EASYPLAY_KV;
    const phoneUrl = kv ? await kv.get("phone_url") : null;

    if (phoneUrl) {
      try {
        const streams = await relayToPhone(phoneUrl, url, context.request);
        return jsonResponse({ streams: rewriteForRemote(streams, phoneUrl) });
      } catch (err) {
        console.error(`[stream] relay failed (${phoneUrl}):`, err.message);
      }
    }

    // Fallback: phone offline. Only CF-safe sources work from Cloudflare IPs.
    globalThis.__proxyOrigin = origin;
    globalThis.__tmdbApiKey = context.env.TMDB_API_KEY || TMDB_API_KEY;
    globalThis.__cfSafeOnly = true;

    const cookieConfig = readQualityConfig(context.request);
    const queryConfig = readQueryConfig(url);
    const config = { ...cookieConfig, ...queryConfig };
    const { streams } = await addonInterface.get("stream", type, cleanId, {}, config);
    const fixed = streams.map(s => ({
      ...s,
      url: s.url.startsWith("/") ? origin + s.url : s.url,
    }));
    return jsonResponse({ streams: fixed });
  } catch (err) {
    return jsonResponse({ streams: [] });
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
