import { jsonResponse, handleOptions } from "../../../src/cors.js";
import addonInterface from "../../../src/addon.js";

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

export async function onRequestGet(context) {
  try {
    const { type, id } = context.params;
    const cleanId = decodeURIComponent(String(id)).replace(/\.json$/, "");
    const url = new URL(context.request.url);
    const origin = url.origin;
    globalThis.__proxyOrigin = origin;
    globalThis.__tmdbApiKey = context.env.TMDB_API_KEY || "";
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
