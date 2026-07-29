import addonInterface from "../src/addon.js";

export default async function handler(req, res) {
  globalThis.__proxyOrigin = `https://${req.headers.host}`;
  globalThis.__tmdbApiKey = process.env.TMDB_API_KEY || "";

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path.startsWith("/stream/")) {
      const parts = path.split("/");
      const type = parts[2];
      const id = (parts[3] || "").replace(/\.json$/, "");
      const result = await addonInterface.get("stream", type, id);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).json(result);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).json(addonInterface.manifest);
    }
  } catch (err) {
    console.error("[vercel]", err.message);
    res.status(500).json({ error: err.message });
  }
}
