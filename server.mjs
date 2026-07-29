import pkg from "stremio-addon-sdk";
const { serveHTTP } = pkg;
import addonInterface from "./src/addon.js";

globalThis.__proxyOrigin = `http://localhost:${process.env.PORT || 7000}`;
globalThis.__tmdbApiKey = process.env.TMDB_API_KEY || "";

serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
