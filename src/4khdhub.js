import { fetchWithTimeout, convertImdbToTmdb } from "./utils.js";
import { KHDHUB_LAZY_LOAD } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const BASE_URLS = ["https://4khdhub.one", "https://4khdhub.fans"];
const TIMEOUT = 10000;
const HTML_TTL = 20 * 60 * 1000;
const RESOLVED_TTL = 10 * 60 * 1000;

const htmlCache = new Map();
const resolvedCache = new Map();
const previewCache = new Map();

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

async function fetchHtml(url, referer) {
  const cached = cacheGet(htmlCache, url, HTML_TTL);
  if (cached) return cached;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Referer: referer },
  });
  if (!res || !res.ok) return null;
  const html = await res.text();
  cacheSet(htmlCache, url, html, HTML_TTL);
  return html;
}

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, c => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

function base64Decode(str) {
  try { return atob(str); } catch { return null; }
}

function parseSize(text) {
  const m = text.match(/([\d.]+)\s*(TB|GB|MB)/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "TB") return num * 1024;
  if (unit === "GB") return num;
  if (unit === "MB") return num / 1024;
  return null;
}

function parseQuality(text) {
  if (/\b2160p\b|2160|(?:^|[^\w])4k\b/i.test(text)) return "2160p";
  if (/\b1080p\b|1080|(?:^|[^\w])fhd\b/i.test(text)) return "1080p";
  if (/\b720p\b|(?:^|[^\w])720\b/i.test(text)) return "720p";
  const m = text.match(/(\d{3,4}p)/i);
  return m ? m[1].toLowerCase() : null;
}

function extractAll(html, left, right) {
  const results = [];
  let idx = 0;
  while (true) {
    const l = html.indexOf(left, idx);
    if (l === -1) break;
    const r = html.indexOf(right, l + left.length);
    if (r === -1) break;
    results.push(html.slice(l + left.length, r));
    idx = r + right.length;
  }
  return results;
}

function extractBlocks(html, className) {
  const blocks = [];
  const re = new RegExp(`<div class="${className}[\\s\\S]*?<\\/div>\\s*<\\/div>`, "g");
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[0]);
  return blocks;
}

