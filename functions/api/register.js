import { jsonResponse, handleOptions } from "../../src/cors.js";

const ALLOWED_HOST = /\.(trycloudflare\.com|ts\.net)$/i;
const BLOCKED_HOST = /^api\./i;
const TTL = 7 * 24 * 60 * 60;

function isAllowedHost(hostname) {
  if (!ALLOWED_HOST.test(hostname)) return false;
  if (BLOCKED_HOST.test(hostname)) return false;
  return true;
}

function cleanUrl(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return "";
  if (!/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    return isAllowedHost(u.hostname) ? u.origin + u.pathname.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const params = new URL(request.url).searchParams;
    const raw = params.get("url") || "";
    const token = params.get("token") || "";

    if (env.REGISTER_TOKEN && token !== env.REGISTER_TOKEN) {
      return jsonResponse({ ok: false, error: "bad token" }, 401);
    }

    const kv = env.EASYPLAY_KV;
    if (!kv) {
      return jsonResponse({ ok: false, error: "EASYPLAY_KV not bound" }, 500);
    }

    const url = cleanUrl(raw);
    if (url === null) {
      return jsonResponse({ ok: false, error: "invalid url" }, 400);
    }

    if (url === "") {
      await kv.delete("phone_url");
      await kv.delete("phone_meta");
      return jsonResponse({ ok: true, phoneUrl: null });
    }

    const registeredAt = Date.now();
    await kv.put("phone_url", url, { expirationTtl: TTL });
    await kv.put("phone_meta", JSON.stringify({ url, registeredAt }), { expirationTtl: TTL });
    return jsonResponse({ ok: true, phoneUrl: url, registeredAt, ttl: "7d" });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const kv = context.env.EASYPLAY_KV;
    const phoneUrl = kv ? await kv.get("phone_url") : null;
    let registeredAt = null;
    if (kv) {
      const meta = await kv.get("phone_meta");
      if (meta) {
        try { registeredAt = JSON.parse(meta).registeredAt || null; } catch {}
      }
    }
    return jsonResponse({ ok: true, phoneUrl: phoneUrl || null, registeredAt });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
