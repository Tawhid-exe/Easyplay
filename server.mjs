import os from "node:os";
import express from "express";
import cors from "cors";
import pkg from "stremio-addon-sdk";
const { getRouter } = pkg;
import addonInterface from "./src/addon.js";
import { TMDB_API_KEY } from "./src/config.js";
import { resolve4khdhubPreview } from "./src/4khdhub.js";

const PORT = Number(process.env.PORT || 7000);

function getLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = String(net.family);
      if ((family === "IPv4" || family === "4") && !net.internal && !net.address.startsWith("169.254.")) {
        candidates.push({ addr: net.address, name });
      }
    }
  }
  const inPrivate = (a) => a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const priv = candidates.filter((c) => inPrivate(c.addr));
  const pick = priv[0] || candidates[0];
  return pick ? pick.addr : "127.0.0.1";
}

const lanIp = process.env.HOST_IP || getLanIp();
globalThis.__proxyOrigin = `http://${lanIp}:${PORT}`;
globalThis.__tmdbApiKey = process.env.TMDB_API_KEY || TMDB_API_KEY;
globalThis.__addonName = process.env.ADDON_NAME || "Easyplay";
addonInterface.manifest = { ...addonInterface.manifest, name: globalThis.__addonName };

const app = express();
app.use(cors());

// Stream/HLS URLs are rewritten against the origin the client actually used.
// LAN clients get the LAN IP; tunnel clients (cloudflared/tailscale) get the
// public https host so remote devices can fetch the HLS proxy too.
app.use((req, _res, next) => {
  const host = req.headers.host || `${lanIp}:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const isTunnelHost = host.includes("trycloudflare.com") || host.endsWith(".ts.net");
  const proto = isTunnelHost ? "https" : forwardedProto === "https" ? "https" : "http";
  globalThis.__proxyOrigin = `${proto}://${host}`;
  next();
});

app.get("/resolve", async (req, res) => {
  const d = req.query.d;
  if (!d || typeof d !== "string") {
    res.status(400).json({ error: "missing d" });
    return;
  }
  try {
    const url = await resolve4khdhubPreview(d);
    if (!url) {
      res.status(404).json({ error: "no playable link found" });
      return;
    }
    res.redirect(302, url);
  } catch (err) {
    console.error(`[server] /resolve error:`, err.message);
    res.status(500).json({ error: "resolve failed" });
  }
});

app.use(getRouter(addonInterface));

const landingHTML = `<html><body><h1>${addonInterface.manifest.name}</h1><p>Add this URL in Stremio:</p><code>http://localhost:${PORT}/manifest.json</code></body></html>`;

app.get("/", (_, res) => {
  res.setHeader("content-type", "text/html");
  res.end(landingHTML);
});

app.listen(PORT, () => {
  console.log(`\nAddon URLs:`);
  console.log(`  This PC : http://localhost:${PORT}/manifest.json`);
  console.log(`  Phone   : http://${lanIp}:${PORT}/manifest.json   (same WiFi, or set HOST_IP to override)`);
});

const IDLE_MIN = Number(process.env.IDLE_TIMEOUT_MIN || 90);
const bootTime = Date.now();
setInterval(() => {
  const last = globalThis.__lastStreamActivity || bootTime;
  if (Date.now() - last > IDLE_MIN * 60 * 1000) {
    console.log(`[server] no stream lookups for ${IDLE_MIN}min, shutting down`);
    process.exit(0);
  }
}, 60 * 1000);
