const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="136", "Google Chrome";v="136", "Not=A?Brand";v="99"';
const SEC_CH_UA_PLATFORM = '"Windows"';
const FETCH_TIMEOUT = 10000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildHeaders(referer, cookie) {
  const h = {
    "user-agent": UA,
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": SEC_CH_UA_PLATFORM,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
  };
  if (referer) {
    h.referer = referer;
    try {
      h.origin = new URL(referer).origin;
    } catch {}
  }
  if (cookie) h.cookie = cookie;
  return h;
}

async function fetchWithFallback(url, referer, cookie, range, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const hdrs = buildHeaders(referer, cookie);
      if (range) hdrs.range = range;
      let res = await fetch(url, { headers: hdrs, redirect: "follow", signal: controller.signal });

      if (res && (res.ok || res.status === 206)) {
        clearTimeout(id);
        return res;
      }

      if (cookie && res && res.status === 403 && i === 0) {
        const altHdrs = buildHeaders(referer, "");
        if (range) altHdrs.range = range;
        res = await fetch(url, { headers: altHdrs, redirect: "follow", signal: controller.signal });
        if (res && (res.ok || res.status === 206)) {
          clearTimeout(id);
          return res;
        }
      }

      const retryable = res && (res.status === 403 || res.status === 429 || res.status >= 500);
      if (!retryable) {
        clearTimeout(id);
        return res;
      }

      if (i < retries) {
        let delay = Math.min(300 * Math.pow(2, i), 1200);
        if (res && res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          const secs = retryAfter ? parseInt(retryAfter, 10) : NaN;
          if (!Number.isNaN(secs)) delay = Math.min(secs * 1000, 1200);
        }
        clearTimeout(id);
        await sleep(delay);
      } else {
        clearTimeout(id);
      }
    } catch {}
  }
  return null;
}

function proxiedHref(uri, baseUrl, proxyOrigin, referer, cookie) {
  let resolved;
  try {
    resolved = uri.startsWith("http") ? uri : new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
  const proxyUrl = new URL("/proxy/hls/stream.m3u8", proxyOrigin);
  proxyUrl.searchParams.set("url", resolved);
  if (referer) proxyUrl.searchParams.set("referer", referer);
  if (cookie) proxyUrl.searchParams.set("cookie", cookie);
  return proxyUrl.href;
}

function rewriteUriAttribute(line, baseUrl, proxyOrigin, referer, cookie) {
  const m = line.match(/URI="([^"]*)"/);
  if (!m) return line;
  const proxied = proxiedHref(m[1], baseUrl, proxyOrigin, referer, cookie);
  if (!proxied) return line;
  return line.replace(/URI="([^"]*)"/, `URI="${proxied}"`);
}

function rewriteManifest(manifest, baseUrl, proxyOrigin, referer, cookie) {
  const lines = manifest.split("\n");
  const rewritten = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith("#")) {
      if (/^#EXT-X-KEY:/i.test(line) || /^#EXT-X-MAP:/i.test(line) || /^#EXT-X-MEDIA:/i.test(line) || /^#EXT-X-I-FRAME-STREAM-INF:/i.test(line)) {
        rewritten.push(rewriteUriAttribute(line, baseUrl, proxyOrigin, referer, cookie));
      } else {
        rewritten.push(line);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      rewritten.push(line);
      continue;
    }

    const proxied = proxiedHref(trimmed, baseUrl, proxyOrigin, referer, cookie);
    if (!proxied) {
      rewritten.push(line);
      continue;
    }

    rewritten.push(proxied);
  }

  return rewritten.join("\n");
}

export async function onRequestGet(context) {
  const parsed = new URL(context.request.url);
  const targetUrl = parsed.searchParams.get("url");
  const referer = parsed.searchParams.get("referer") || "https://nextgencloudfabric.com/";
  const cookie = parsed.searchParams.get("cookie") || "";
  const range = context.request.headers.get("range") || "";

  if (!targetUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  const res = await fetchWithFallback(targetUrl, referer, cookie, range);
  if (!res) {
    return new Response("Failed to fetch stream", { status: 502 });
  }

  const contentType = res.headers.get("content-type") || "";
  const proxyOrigin = `${parsed.protocol}//${parsed.host}`;

  const body = await res.arrayBuffer();
  const bytes = new Uint8Array(body);
  const head = bytes.length >= 7 ? new TextDecoder().decode(bytes.slice(0, 7)) : "";
  const isManifest = contentType.includes("mpegurl") || contentType.includes("x-mpegurl") || contentType.includes("hls") || targetUrl.endsWith(".m3u8") || head === "#EXTM3U";

  if (isManifest) {
    const rewritten = rewriteManifest(new TextDecoder().decode(body), targetUrl, proxyOrigin, referer, cookie);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  }

  const respHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
    "Content-Length": String(body.byteLength),
  };

  const contentRange = res.headers.get("content-range");
  if (contentRange) respHeaders["Content-Range"] = contentRange;

  let status = res.ok ? 200 : res.status;
  let payload = body;

  if (range && res.status === 200) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), body.byteLength - 1) : body.byteLength - 1;
      if (start >= 0 && start < body.byteLength) {
        payload = body.slice(start, end + 1);
        respHeaders["Content-Range"] = `bytes ${start}-${end}/${body.byteLength}`;
        respHeaders["Content-Length"] = String(payload.byteLength);
        status = 206;
      }
    }
  }

  return new Response(payload, { status, headers: respHeaders });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
