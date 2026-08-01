import { jsonResponse, handleOptions } from "../../../src/cors.js";
import { debugSources } from "../../../src/scraper.js";
import { TMDB_API_KEY } from "../../../src/config.js";

export async function onRequestGet(context) {
  try {
    const { type, id } = context.params;
    const cleanId = decodeURIComponent(String(id)).replace(/\.json$/, "");
    const origin = new URL(context.request.url).origin;
    globalThis.__proxyOrigin = origin;
    globalThis.__tmdbApiKey = context.env.TMDB_API_KEY || TMDB_API_KEY;

    const parts = cleanId.split(":");
    const imdbId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;

    const results = await debugSources({ type, imdbId, season: season ? Number(season) : null, episode: episode ? Number(episode) : null });

    const totalOk = results.filter(r => r.status === "success").length;
    const totalEmpty = results.filter(r => r.status === "empty").length;
    const totalErr = results.filter(r => r.status === "error").length;

    const resolvedKey = globalThis.__tmdbApiKey;
    return jsonResponse({
      ok: true,
      tmdbApiKeySet: !!resolvedKey,
      tmdbApiKeyPrefix: resolvedKey ? resolvedKey.slice(0, 8) + "..." : null,
      params: { type, imdbId, season, episode },
      summary: { total: results.length, success: totalOk, empty: totalEmpty, error: totalErr },
      results,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, stack: err.stack }, 500);
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
