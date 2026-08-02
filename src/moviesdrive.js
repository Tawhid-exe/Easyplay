import { fetchWithTimeout, convertImdbToTmdb, fetchLiveDomains, parseQuality, parseSize, formatSize, linkPriority, mapLimit } from "./utils.js";
import { resolveLink } from "./extractors.js";
import { MOVIESDRIVE_ENABLED, MOVIESDRIVE_BASE_URLS, MOVIESDRIVE_DOMAINS_URL, MOVIESDRIVE_DOMAINS_KEY } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const HTML_TTL = 20 * 60 * 1000;

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
    domainsUrl: MOVIESDRIVE_DOMAINS_URL,
    key: MOVIESDRIVE_DOMAINS_KEY,
    fallback: MOVIESDRIVE_BASE_URLS,
  });
}

const HOSTER_RE = /hubcloud|hubcdn|hubdrive|pixeldrain|streamtape|streamhub|hblink|gadgetsweb|techyboy|doodstream|redirect|\?id=|\.mp4|\.mkv|\.avi|m3u8/i;
const NOISE_RE = /^(\/|#|\?)|(wp-|wp-content|wp-admin|\/feed|\/page\/|\/tag\/|\/category\/|\/author\/|\/search\/|\/login|\/register|\/cdn-cgi|\/rss|\/comment|twitter|facebook|reddit|telegram|pinterest)/i;

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function headText(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ").replace(/&amp;/g, "&").replace(/&ndash;|&mdash;/g, "-").replace(/\s+/g, " ").trim();
}

function titleWords(title) {
  return (title.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
}

function hitScore(postTitle, title, year) {
  const words = titleWords(title);
  if (!words.length) return 0;
  const t = postTitle.toLowerCase();
  let matched = 0;
  for (const w of words) {
    const re = new RegExp(`\\b${w}\\b`);
    if (re.test(t)) matched++;
  }
  let score = matched / words.length;
  if (year) {
    if (t.includes(String(year))) score += 0.5;
    else {
      const found = t.match(/\b(19\d{2}|20\d{2})\b/);
      if (found && Math.abs(parseInt(found[0], 10) - year) <= 1) score += 0.2;
    }
  }
  return score;
}

async function searchPost(title, year, imdbId, isSeries) {
  const query = encodeURIComponent(`${title} ${year || ""}`.trim());
  for (const baseUrl of await getBaseUrls()) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/search.php?q=${query}&page=1`, {
        headers: { "User-Agent": UA, Referer: `${baseUrl}/` },
      });
      if (res && res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.hits) && data.hits.length) {
          let best = null;
          let bestScore = 0;
          for (const hit of data.hits) {
            const doc = hit.document || {};
            const postTitle = doc.post_title || "";
            const permalink = doc.permalink || "";
            let score = hitScore(postTitle, title, year);
            if (isSeries && /\bseason/i.test(postTitle)) score += 0.2;
            if (doc.imdb_id && doc.imdb_id.toLowerCase() === imdbId.toLowerCase()) score += 1;
            if (score > bestScore) {
              bestScore = score;
              best = permalink.startsWith("http") ? permalink : baseUrl + (permalink.startsWith("/") ? permalink : "/" + permalink);
            }
          }
          if (best && bestScore >= 0.4) return best;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function collectHeadings(html) {
  const headings = [];
  const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  while ((m = re.exec(html))) {
    headings.push({ idx: m.index, end: re.lastIndex, text: headText(m[1]) });
  }
  return headings;
}

function collectAnchors(html) {
  const anchors = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].replace(/&amp;/gi, "&").replace(/&#0*39;/g, "'").replace(/&quot;/gi, '"');
    if (href.startsWith("//")) href = "https:" + href;
    anchors.push({ idx: m.index, href, label: headText(m[2]) });
  }
  return anchors;
}

function nearestBefore(headings, anchorIdx, extract) {
  let best = null;
  for (const h of headings) {
    if (h.end >= anchorIdx) break;
    const v = extract(h.text);
    if (v !== null) best = v;
  }
  return best;
}

function seasonOf(text) {
  const s = text.match(/Season\s*0*(\d+)/i);
  return s ? parseInt(s[1], 10) : null;
}

function parseSeasonSections(html) {
  const archives = [];
  const hosters = [];
  const seen = new Set();
  const headings = collectHeadings(html);
  for (const a of collectAnchors(html)) {
    if (NOISE_RE.test(a.href)) continue;
    const season = nearestBefore(headings, a.idx, seasonOf);
    if (/(mdrive\.lol|moviesdrive)/i.test(a.href)) {
      if (/\/archive\/\d+/i.test(a.href)) {
        const key = a.href.split("?")[0];
        if (!seen.has(key)) {
          seen.add(key);
          archives.push({ season, quality: parseQuality(a.label) || "Auto", url: key });
        }
      }
    } else if (HOSTER_RE.test(a.href)) {
      const key = /search-recover\.php/i.test(a.href) ? a.href : a.href.split("?")[0];
      if (!seen.has(key)) {
        seen.add(key);
        const ctx = html.slice(Math.max(0, a.idx - 300), a.idx + 120);
        hosters.push({ season, href: a.href, label: a.label, quality: parseQuality(ctx) || parseQuality(a.label) || "Auto", size: parseSize(ctx) });
      }
    }
  }
  return { archives, hosters };
}

function episodeFromHeading(txt) {
  let m = txt.match(/\bEp(?:isode)?\.?\s*0*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = txt.match(/\bE\s*0*(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseArchivePage(html, episode) {
  const out = [];
  const seen = new Set();
  const headings = collectHeadings(html);
  for (const a of collectAnchors(html)) {
    if (!/^https?:/.test(a.href)) continue;
    if (!HOSTER_RE.test(a.href)) continue;
    const key = /search-recover\.php/i.test(a.href) ? a.href : a.href.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const ep = nearestBefore(headings, a.idx, (t) => episodeFromHeading(t));
    if (episode != null && ep !== null && ep !== Number(episode)) continue;
    const ctx = html.slice(Math.max(0, a.idx - 300), a.idx + 120);
    out.push({ href: a.href, label: a.label, quality: parseQuality(ctx) || parseQuality(a.label) || "Auto", size: parseSize(ctx) });
  }
  return out;
}

export async function tryMoviesDrive(imdbId, type, season, episode) {
  if (!MOVIESDRIVE_ENABLED) return null;
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

    const postUrl = await searchPost(title, year, imdbId, isSeries);
    if (!postUrl) return null;

    const postHtml = await fetchHtml(postUrl, postUrl);
    if (!postHtml) return null;
    const { archives, hosters } = parseSeasonSections(postHtml);

    const wantSeason = isSeries ? (season != null ? Number(season) : null) : null;
    const wantEpisode = isSeries ? (episode != null ? Number(episode) : null) : null;

    const archiveUrls = wantSeason != null ? archives.filter((a) => a.season === wantSeason).map((a) => a.url) : archives.map((a) => a.url);

    const raw = [...hosters.filter((h) => wantSeason == null || h.season == null || h.season === wantSeason)];
    const archiveItems = await mapLimit([...new Set(archiveUrls)].slice(0, 4), 3, async (url) => {
      const html = await fetchHtml(url, url);
      if (!html) return [];
      const items = parseArchivePage(html, wantEpisode);
      for (const it of items) {
        const q = html.match(/\[(\d+(?:\.\d+)?)\s*(GB|MB)(?:\/E)?\]/i);
        if (q && !it.size) it.size = parseFloat(q[1]) * (q[2].toUpperCase() === "GB" ? 1024 : 1);
      }
      return items;
    });
    for (const items of archiveItems) raw.push(...items);

    if (!raw.length) return null;

    const resolved = await mapLimit(raw, 4, async (item) => ({
      item,
      links: await resolveLink(item.href, postUrl),
    }));

    const streams = [];
    const seenUrls = new Set();
    for (const { item, links } of resolved) {
      for (const url of links) {
        const key = url.split("?")[0].split("#")[0];
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        const parts = [];
        if (item.size) parts.push(formatSize(item.size));
        if (item.label) parts.push(item.label.slice(0, 40));
        streams.push({
          url,
          quality: item.quality,
          referer: postUrl,
          name: parts.join(" · "),
        });
      }
    }

    if (!streams.length) return null;
    streams.sort((a, b) => linkPriority(b.url) - linkPriority(a.url));
    return streams.slice(0, 12);
  } catch (err) {
    console.error(`[scraper] moviesdrive error:`, err.message);
    return null;
  }
}
