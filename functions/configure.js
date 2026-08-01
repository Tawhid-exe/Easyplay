import { ADDON_NAME } from "../src/config.js";

const QUALITIES = [
  { key: "q_240", label: "240p" },
  { key: "q_360", label: "360p" },
  { key: "q_480", label: "480p" },
  { key: "q_720", label: "720p" },
  { key: "q_1080", label: "1080p" },
  { key: "q_2160", label: "4K" },
];

const DEFAULTS = {
  q_240: false, q_360: false, q_480: true,
  q_720: true, q_1080: true, q_2160: true,
};

function readConfig(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/quality_config=([^;]+)/);
  if (m) {
    try { return JSON.parse(decodeURIComponent(m[1])); } catch {}
  }
  return {};
}

function html(config) {
  const checks = QUALITIES.map(q => {
    const checked = config[q.key] !== false;
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
      <input type="checkbox" name="${q.key}" ${checked ? "checked" : ""}>
      <span>${q.label}</span>
    </label>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ADDON_NAME} — Quality Settings</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0 }
  body { font-family:-apple-system,system-ui,sans-serif; background:#0f0f0f; color:#eee; min-height:100vh; display:flex; justify-content:center; align-items:center }
  .card { background:#1a1a2e; border-radius:12px; padding:32px; width:100%; max-width:380px }
  h1 { font-size:20px; margin-bottom:20px; color:#fff }
  .hint { font-size:13px; color:#888; margin-bottom:16px }
  .checks { margin-bottom:20px }
  button { width:100%; padding:10px; border:0; border-radius:8px; background:#4a6cf7; color:#fff; font-size:15px; cursor:pointer }
  button:hover { background:#5a7cf7 }
  .saved { color:#4ade80; font-size:13px; margin-top:12px; text-align:center; display:${config._saved ? "block" : "none"} }
</style>
</head>
<body>
<div class="card">
  <h1>${ADDON_NAME}</h1>
  <div class="hint">Choose which qualities to show in your stream list</div>
  <form method="POST" action="/configure">
    <div class="checks">${checks}</div>
    <button type="submit">Save Settings</button>
  </form>
  <div class="saved">Saved!</div>
</div>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "POST") {
    const formData = await request.formData();
    const config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      config[key] = formData.get(key) === "on";
    }
    const cookie = `quality_config=${encodeURIComponent(JSON.stringify(config))}; Path=/; Max-Age=31536000; SameSite=Lax`;
    return new Response(null, {
      status: 302,
      headers: { Location: "/configure", "Set-Cookie": cookie },
    });
  }

  const config = readConfig(request);
  return new Response(html(config), {
    headers: { "Content-Type": "text/html" },
  });
}
