import addonBuilder from "stremio-addon-sdk/src/builder.js";
import { ADDON_ID, ADDON_NAME, ADDON_DESCRIPTION, ADDON_VERSION } from "./config.js";
import { scrapeStreams } from "./scraper.js";

const builder = new addonBuilder({
  id: ADDON_ID,
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: ADDON_DESCRIPTION,
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
});

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    const parts = id.split(":");
    const imdbId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;

    const results = await scrapeStreams({
      type,
      imdbId,
      season: season ? Number(season) : null,
      episode: episode ? Number(episode) : null,
    });

    const streams = results.map((s, i) => {
      const label = season
        ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
        : null;

      const isHls = s.url.includes(".m3u8") || s.originalUrl?.includes(".m3u8");
      const isProxy = s.url.includes("/proxy/hls");

      return {
        url: s.url,
        name: ADDON_NAME,
        title: label ? `${label} · ${s.quality || "Auto"}` : s.quality || "Auto",
        behaviorHints: {
          notWebReady: isHls && !isProxy,
          bingeGroup: season ? `scraper-${imdbId}` : undefined,
        },
      };
    });

    return { streams };
  } catch (err) {
    console.error(`[addon] stream handler error:`, err.message);
    return { streams: [] };
  }
});

export default builder.getInterface();
