import { jsonResponse, handleOptions } from "../../../src/cors.js";
import addonInterface from "../../../src/addon.js";

export async function onRequestGet(context) {
  try {
    const { type, id } = context.params;
    const cleanId = decodeURIComponent(String(id)).replace(/\.json$/, "");
    const origin = new URL(context.request.url).origin;
    globalThis.__proxyOrigin = origin;
    globalThis.__tmdbApiKey = context.env.TMDB_API_KEY || "";
    const { streams } = await addonInterface.get("stream", type, cleanId);
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
