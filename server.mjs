import pkg from "stremio-addon-sdk";
const { serveHTTP } = pkg;
import addonInterface from "./src/addon.js";
import { TMDB_API_KEY } from "./src/config.js";

globalThis.__proxyOrigin = `http://localhost:${process.env.PORT || 7000}`;
globalThis.__tmdbApiKey = process.env.TMDB_API_KEY || TMDB_API_KEY;

serveHTTP(addonInterface, { port: process.env.PORT || 7000 });

const IDLE_MIN = Number(process.env.IDLE_TIMEOUT_MIN || 90);
const bootTime = Date.now();
setInterval(() => {
  const last = globalThis.__lastStreamActivity || bootTime;
  if (Date.now() - last > IDLE_MIN * 60 * 1000) {
    console.log(`[server] no stream lookups for ${IDLE_MIN}min, shutting down`);
    process.exit(0);
  }
}, 60 * 1000);
