import addonBuilder from "stremio-addon-sdk/src/builder.js";
import { ADDON_ID, ADDON_NAME, ADDON_DESCRIPTION, ADDON_VERSION } from "./config.js";
import { scrapeStreams } from "./scraper.js";

const QUALITY_CONFIG = [
  { key: "q_240", type: "bool", title: "240p", default: false },
  { key: "q_360", type: "bool", title: "360p", default: false },
  { key: "q_480", type: "bool", title: "480p", default: true },
  { key: "q_720", type: "bool", title: "720p", default: true },
  { key: "q_1080", type: "bool", title: "1080p", default: true },
  { key: "q_2160", type: "bool", title: "4K", default: true },
];

const builder = new addonBuilder({
  id: ADDON_ID,
  version: ADDON_VERSION,
  name: ADDON_NAME,
  description: ADDON_DESCRIPTION,
  resources: ["stream", "config"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  config: QUALITY_CONFIG,
});

function qualityNum(q) {
  if (!q || q === "Auto") return null;
  const s = String(q);
  if (/4k|2160/i.test(s)) return 2160;
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function isDisabled(val) {
  return val === false || val === "false" || val === 0 || val === "0";
}

function isEnabled(val) {
  return val === true || val === "true" || val === 1 || val === "1";
}

function filterByQuality(streams, config) {
  const qf = config || {};
  return streams.filter(s => {
    const n = qualityNum(s.quality);
    if (!n) return true;
    const key = `q_${n}`;
    const val = qf[key];
    if (isDisabled(val)) return false;
    if (isEnabled(val)) return true;
    const def = QUALITY_CONFIG.find(c => c.key === key);
    return def ? def.default !== false : true;
  });
}

builder.defineStreamHandler(async ({ type, id, config }) => {
  globalThis.__lastStreamActivity = Date.now();
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

    const filtered = filterByQuality(results, config);

    const streams = filtered.map((s, i) => {
      const label = season
        ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
        : null;

      const isHls = s.url.includes(".m3u8") || s.originalUrl?.includes(".m3u8");
      const isProxy = s.url.includes("/proxy/hls");
      const qual = s.quality || "Auto";
      const src = s.source || "";
      const extra = s.name ? ` · ${s.name}` : "";
      const title = label ? `${label} · ${qual} · ${src}${extra}` : `${qual} · ${src}${extra}`;

      return {
        url: s.url,
        name: globalThis.__addonName || ADDON_NAME,
        title,
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

builder.defineResourceHandler('config', () => QUALITY_CONFIG);

export default builder.getInterface();
