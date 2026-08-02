import { fetchWithTimeout, convertImdbToTmdb, parseSize, parseQuality, extractBlocks, formatSize, parseCodec, parseHdr, isSeekable, linkPriority, mapLimit } from "./utils.js";
import { resolveLink } from "./extractors.js";
import { KHDHUB_LAZY_LOAD } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const BASE_URLS = ["https://4khdhub.one", "https://4khdhub.fans"];
const TIMEOUT = 10000;
const HTML_TTL = 20 * 60 * 1000;
const RESOLVED_TTL = 10 * 60 * 1000;

const htmlCache = new Map();
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
    const codec = parseCodec(block);
    const hdr = parseHdr(block);

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
    const codec = parseCodec(block);
    const hdr = parseHdr(block);

    const filenameMatch = block.match(/([A-Z][\w.\-\[\]()]+\.(?:mkv|mp4|avi))/i);
    const filename = filenameMatch ? filenameMatch[1] : "";

    items.push({ size, quality, codec, hdr, filename, downloadLinks });
  }

  return items;
}

async function resolveItemLinks(item, pageUrl) {
  const finalUrls = [];
  for (const link of item.downloadLinks) {
    finalUrls.push(...await resolveLink(link, pageUrl));
  }
  return finalUrls;
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

  const results = await mapLimit(unique, 4, async (u) => ({ u, s: await isSeekable(u, { referer: pageUrl }) }));
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
        if (item.size) parts.push(formatSize(item.size));

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
          if (item.size) parts.push(formatSize(item.size));

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
