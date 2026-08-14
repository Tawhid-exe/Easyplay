import { fetchWithTimeout, convertImdbToTmdb, fetchLiveDomains, parseQuality, parseSize, formatSize, mapLimit } from "./utils.js";
import { VEGAMOVIES_ENABLED, VEGAMOVIES_BASE_URLS, VEGAMOVIES_DOMAINS_URL, VEGAMOVIES_DOMAINS_KEY } from "./config.js";

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
    domainsUrl: VEGAMOVIES_DOMAINS_URL,
    key: VEGAMOVIES_DOMAINS_KEY,
    fallback: VEGAMOVIES_BASE_URLS,
  });
}

function htmlText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(href, base) {
  if (!href) return "";
  const h = href.replace(/&amp;/gi, "&");
  if (/^https?:/i.test(h)) return h;
  if (h.startsWith("//")) return "https:" + h;
  const baseUrl = base.replace(/\/$/, "");
  return baseUrl + (h.startsWith("/") ? h : "/" + h);
}

function baseOf(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : "";
}

function titleWords(title) {
  return (String(title).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
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

async function searchPost(title, year, imdbId) {
  const query = encodeURIComponent(`${title} ${year || ""}`.trim());
  for (const baseUrl of await getBaseUrls()) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/search.php?q=${query}&page=1`, {
        headers: { "User-Agent": UA, Referer: `${baseUrl}/` },
      });
      if (res && res.ok) {
        const data = await res.json();
        const hits = (data && data.hits) || [];
        if (hits.length) {
          if (imdbId) {
            const imdbHit = hits.find((h) => {
              const d = h.document || {};
              return d.imdb_id && String(d.imdb_id).toLowerCase() === String(imdbId).toLowerCase();
            });
            if (imdbHit && imdbHit.document && imdbHit.document.permalink) {
              return absUrl(imdbHit.document.permalink, baseUrl);
            }
          }
          let best = null;
          let bestScore = 0;
          for (const hit of hits) {
            const doc = hit.document || {};
            const postTitle = doc.post_title || "";
            const permalink = doc.permalink || "";
            if (!permalink) continue;
            const score = hitScore(postTitle, title, year);
            if (score > bestScore) {
              bestScore = score;
              best = absUrl(permalink, baseUrl);
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

function cleanTitle(raw) {
  let t = htmlText(raw).replace(/^\s*download\s+/i, "");
  t = t.split(/\s*\(/)[0].split(/\bseason\b/i)[0].split(/\bS0?\d/i)[0];
  return t.trim() || htmlText(raw).trim();
}

// Movie: anchors wrapping a `.dwd-button` point at per-quality intermediate pages.
function movieLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?dwd-button/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

// Series: quality headers ("Season N … 1080p") -> the intermediate link in the
// following <p> -> that page's V-Cloud links, one per episode in order.
function seriesQualityHeaders(html) {
  const headers = [];
  const re = /<h[35][^>]*>([\s\S]*?)<\/h[35]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = htmlText(m[1]);
    if (/\bzip\b/i.test(text)) continue;
    if (!/(4K|\d{3,4}p)/i.test(text)) continue;
    headers.push({ idx: m.index, end: re.lastIndex, text });
  }
  return headers;
}

function intermediateLinkAfter(html, fromIdx) {
  const after = html.slice(fromIdx, fromIdx + 2000);
  const anchors = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(after)) !== null) {
    anchors.push({ href: m[1], text: htmlText(m[2]) });
  }
  const vcloud = anchors.find((a) => /V-?Cloud/i.test(a.text));
  if (vcloud) return vcloud.href;
  const fallback = anchors.find((a) => /Episode|Download|G-?Direct/i.test(a.text));
  return fallback ? fallback.href : null;
}

function vcloudAnchors(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/vcloud/i.test(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

async function seriesGroups(html, main) {
  const jobs = [];
  for (const header of seriesQualityHeaders(html)) {
    const season = parseInt((header.text.match(/(?:Season |S)0?(\d+)/i) || [])[1], 10) || 1;
    const inter = intermediateLinkAfter(html, header.end);
    if (!inter) continue;
    jobs.push(
      fetchHtml(absUrl(inter, main), main + "/").then((doc) => ({
        season,
        links: doc ? vcloudAnchors(doc) : [],
      }))
    );
  }
  const groups = await Promise.all(jobs);
  const byEp = new Map();
  for (const g of groups) {
    for (let i = 0; i < g.links.length; i++) {
      const key = `${g.season}|${i + 1}`;
      if (!byEp.has(key)) byEp.set(key, []);
      byEp.get(key).push(g.links[i]);
    }
  }
  return byEp;
}

function decodeDoubleBase64(s) {
  try {
    return Buffer.from(Buffer.from(s, "base64").toString(), "base64").toString();
  } catch {
    return "";
  }
}

function vcloudVarUrl(html) {
  const b64 = (html.match(/var\s+url\s*=\s*atob\(atob\('([^']+)'\)\)/) || [])[1];
  if (b64) return { token: decodeDoubleBase64(b64) };
  const direct = (html.match(/var\s+url\s*=\s*'([^']+)'/) || [])[1];
  if (direct) return { direct };
  return null;
}

async function resolveVcloud(url) {
  const html = await fetchHtml(url, url);
  if (!html) return null;

  let fileUrl = "";
  if (url.indexOf("/video/") !== -1) {
    fileUrl = (html.match(/<div class="vd">[\s\S]*?<a[^>]+href="([^"]+)"/i) || [])[1] || "";
  } else {
    const found = vcloudVarUrl(html);
    if (found && found.token) {
      const tokenHtml = await fetchHtml(found.token, url);
      if (tokenHtml) {
        const next = vcloudVarUrl(tokenHtml);
        if (next && next.direct) fileUrl = next.direct;
      }
    } else if (found && found.direct) {
      fileUrl = found.direct;
    }
  }
  if (!fileUrl) return null;
  if (!/^https?:/i.test(fileUrl)) fileUrl = baseOf(url) + (fileUrl.startsWith("/") ? fileUrl : "/" + fileUrl);

  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const sizeText = htmlText((html.match(/id=["']size["'][^>]*>([\s\S]*?)<\//) || [])[1] || "");
  const size = parseSize(sizeText) || null;
  const quality = parseQuality(title) || parseQuality(url) || "Auto";

  const nameParts = [];
  if (size) nameParts.push(formatSize(size));
  nameParts.push("V-Cloud");
  return [{ url: fileUrl, quality, name: nameParts.join(" · ") }];
}

async function resolveIntermediate(link, main) {
  if (/vcloud/i.test(link)) return resolveVcloud(link);
  const html = await fetchHtml(absUrl(link, main), main + "/");
  if (!html) return [];
  const vlinks = vcloudAnchors(html);
  const lists = await mapLimit(vlinks.slice(0, 4), 3, (v) => resolveVcloud(v));
  return lists.flat().filter(Boolean);
}

export async function tryVegaMovies(imdbId, type, season, episode) {
  if (!VEGAMOVIES_ENABLED) return null;
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

    const postUrl = await searchPost(title, year, imdbId);
    if (!postUrl) return null;

    const main = (await getBaseUrls())[0] || VEGAMOVIES_BASE_URLS[0];
    const postHtml = await fetchHtml(postUrl, main + "/");
    if (!postHtml) return null;

    let intermediates = [];
    let wantEpisode = null;
    if (type === "series" && season != null) {
      const groups = await seriesGroups(postHtml, main);
      const key = `${Number(season)}|${Number(episode)}`;
      const links = groups.get(key) || groups.get(`${Number(season)}|1`);
      if (!links || !links.length) return null;
      intermediates = links.slice(0, 6);
      wantEpisode = Number(episode);
    } else {
      intermediates = movieLinks(postHtml);
      if (!intermediates.length) return null;
    }

    const lists = await mapLimit(intermediates.slice(0, 6), 3, (link) => resolveIntermediate(link, main));

    const streams = [];
    const seenUrls = new Set();
    for (const list of lists) {
      for (const s of list || []) {
        const key = s.url.split("?")[0].split("#")[0];
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        streams.push({
          ...s,
          referer: baseOf(s.url) + "/",
          ...(wantEpisode != null ? { note: `Episode ${wantEpisode}` } : {}),
        });
      }
    }

    if (!streams.length) return null;
    streams.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
    return streams.slice(0, 12);
  } catch (err) {
    console.error(`[scraper] vegamovies error:`, err.message);
    return null;
  }
}
