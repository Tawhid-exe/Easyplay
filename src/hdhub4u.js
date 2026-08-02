import { fetchWithTimeout, convertImdbToTmdb, fetchLiveDomains, parseQuality, parseSize, formatSize, linkPriority, mapLimit } from "./utils.js";
import { resolveLink } from "./extractors.js";
import { HDHUB4U_ENABLED, HDHUB4U_BASE_URLS, HDHUB4U_DOMAINS_URL, HDHUB4U_DOMAINS_KEY } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const HTML_TTL = 20 * 60 * 1000;
const TYPESENSE_URL = "https://search.pingora.fyi/collections/post/documents/search";

const htmlCache = new Map();

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
    headers: { "User-Agent": UA, Referer: referer || url },
  });
  if (!res || !res.ok) return null;
  const html = await res.text();
  cacheSet(htmlCache, url, html, HTML_TTL);
  return html;
}

async function getBaseUrls() {
  return fetchLiveDomains({
    domainsUrl: HDHUB4U_DOMAINS_URL,
    key: HDHUB4U_DOMAINS_KEY,
    fallback: HDHUB4U_BASE_URLS,
  });
}

async function searchTypesense(imdbId, title, year, isSeries, season) {
  const base = (await getBaseUrls())[0];
  if (!base) return null;
  const origin = new URL(base).origin;
  const params = new URLSearchParams({
    q: title,
    query_by: "post_title,category,stars,director,imdb_id",
    query_by_weights: "4,2,2,2,4",
    sort_by: "sort_by_date:desc",
    limit: "30",
    highlight_fields: "none",
    use_cache: "true",
    page: "1",
  });
  const res = await fetchWithTimeout(`${TYPESENSE_URL}?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: base + "/",
      Origin: origin,
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const hits = data?.hits || [];
  if (!hits.length) return null;

  const docs = hits.map(h => h.document).filter(d => d && d.permalink);

  if (imdbId) {
    const imdbDocs = docs.filter(d => d.imdb_id === imdbId);
    if (imdbDocs.length) {
      const picked = isSeries && season != null
        ? imdbDocs.find(d => new RegExp(`\\bseason\\s*${Number(season)}\\b`, "i").test(d.post_title || "")) || imdbDocs[0]
        : imdbDocs[0];
      return base + picked.permalink;
    }
  }

  const q = title.toLowerCase();
  let best = null;
  let bestScore = 5;
  for (const d of docs) {
    const t = (d.post_title || "").toLowerCase();
    if (!t) continue;
    let score = 0;
    if (t.includes(q) || q.includes(t)) score += 6;
    if (year && new RegExp(`\\b${year}\\b`).test(d.post_title || "")) score += 4;
    if (isSeries && season != null && new RegExp(`\\bseason\\s*${Number(season)}\\b`, "i").test(d.post_title || "")) score += 6;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best ? base + best.permalink : null;
}

const NOISE_RE = /^(\/|#|\?)|(wp-|wp-content|wp-admin|\/feed|\/page\/|\/tag\/|\/category\/|\/author\/|\/search|\?s=|\/login|\/register|\/cdn-cgi|\/rss|\/comment|twitter|facebook|reddit|telegram|pinterest)/i;
const CONTENT_RE = /\/(movies|series|episodes|episode|watch|download)\//i;
const HOSTER_RE = /hubcloud|hubcdn|hubdrive|pixeldrain|streamtape|streamhub|hblink|gadgetsweb|techyboy|doodstream|redirect|\?id=|\.mp4|\.mkv|\.avi|m3u8/i;

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function scoreCandidate(href, text, title, year, isSeries) {
  let score = 0;
  if (isSeries) {
    if (/\/(series|episodes|episode)\//i.test(href)) score += 8;
  } else {
    if (/\/movies?\//i.test(href)) score += 8;
    else if (/\/series\//i.test(href)) score -= 4;
  }
  const q = title.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q) || q.includes(t)) score += 6;
  if (year) {
    if (new RegExp(`\\b${year}\\b`).test(text)) score += 5;
    else {
      const m = text.match(/\b(19\d{2}|20\d{2})\b/);
      if (m && Math.abs(parseInt(m[1], 10) - year) <= 1) score += 3;
    }
  }
  return score;
}

async function searchWordpress(title, year, isSeries) {
  const query = encodeURIComponent(`${title} ${year || ""}`.trim());
  for (const baseUrl of await getBaseUrls()) {
    try {
      const html = await fetchHtml(`${baseUrl}/?s=${query}`, baseUrl + "/");
      if (!html) continue;
      const anchors = html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
      let best = null;
      let bestScore = 3;
      for (const a of anchors) {
        let href = a[1];
        if (href.startsWith("//")) href = "https:" + href;
        if (!/^https?:/.test(href)) continue;
        if (NOISE_RE.test(href)) continue;
        const text = stripTags(a[2]);
        if (!text || text.length < 2) continue;
        const score = scoreCandidate(href, text, title, year, isSeries);
        if (score > bestScore) {
          bestScore = score;
          best = href;
        }
      }
      if (best) return best;
    } catch {
      continue;
    }
  }
  return null;
}

function collectHosterAnchors(html) {
  const items = [];
  const seen = new Set();
  const anchors = html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const a of anchors) {
    let href = a[1];
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/.test(href)) continue;
    if (!HOSTER_RE.test(href)) continue;
    const key = href.split("?")[0].split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ href, label: stripTags(a[2]) });
  }
  return items;
}

function contextText(html, idx, before = 400, after = 120) {
  return stripTags(html.slice(Math.max(0, idx - before), idx + after));
}

async function extractFromPage(pageUrl) {
  const html = await fetchHtml(pageUrl, pageUrl);
  if (!html) return [];
  const anchors = collectHosterAnchors(html);
  const items = [];
  for (const a of anchors) {
    const idx = html.indexOf(a.href);
    const ctx = contextText(html, idx);
    items.push({
      href: a.href,
      label: a.label,
      quality: parseQuality(ctx) || parseQuality(a.label) || "Auto",
      size: parseSize(ctx),
    });
  }
  return items;
}

function matchesEpisode(url, season, episode) {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const target = new RegExp(`S${s}E${e}`, "i");
  if (target.test(url)) return true;
  const pat = new RegExp(`\\bE${e}(?!\\d)`, "i");
  const anyEp = /(?:S\d{2}E\d{2})/i;
  if (!anyEp.test(url)) return null;
  return pat.test(url);
}

export async function tryHDHub4u(imdbId, type, season, episode) {
  if (!HDHUB4U_ENABLED) return null;
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

    let pageUrl = await searchTypesense(imdbId, title, year, isSeries, isSeries ? Number(season) : null);
    if (!pageUrl) pageUrl = await searchWordpress(title, year, isSeries);
    if (!pageUrl) return null;

    const items = await extractFromPage(pageUrl);
    if (!items.length) return null;

    const resolved = await mapLimit(items, 5, async (item) => ({
      item,
      links: await resolveLink(item.href, pageUrl),
    }));

    const streams = [];
    const seenUrls = new Set();
    for (const { item, links } of resolved) {
      for (const url of links) {
        const key = url.split("?")[0].split("#")[0];
        if (seenUrls.has(key)) continue;
        if (isSeries && season != null && episode != null) {
          const m = matchesEpisode(url, season, episode);
          if (m === false) continue;
        }
        seenUrls.add(key);
        const parts = [item.quality];
        if (item.size) parts.push(formatSize(item.size));
        if (item.label) parts.push(item.label.slice(0, 40));
        streams.push({
          url,
          quality: item.quality,
          referer: pageUrl,
          name: parts.slice(1).join(" · "),
        });
      }
    }

    if (!streams.length) return null;
    streams.sort((a, b) => linkPriority(b.url) - linkPriority(a.url));
    return streams.slice(0, 12);
  } catch (err) {
    console.error(`[scraper] hdhub4u error:`, err.message);
    return null;
  }
}
