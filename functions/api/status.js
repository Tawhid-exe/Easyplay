import { jsonResponse, handleOptions } from "../../src/cors.js";

function pick(entry) {
  if (!entry) return null;
  return {
    ts: entry.ts || null,
    ok: entry.ok ?? null,
    handledBy: entry.handledBy || null,
    streamsFound: entry.streamsFound ?? null,
    durationMs: entry.durationMs ?? null,
    error: entry.error ?? null,
  };
}

export async function onRequestGet(context) {
  try {
    const kv = context.env?.EASYPLAY_KV;
    if (!kv) {
      return jsonResponse({ ok: false, error: "EASYPLAY_KV not bound" }, 500);
    }

    const phoneUrl = await kv.get("phone_url");
    let registeredAt = null;
    const meta = await kv.get("phone_meta");
    if (meta) {
      try { registeredAt = JSON.parse(meta).registeredAt || null; } catch {}
    }

    let lastRelay = null;
    try {
      const lr = await kv.get("last_relay");
      if (lr) lastRelay = JSON.parse(lr);
    } catch {}

    let lastFallback = null;

    return jsonResponse({
      ok: true,
      phoneUrl: phoneUrl || null,
      registeredAt,
      relayMode: phoneUrl ? "phone" : "cloud-fallback",
      lastRelay: pick(lastRelay),
      lastFallback: pick(lastFallback),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
