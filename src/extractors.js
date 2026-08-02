import { fetchWithTimeout, base64Decode, rot13, extractAll } from "./utils.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const RESOLVED_TTL = 10 * 60 * 1000;
const HTML_TTL = 20 * 60 * 1000;

const htmlCache = new Map();
const resolvedCache = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttl) {
  if (map.size >= 400) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { ts: Date.now(), ttl, value });
}

function originOf(url) {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
}

async function fetchHtml(url, referer) {
  const cached = cacheGet(htmlCache, url, HTML_TTL);
  if (cached) return cached;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Referer: referer || originOf(url) },
  });
  if (!res || !res.ok) return null;
  const html = await res.text();
  cacheSet(htmlCache, url, html, HTML_TTL);
  return html;
}

function absoluteUrl(href, base) {
  if (!href) return null;
  if (href.startsWith("//")) href = "https:" + href;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

export async function resolveRedirect(url, referer) {
  const html = await fetchHtml(url, referer);
  if (!html) return null;

  let match = html.match(/s\s*\(\s*'o'\s*,\s*'([A-Za-z0-9+/=]+)'\s*\)/);
  if (!match) {
    match = html.match(/ck\s*\(\s*'_wp_http_[^']+'\s*,\s*'([^']+)'\s*\)/);
  }
  if (!match) return null;

  try {
    let data = match[1];
    let step1 = base64Decode(data);
    if (!step1) return null;
    let step2 = base64Decode(step1);
    if (!step2) return null;
    let step3 = rot13(step2);
    let step4 = base64Decode(step3);
    if (!step4) return null;
    let parsed = JSON.parse(step4);
    if (!parsed.o) return null;
    return base64Decode(parsed.o) || null;
  } catch {
    return null;
  }
}

const DIRECT_RE = /r2\.cloudflarestorage\.com|pixeldrain|gdrive|terabox|\.mp4|\.mkv|\.avi/i;
const GENERATOR_RE = /sportverse|hubcloud\.php|hubcloud\.cx\/drive|hubcloud\.fans\/drive|hblink|gadgetsweb|redirect/i;

async function resolvePageLinks(pageUrl) {
  const html = await fetchHtml(pageUrl, pageUrl);
  if (!html) return [];
  const links = [];
  const seen = new Set();

  const anchors = html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
  for (const a of anchors) {
    let href = a[1];
    if (href.startsWith("//")) href = "https:" + href;
    if (!DIRECT_RE.test(href)) continue;
    if (/pixeldrain\.dev/i.test(href)) {
      const uid = href.match(/\/u\/(\w+)/);
      if (uid) href = `https://pixeldrain.dev/api/file/${uid[1]}?download`;
    }
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }
  return links;
}

export async function extractHubCloudSearchRecover(url, referer) {
  const cached = cacheGet(resolvedCache, url, RESOLVED_TTL);
  if (cached) return cached;

  const parsed = new URL(url);
  const token = parsed.searchParams.get("from_ac") || "";
  let query = parsed.searchParams.get("q") || "";
  if (query) {
    const decoded = base64Decode(query.replace(/-/g, "+").replace(/_/g, "/"));
    if (decoded && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) query = decoded;
  }
  if (!query || !token) return [];

  const apiUrl = `https://${parsed.hostname}/drive/search-recover.php?api=search&q=${encodeURIComponent(query)}&page=1&from_ac=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: `${parsed.origin}/drive/` },
  });
  const links = [];
  const seen = new Set();
  if (res && res.ok) {
    try {
      const data = await res.json();
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      for (const hit of hits) {
        const fileUrl = hit?.url;
        if (fileUrl && !seen.has(fileUrl)) {
          seen.add(fileUrl);
          const resolved = await extractHubCloudLinks(fileUrl, apiUrl);
          for (const l of resolved) if (!links.includes(l)) links.push(l);
        }
      }
    } catch {
      return [];
    }
  }
  cacheSet(resolvedCache, url, links, RESOLVED_TTL);
  return links;
}

export async function extractHubCloudLinks(pageUrl, referer) {
  const cached = cacheGet(resolvedCache, pageUrl, RESOLVED_TTL);
  if (cached) return cached;

  const html = await fetchHtml(pageUrl, referer);
  if (!html) return [];
  const links = [];
  const seen = new Set();
  const add = (arr) => {
    for (const l of arr) {
      if (l && !seen.has(l)) {
        seen.add(l);
        links.push(l);
      }
    }
  };

  const urlMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (urlMatch) {
    const payload = urlMatch[1].replace(/-/g, "+").replace(/_/g, "/");
    let ids = [];
    try {
      const parsed = JSON.parse(base64Decode(payload) || "{}");
      if (Array.isArray(parsed?.result?.data)) {
        ids = parsed.result.data.map(d => d.id).filter(Boolean);
      } else if (Array.isArray(parsed?.data)) {
        ids = parsed.data.map(d => d.id).filter(Boolean);
      }
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const worker = await fetchWithTimeout(`https://techyboy4u.gadgetsweb.workers.dev/?id=${id}`, {
        headers: { "User-Agent": UA, Referer: originOf(pageUrl) },
      });
      if (!worker || !worker.ok) continue;
      try {
        const data = await worker.json();
        const direct = typeof data?.result === "string" ? data.result : data?.result?.url;
        if (direct && direct.startsWith("http")) add([direct]);
        if (Array.isArray(data?.result?.data)) {
          for (const it of data.result.data) {
            const u = it?.url || it?.link;
            if (u && u.startsWith("http")) add([u]);
          }
        }
      } catch {
        continue;
      }
    }
  }

  const genAnchors = html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
  for (const a of genAnchors) {
    let href = a[1];
    if (href.startsWith("//")) href = "https:" + href;
    if (GENERATOR_RE.test(href)) {
      add(await resolvePageLinks(href));
    }
  }

  cacheSet(resolvedCache, pageUrl, links, RESOLVED_TTL);
  return links;
}