async function resolveRedirect(url) {
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Referer: BASE_URLS[0] + "/" },
  });
  if (!res || !res.ok) return null;
  const html = await res.text();

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
    if (/pixeld/i.test(href)) {
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

async function extractHubCloudLinks(pageUrl) {
  const cached = cacheGet(resolvedCache, pageUrl, RESOLVED_TTL);
  if (cached) return cached;

  const html = await fetchHtml(pageUrl, BASE_URLS[0] + "/");
  if (!html) return [];
  const links = [];
  const seen = new Set();
  const add = (arr) => {
    for (const l of arr) {
      if (!seen.has(l)) {
        seen.add(l);
        links.push(l);
      }
    }
  };

  const urlMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (urlMatch) {
    add(await resolvePageLinks(urlMatch[1]));
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

async function searchContent(title, year, isSeries) {
  const query = encodeURIComponent(`${title} ${year || ""}`.trim());

  for (const baseUrl of BASE_URLS) {
    try {
      const html = await fetchHtml(`${baseUrl}/?s=${query}`, baseUrl + "/");
      if (!html) continue;
      const cards = [];
      const cardRe = /<a\b[^>]*class="movie-card"[^>]*>([\s\S]*?)<\/a>/gi;
      let cm;
      while ((cm = cardRe.exec(html)) !== null) cards.push(cm[0]);
      if (!cards.length) continue;

      let bestMatch = null;
      let bestScore = 0;

      for (const card of cards) {
        const hrefMatch = card.match(/href="([^"]+)"/);
        const titleMatch = card.match(/movie-card-title[^>]*>([^<]+)/i);
        const metaMatch = card.match(/movie-card-meta[^>]*>([^<]+)/i);

        if (!hrefMatch || !titleMatch) continue;

        const cardTitle = titleMatch[1].trim();
        const cardYear = metaMatch ? parseInt(metaMatch[1].trim(), 10) : null;
        const href = hrefMatch[1];
        const isMovieCard = /-movie-\d+\//.test(href);
        const isSeriesCard = /-series-\d+\//.test(href);

        if (isSeries && isMovieCard) continue;
        if (!isSeries && isSeriesCard) continue;

        let score = 0;
        if (cardYear && year) {
          const diff = Math.abs(cardYear - year);
          if (diff === 0) score += 10;
          else if (diff <= 1) score += 7;
          else if (diff <= 2) score += 4;
        }

        const queryLower = title.toLowerCase();
        const cardLower = cardTitle.toLowerCase();
        if (cardLower.includes(queryLower) || queryLower.includes(cardLower)) {
          score += 5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = href;
        }
      }

      if (bestMatch) {
        return bestMatch.startsWith("http") ? bestMatch : baseUrl + bestMatch;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function loadMovieContent(pageUrl) {
  const html = await fetchHtml(pageUrl, BASE_URLS[0] + "/");
  if (!html) return [];

  const items = [];
  const blocks = extractBlocks(html, "download-item");

  for (const block of blocks) {
    const downloadLinks = [];
    const linkMatches = block.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
    for (const lm of linkMatches) {
      let href = lm[1];
      if (href.startsWith("//")) href = "https:" + href;
      if (href.startsWith("http")) downloadLinks.push(href);
    }
    if (!downloadLinks.length) continue;

    let size = null;
    const sizeMatch = block.match(/badge[^>]*style=["'][^"']*#ea580c[^"']*["'][^>]*>\s*([^<]+)/i);
    if (sizeMatch) size = parseSize(sizeMatch[1]);
    if (!size) {
      const gs = block.match(/([\d.]+)\s*(?:TB|GB|MB)/i);
      if (gs) size = parseSize(gs[0]);
    }

    const quality = parseQuality(block) || "Auto";
    const codec = /HEVC|H\.?265/i.test(block) ? "HEVC" : /H\.?264|AVC/i.test(block) ? "H.264" : "";
    const hdr = /Dolby\s*Vision|DV[^A-Za-z]|HDR(?:10)?/i.test(block) ? "HDR" : "";

    const filenameMatch = block.match(/([A-Z][\w.\-\[\]()]+\.(?:mkv|mp4|avi))/i);
    const filename = filenameMatch ? filenameMatch[1] : "";

    items.push({ size, quality, codec, hdr, filename, downloadLinks });
  }

  return items;
}

async function loadSeriesContent(pageUrl, season, episode) {
  const html = await fetchHtml(pageUrl, BASE_URLS[0] + "/");
  if (!html) return [];

  const items = [];
  const blocks = extractBlocks(html, "episode-download-item");

  for (const block of blocks) {
    let sNum = null;
    let epNum = null;

    const seMatch = block.match(/S(\d+)\s*E(\d+)/i);
    if (seMatch) {
      sNum = parseInt(seMatch[1], 10);
      epNum = parseInt(seMatch[2], 10);
    } else {
      const epMatch = block.match(/Episode[-\s]*0*(\d+)/i);
      if (epMatch) epNum = parseInt(epMatch[1], 10);
    }

    if (season != null && sNum !== null && sNum !== Number(season)) continue;
    if (episode != null && epNum !== null && epNum !== Number(episode)) continue;

    const downloadLinks = [];
    const linkMatches = block.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
    for (const lm of linkMatches) {
      let href = lm[1];
      if (href.startsWith("//")) href = "https:" + href;
      if (href.startsWith("http")) downloadLinks.push(href);
    }
    if (!downloadLinks.length) continue;

    let size = null;
    const sizeMatch = block.match(/badge-size[^>]*>\s*([^<]+)/i);
    if (sizeMatch) size = parseSize(sizeMatch[1]);
    if (!size) {
      const gs = block.match(/([\d.]+)\s*(?:TB|GB|MB)/i);
      if (gs) size = parseSize(gs[0]);
    }

    const quality = parseQuality(block) || "Auto";
    const codec = /HEVC|H\.?265/i.test(block) ? "HEVC" : "";
    const hdr = /Dolby\s*Vision|DV[^A-Za-z]|HDR(?:10)?/i.test(block) ? "HDR" : "";

    const filenameMatch = block.match(/([A-Z][\w.\-\[\]()]+\.(?:mkv|mp4|avi))/i);
    const filename = filenameMatch ? filenameMatch[1] : "";

    items.push({ size, quality, codec, hdr, filename, downloadLinks });
  }

  return items;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveItemLinks(item, pageUrl) {
  const finalUrls = [];
  for (const link of item.downloadLinks) {
    if (link.includes("hubcloud") || link.match(/\/\?id=/)) {
      finalUrls.push(...await extractHubCloudLinks(link));
    } else if (link.includes("hubdrive")) {
      const h = await fetchHtml(link, pageUrl);
      if (h) {
        const hm = h.match(/href="([^"]*hubcloud[^"]*)"/);
        if (hm) {
          finalUrls.push(...await extractHubCloudLinks(hm[1]));
        }
      }
    } else if (link.match(/\.(mp4|mkv|avi)$/i)) {
      finalUrls.push(link);
    } else if (link.match(/gadgetsweb|hblink|redirect/i)) {
      const resolvedUrl = await resolveRedirect(link);
      if (resolvedUrl) finalUrls.push(resolvedUrl);
    }
  }
  return finalUrls;
}

async function isSeekable(url) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": UA, Referer: BASE_URLS[0] + "/", range: "bytes=0-0" },
    }, 6000);
    if (!res) return "inconclusive";
    if (res.status === 206 || res.status === 200) return "ok";
    return "dead";
  } catch {
    return "inconclusive";
  }
}

function linkPriority(url) {
  if (/r2\.cloudflarestorage|\.(mp4|mkv|avi)(\?|$)/i.test(url)) return 3;
  if (/pixeldrain/i.test(url)) return 2;
  return 1;
}

export async function resolve4khdhubPreview(d) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(d, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const { pageUrl, links } = payload || {};
  if (!pageUrl || !Array.isArray(links) || !links.length) return null;

  const cacheKey = `preview:${d}`;
  const cached = cacheGet(previewCache, cacheKey, RESOLVED_TTL);
  if (cached) return cached;

  const finalUrls = await resolveItemLinks({ downloadLinks: links }, pageUrl);
  const unique = [...new Set(finalUrls)];
  if (!unique.length) return null;

  unique.sort((a, b) => linkPriority(b) - linkPriority(a));

  const results = await mapLimit(unique, 4, async (u) => ({ u, s: await isSeekable(u) }));
  const ok = results.filter(r => r.s === "ok").map(r => r.u);
  const inconclusive = results.filter(r => r.s === "inconclusive").map(r => r.u);
  const chosen = ok[0] || inconclusive[0] || null;
  if (!chosen) return null;

  cacheSet(previewCache, cacheKey, chosen, RESOLVED_TTL);
  return chosen;
}

export async function try4KHDHub(imdbId, type, season, episode) {
  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;

    const title = tmdb.title || tmdb.name;
    if (!title) return null;

    const year = tmdb.release_date
      ? parseInt(tmdb.release_date.split("-")[0], 10)
      : tmdb.first_air_date
        ? parseInt(tmdb.first_air_date.split("-")[0], 10)
        : null;
    const isSeries = type === "series";

    const pageUrl = await searchContent(title, year, isSeries);
    if (!pageUrl) return null;

    const items = isSeries
      ? await loadSeriesContent(pageUrl, season != null ? Number(season) : null, episode != null ? Number(episode) : null)
      : await loadMovieContent(pageUrl);

    if (!items.length) return null;

    const streams = [];
    const seenUrls = new Set();

    const proxyOrigin = globalThis.__proxyOrigin;
    const lazy = !!(KHDHUB_LAZY_LOAD && proxyOrigin);

    if (lazy) {
      for (const item of items) {
        const parts = [item.quality || "Auto"];
        if (item.codec) parts.push(item.codec);
        if (item.hdr) parts.push(item.hdr);
        if (item.size) {
          const sizeStr = item.size >= 1024
            ? `${(item.size / 1024).toFixed(1)} TB`
            : `${item.size.toFixed(1)} GB`;
          parts.push(sizeStr);
        }

        const payload = Buffer.from(JSON.stringify({ pageUrl, links: item.downloadLinks })).toString("base64url");
        streams.push({
          url: `${proxyOrigin}/resolve?d=${payload}`,
          quality: item.quality || "Auto",
          referer: pageUrl,
          name: parts.slice(1).join(" · "),
        });
      }
    } else {
      const resolved = await mapLimit(items, 3, async (item) => ({
        item,
        finalUrls: await resolveItemLinks(item, pageUrl),
      }));

      for (const { item, finalUrls } of resolved) {
        for (const url of finalUrls) {
          const key = url.split("?")[0].split("#")[0];
          if (seenUrls.has(key)) continue;
          seenUrls.add(key);

          const parts = [item.quality || "Auto"];
          if (item.codec) parts.push(item.codec);
          if (item.hdr) parts.push(item.hdr);
          if (item.size) {
            const sizeStr = item.size >= 1024
              ? `${(item.size / 1024).toFixed(1)} TB`
              : `${item.size.toFixed(1)} GB`;
            parts.push(sizeStr);
          }

          streams.push({
            url,
            quality: item.quality || "Auto",
            referer: pageUrl,
            name: parts.slice(1).join(" · "),
          });
        }
      }
    }

    return streams.length ? streams : null;
  } catch (err) {
    console.error(`[scraper] 4khdhub error:`, err.message);
    return null;
  }
}
