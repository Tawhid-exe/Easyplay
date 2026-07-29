const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function buildHeaders(referer, cookie) {
  const h = {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    Origin: referer ? new URL(referer).origin : "https://nextgencloudfabric.com",
  };
  if (referer) h.Referer = referer;
  if (cookie) h.Cookie = cookie;
  return h;
}

async function fetchWithFallback(url, referer, cookie, range, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const hdrs = buildHeaders(referer, cookie);
      if (range) hdrs.Range = range;
      const res = await fetch(url, { headers: hdrs, redirect: "follow" });
      if (res.ok || res.status === 206) return res;
      if (res.status === 403 || res.status === 429) {
        const altHdrs = {
          "User-Agent": UA,
          Referer: referer || "https://nextgencloudfabric.com/",
          Origin: "https://nextgencloudfabric.com",
        };
        if (range) altHdrs.Range = range;
        const altRes = await fetch(url, { headers: altHdrs, redirect: "follow" });
        if (altRes.ok) return altRes;
      }
    } catch {}
  }
  return null;
}

function rewriteManifest(manifest, baseUrl, proxyOrigin, referer, cookie) {
  const lines = manifest.split("\n");
  const rewritten = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith("#")) {
      rewritten.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      rewritten.push(line);
      continue;
    }

    let resolved;
    try {
      resolved = trimmed.startsWith("http")
        ? trimmed
        : new URL(trimmed, baseUrl).href;
    } catch {
      rewritten.push(line);
      continue;
    }

    const proxyUrl = new URL("/proxy/hls/stream.m3u8", proxyOrigin);
    proxyUrl.searchParams.set("url", resolved);
    if (referer) proxyUrl.searchParams.set("referer", referer);
    if (cookie) proxyUrl.searchParams.set("cookie", cookie);

    rewritten.push(proxyUrl.href);
  }

  return rewritten.join("\n");
}

export async function onRequestGet(context) {
  const url = context.request.url;
  const parsed = new URL(url);
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

  if (contentType.includes("mpegurl") || contentType.includes("x-mpegurl") || contentType.includes("hls") || targetUrl.endsWith(".m3u8")) {
    const body = await res.text();
    const rewritten = rewriteManifest(body, targetUrl, proxyOrigin, referer, cookie);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  }

  const body = await res.arrayBuffer();
  const respHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
  };

  const contentRange = res.headers.get("content-range");
  if (contentRange) respHeaders["Content-Range"] = contentRange;

  const status = range && res.status === 206 ? 206 : (res.ok ? 200 : res.status);

  return new Response(body, {
    status,
    headers: respHeaders,
  });
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
