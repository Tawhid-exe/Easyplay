import pkg from "stremio-addon-sdk";
const { serveHTTP } = pkg;
import addonInterface from "./src/addon.js";

serveHTTP(addonInterface, { port: 7000 });