export async function extractPixeldrain(url, referer) {
  const cached = cacheGet(resolvedCache, url, RESOLVED_TTL);
  if (cached) return cached;

  const uid = url.match(/\/file\/(\w+)|#\/u\/(\w+)|pixeldrain\.dev\/u\/(\w+)/i);
  const id = uid ? (uid[1] || uid[2] || uid[3]) : null;
  const apiUrl = id
    ? `https://pixeldrain.dev/api/file/${id}?download`
    : url;
  const res = await fetchWithTimeout(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: referer || "https://pixeldrain.dev/" },
  });
  let links = [];
  if (res && res.ok) {
    try {
      const data = await res.json();
      const direct = data?.file?.download_url || data?.download_url;
      if (direct) links = [absoluteUrl(direct, apiUrl)].filter(Boolean);
      if (data?.file?.name) {
        const idName = data.file.id || id;
        if (idName) links = [`https://pixeldrain.dev/api/file/${idName}?download`];
      }
    } catch {
      links = [apiUrl];
    }
  }
  cacheSet(resolvedCache, url, links, RESOLVED_TTL);
  return links;
}

export async function extractStreamtape(url, referer) {
  const cached = cacheGet(resolvedCache, url, RESOLVED_TTL);
  if (cached) return cached;

  const embed = url.replace(/\/e\//, "/e/").includes("/e/") ? url : url.replace(/\/v\//, "/e/").replace(/streamtape\.com\/.*/, "streamtape.com/e/") + (url.match(/streamtape\.com\/e\/(\w+)/)?.[1] || "");
  const pageUrl = /streamtape\.com\/e\//.test(url)
    ? url
    : `https://streamtape.com/e/${url.match(/(?:streamtape\.com|streamtape\.net)\/(?:v|e)\/(\w+)/)?.[1] || ""}`;
  if (!pageUrl.endsWith("e/")) {
    const html = await fetchHtml(pageUrl, referer);
    if (!html) return [];

    let links = [];
    const inner = html.match(/innerHTML\s*=\s*"([^"]+)"/) || html.match(/s\.innerHTML\s*=\s*"([^"]+)"/);
    if (inner) {
      const decoded = decodeURIComponent(inner[1]);
      const fm = decoded.match(/https?:\/\/[^"'\s<>\\]+\.(?:m3u8|mp4)[^"'\s<>\\]*/);
      if (fm) links = [fm[0].replace(/\\/g, "")];
    }
    if (!links.length) {
      const fm = html.match(/id="[^"]*link"[^>]*>\s*(https?:\/\/[^<]+)/i) || html.match(/"([^"]*streamtape[^"]*\.(?:m3u8|mp4)[^"]*)"/i);
      if (fm) links = [fm[1].replace(/\\/g, "")];
    }
    cacheSet(resolvedCache, url, links, RESOLVED_TTL);
    return links;
  }
  return [];
}

export async function extractHubcdn(url, referer) {
  const cached = cacheGet(resolvedCache, url, RESOLVED_TTL);
  if (cached) return cached;

  const html = await fetchHtml(url, referer);
  if (!html) return [];
  const links = [];

  const reurlMatch = html.match(/reurl\s*=\s*["']([^"']+)["']/);
  if (reurlMatch) {
    const rVal = reurlMatch[1].match(/[?&]r=([A-Za-z0-9+/=]+)/);
    if (rVal) {
      const decoded = base64Decode(rVal[1]);
      if (decoded) {
        const linkVal = decoded.match(/[?&]link=([^&\s"']+)/);
        if (linkVal) links.push(decodeURIComponent(linkVal[1]));
        else if (/^https?:\/\//.test(decoded)) links.push(decoded);
      }
    }
  }

  const rMatch = html.match(/r\s*=\s*['"]([A-Za-z0-9+/=]+)['"]/) || html.match(/atob\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/);
  if (rMatch && !links.length) {
    const decoded = base64Decode(rMatch[1]);
    if (decoded) {
      const linkVal = decoded.match(/[?&]link=([^&\s"']+)/);
      if (linkVal) links.push(decodeURIComponent(linkVal[1]));
      else if (/^https?:\/\//.test(decoded)) links.push(decoded);
    }
  }

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scriptMatch) {
    const hits = [...script.matchAll(/atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/g)];
    for (const hit of hits) {
      const decoded = base64Decode(hit[1]);
      if (decoded && /^https?:\/\//.test(decoded)) links.push(decoded);
    }
  }

  const final = [];
  for (const link of links) {
    if (/hubcloud|techyboy|gadgetsweb|redirect/i.test(link)) {
      final.push(...await extractHubCloudLinks(link, url));
    } else if (/^https?:\/\//.test(link)) {
      final.push(link);
    }
  }

  cacheSet(resolvedCache, url, final, RESOLVED_TTL);
  return final;
}

export async function extractHblinks(url, referer) {
  const cached = cacheGet(resolvedCache, url, RESOLVED_TTL);
  if (cached) return cached;

  const html = await fetchHtml(url, referer);
  if (!html) return [];
  const links = [];
  const seen = new Set();

  const anchors = html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
  for (const a of anchors) {
    const href = absoluteUrl(a[1], url);
    if (!href) continue;
    if (/hubcloud|techyboy|gadgetsweb/i.test(href)) {
      const resolved = await extractHubCloudLinks(href, url);
      for (const l of resolved) if (!seen.has(l)) { seen.add(l); links.push(l); }
    } else if (/redirect/i.test(href)) {
      const resolved = await resolveRedirect(href, url);
      if (resolved && !seen.has(resolved)) { seen.add(resolved); links.push(resolved); }
    }
  }

  cacheSet(resolvedCache, url, links, RESOLVED_TTL);
  return links;
}

const DIRECT_EXT = /\.(mp4|mkv|avi|m3u8)(\?|$)/i;

export async function resolveLink(url, referer) {
  if (/search-recover\.php/i.test(url)) return extractHubCloudSearchRecover(url, referer);
  if (url.includes("hubcloud") || url.match(/\/\?id=/)) {
    return extractHubCloudLinks(url, referer);
  }
  if (url.includes("hubcdn")) return extractHubcdn(url, referer);
  if (url.includes("hubdrive")) {
    const html = await fetchHtml(url, referer);
    const hm = html && html.match(/href="([^"]*hubcloud[^"]*)"/);
    return hm ? extractHubCloudLinks(hm[1], url) : [];
  }
  if (/pixeldrain/i.test(url)) return extractPixeldrain(url, referer);
  if (/streamtape/i.test(url)) return extractStreamtape(url, referer);
  if (DIRECT_EXT.test(url)) return [url];
  if (/hblink|gadgetsweb/i.test(url)) return extractHblinks(url, referer);
  if (/redirect/i.test(url)) {
    const resolved = await resolveRedirect(url, referer);
    return resolved ? [resolved] : [];
  }
  return [url];
}

export function loadExtractor(url) {
  if (url.includes("hubcloud") || url.match(/\/\?id=/)) return extractHubCloudLinks;
  if (url.includes("hubcdn")) return extractHubcdn;
  if (url.includes("hubdrive")) return null;
  if (/pixeldrain/i.test(url)) return extractPixeldrain;
  if (/streamtape/i.test(url)) return extractStreamtape;
  if (/hblink|gadgetsweb/i.test(url)) return extractHblinks;
  return null;
}
