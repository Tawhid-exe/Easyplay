import { jsonResponse, handleOptions } from "../../src/cors.js";

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const params = new URL(request.url).searchParams;
    const token = params.get("token") || "";
    if (env.REGISTER_TOKEN && token !== env.REGISTER_TOKEN) {
      return jsonResponse({ ok: false, error: "bad token" }, 401);
    }
    const kv = env.EASYPLAY_KV;
    if (!kv) {
      return jsonResponse({ ok: false, error: "EASYPLAY_KV not bound" }, 500);
    }

    const limit = Math.min(parseInt(params.get("limit") || "50", 10) || 50, 200);
    const list = await kv.list({ prefix: "reqlog:" });
    const keys = list.keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, limit);
    const entries = [];
    for (const k of keys) {
      const val = await kv.get(k.name);
      try { entries.push(JSON.parse(val)); } catch {}
    }
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return jsonResponse({ ok: true, count: entries.length, entries });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
