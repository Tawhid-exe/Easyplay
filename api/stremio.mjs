import addonInterface from "../src/addon.js";
import { debugSources } from "../src/scraper.js";
import { TMDB_API_KEY } from "../src/config.js";

export default async function handler(req, res) {
  globalThis.__proxyOrigin = `https://${req.headers.host}`;
  globalThis.__tmdbApiKey = process.env.TMDB_API_KEY || TMDB_API_KEY;

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path.startsWith("/debug/")) {
      const parts = path.split("/");
      const type = parts[2];
      const id = (parts[3] || "").replace(/\.json$/, "");
      const idParts = id.split(":");
      const imdbId = idParts[0];
      const season = idParts[1] || null;
      const episode = idParts[2] || null;
      const results = await debugSources({ type, imdbId, season: season ? Number(season) : null, episode: episode ? Number(episode) : null });
      const resolvedKey = globalThis.__tmdbApiKey;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json({
        ok: true,
        tmdbApiKeySet: !!resolvedKey,
        tmdbApiKeyPrefix: resolvedKey ? resolvedKey.slice(0, 8) + "..." : null,
        params: { type, imdbId, season, episode },
        summary: {
          total: results.length,
          success: results.filter(r => r.status === "success").length,
          empty: results.filter(r => r.status === "empty").length,
          error: results.filter(r => r.status === "error").length,
        },
        results,
      });
    }

    if (path.startsWith("/stream/")) {
      const parts = path.split("/");
      const type = parts[2];
      const id = (parts[3] || "").replace(/\.json$/, "");
      const result = await addonInterface.get("stream", type, id);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).json(result);
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(addonInterface.manifest);
  } catch (err) {
    console.error("[vercel]", err.message);
    res.status(500).json({ error: err.message });
  }
}
