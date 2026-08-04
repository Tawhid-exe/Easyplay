import { jsonResponse } from "./cors.js";
import addonInterface from "./addon.js";
import { TMDB_API_KEY } from "./config.js";

const QUALITY_KEYS = ["q_240","q_360","q_480","q_720","q_1080","q_2160"];

function readQualityConfig(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/quality_config=([^;]+)/);
  if (m) {
    try { return JSON.parse(decodeURIComponent(m[1])); } catch {}
  }
  return {};
}

function readQueryConfig(url) {
  const config = {};
  for (const key of QUALITY_KEYS) {
    const val = url.searchParams.get(key);
    if (val !== null) config[key] = val;
  }
  return config;
}

function readPrefixConfig(raw) {
  if (!raw) return {};
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return {}; }
}

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

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

export function logRequest(context, extra) {
  try {
    const kv = context?.env?.EASYPLAY_KV;
    if (!kv || !context.waitUntil) return;
    const req = context.request;
    const url = new URL(req.url);
    const entry = {
      ts: Date.now(),
      path: url.pathname.slice(0, 200),
      query: url.search.slice(0, 200),
      ua: (req.headers.get("user-agent") || "").slice(0, 160),
      cookie: (req.headers.get("cookie") || "").slice(0, 160),
      country: req.headers.get("cf-ipcountry") || "",
      ...(extra || {}),
    };
    const key = "reqlog:" + entry.ts + ":" + Math.random().toString(36).slice(2, 8);
    context.waitUntil(kv.put(key, JSON.stringify(entry), { expirationTtl: 3600 }).catch(() => {}));
  } catch {}
}

export async function handleStream(context, prefixConfigRaw) {
  const { type, id } = context.params;
  const cleanId = decodeURIComponent(String(id)).replace(/\.json$/, "");
  const url = new URL(context.request.url);
  const origin = url.origin;

  const kv = context.env?.EASYPLAY_KV;
  const phoneUrl = kv ? await kv.get("phone_url") : null;

  if (phoneUrl) {
    try {
      const streams = await relayToPhone(phoneUrl, url, context.request);
      logRequest(context, { handledBy: "relay", configPrefix: !!prefixConfigRaw });
      return jsonResponse({ streams: rewriteForRemote(streams, phoneUrl) });
    } catch (err) {
      console.error(`[stream] relay failed (${phoneUrl}):`, err.message);
    }
  }

  globalThis.__proxyOrigin = origin;
  globalThis.__tmdbApiKey = context.env?.TMDB_API_KEY || TMDB_API_KEY;
  globalThis.__cfSafeOnly = true;
  globalThis.__kv = context.env?.EASYPLAY_KV || null;
  globalThis.__pendingKvPuts = [];

  const config = {
    ...readQualityConfig(context.request),
    ...readPrefixConfig(prefixConfigRaw),
    ...readQueryConfig(url),
  };
  logRequest(context, { handledBy: "fallback", configPrefix: !!prefixConfigRaw });
  const started = Date.now();
  let streams = [];
  let error = null;
  try {
    const result = await addonInterface.get("stream", type, cleanId, {}, config);
    streams = result?.streams || [];
  } catch (err) {
    streams = [];
    error = err.message || String(err);
  }
  const pending = globalThis.__pendingKvPuts || [];
  globalThis.__pendingKvPuts = [];
  for (const p of pending) {
    try { context.waitUntil(p.catch(() => {})); } catch {}
  }
  const fixed = streams.map(s => ({
    ...s,
    url: s.url.startsWith("/") ? origin + s.url : s.url,
  }));
  logRequest(context, {
    handledBy: "fallback",
    configPrefix: !!prefixConfigRaw,
    streamsFound: fixed.length,
    durationMs: Date.now() - started,
    error,
  });
  return jsonResponse({ streams: fixed });
}
