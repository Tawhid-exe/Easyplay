const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const BASE_URLS = ["https://4khdhub.one", "https://4khdhub.fans"];
const TIMEOUT = 15000;

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
  if (/2160|4K/i.test(text)) return "2160p";
  if (/1080|FHD/i.test(text)) return "1080p";
  if (/720/i.test(text)) return "720p";
  const m = text.match(/(\d{3,4}p)/i);
  return m ? m[1].toLowerCase() : null;
}

async function fetchWithTimeout(url, options = {}, timeout = TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch {
    clearTimeout(id);
    return null;
  }
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

async function extractHubCloudLinks(pageUrl) {
  const res = await fetchWithTimeout(pageUrl, {
    headers: { "User-Agent": UA, Referer: BASE_URLS[0] + "/" },
  });
  if (!res || !res.ok) return [];
  const html = await res.text();

  const links = [];

  const urlMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (urlMatch) {
    const r2 = await fetchWithTimeout(urlMatch[1], {
      headers: { "User-Agent": UA, Referer: pageUrl },
    });
    if (r2 && r2.ok) {
      const html2 = await r2.text();
      const btnMatches = html2.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
      for (const btn of btnMatches) {
        let href = btn[1];
        if (href.startsWith("//")) href = "https:" + href;
        if (href.includes("pixeld")) {
          const uid = href.match(/\/u\/(\w+)/);
          if (uid) {
            links.push(`https://pixeldrain.dev/api/file/${uid[1]}?download`);
          }
        } else {
          links.push(href);
        }
      }
    }
  }

  const btnPattern = /<a\s[^>]*href="([^"]+)"[^>]*>.*?(?:FSL|PixelServer|Download|HubCloud|HubDrive).*?<\/a>/gi;
  let btnMatch;
  while ((btnMatch = btnPattern.exec(html)) !== null) {
    let href = btnMatch[1];
    if (href.startsWith("//")) href = "https:" + href;
    if (href.includes("pixeld")) {
      const uid = href.match(/\/u\/(\w+)/);
      if (uid && !links.some(l => l.includes(uid[1]))) {
        links.push(`https://pixeldrain.dev/api/file/${uid[1]}?download`);
      }
    } else if (!links.includes(href)) {
      links.push(href);
    }
  }

  return [...new Set(links)];
}

async function searchContent(title, year, isSeries) {
  const query = encodeURIComponent(`${title} ${year || ""}`.trim());

  for (const baseUrl of BASE_URLS) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/?s=${query}`, {
        headers: { "User-Agent": UA },
      });
      if (!res || !res.ok) continue;

      const html = await res.text();
      const cards = extractAll(html, '<div class="movie-card', "</a>");
      if (!cards.length) continue;

      let bestMatch = null;
      let bestScore = 0;

      for (const card of cards) {
        const hrefMatch = card.match(/href="([^"]+)"/);
        const titleMatch = card.match(/movie-card-title[^>]*>([^<]+)/i);
        const metaMatch = card.match(/movie-card-meta[^>]*>([^<]+)/i);
        const formatMatch = card.match(/movie-card-format[^>]*>([^<]+)/i);

        if (!hrefMatch || !titleMatch) continue;

        const cardTitle = titleMatch[1].trim();
        const cardYear = metaMatch ? parseInt(metaMatch[1].trim(), 10) : null;
        const cardFormat = formatMatch ? formatMatch[1].trim() : "";
        const isMovieCard = /movies/i.test(cardFormat);
        const isSeriesCard = /series/i.test(cardFormat);

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
          bestMatch = hrefMatch[1];
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
  const res = await fetchWithTimeout(pageUrl, {
    headers: { "User-Agent": UA, Referer: BASE_URLS[0] + "/" },
  });
  if (!res || !res.ok) return [];
  const html = await res.text();

  const items = [];
  const downloadItems = extractAll(html, '<div class="download-item', "</div>");

  for (const itemHtml of downloadItems) {
    const downloadLinks = [];
    const linkMatches = itemHtml.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
    for (const lm of linkMatches) {
      let href = lm[1];
      if (href.startsWith("//")) href = "https:" + href;
      if (href.startsWith("http")) downloadLinks.push(href);
    }
    if (!downloadLinks.length) continue;

    let size = null;
    const sizeMatch = itemHtml.match(/badge[^>]*style=["'][^"']*#ea580c[^"']*["'][^>]*>\s*([^<]+)/i);
    if (sizeMatch) size = parseSize(sizeMatch[1]);
    if (!size) {
      const gs = itemHtml.match(/([\d.]+)\s*(?:TB|GB|MB)/i);
      if (gs) size = parseSize(gs[0]);
    }

    const quality = parseQuality(itemHtml) || "Auto";

    const codec = /HEVC|H\.?265/i.test(itemHtml) ? "HEVC" : /H\.?264|AVC/i.test(itemHtml) ? "H.264" : "";
    const hdr = /Dolby\s*Vision|DV[^A-Za-z]|HDR(?:10)?/i.test(itemHtml) ? "HDR" : "";

    const filenameMatch = itemHtml.match(/([A-Z][\w.\-\[\]()]+\.(?:mkv|mp4|avi))/i);
    const filename = filenameMatch ? filenameMatch[1] : "";

    items.push({ size, quality, codec, hdr, filename, downloadLinks });
  }

  return items;
}

async function loadSeriesContent(pageUrl, season, episode) {
  const res = await fetchWithTimeout(pageUrl, {
    headers: { "User-Agent": UA, Referer: BASE_URLS[0] + "/" },
  });
  if (!res || !res.ok) return [];
  const html = await res.text();

  const items = [];
  const episodeItems = extractAll(html, "episode-download-item", "</div>");

  for (const itemHtml of episodeItems) {
    const epMatch = itemHtml.match(/Episode[-\s]*0*(\d+)/i);
    const epNum = epMatch ? parseInt(epMatch[1], 10) : null;
    const seasonMatch = itemHtml.match(/0*(\d+)x0*(\d+)/);
    const sNum = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    const epNum2 = seasonMatch ? parseInt(seasonMatch[2], 10) : null;

    const finalSeason = sNum;
    const finalEpisode = epNum2 !== null ? epNum2 : epNum;

    if (season != null && finalSeason !== null && finalSeason !== season) continue;
    if (episode != null && finalEpisode !== null && finalEpisode !== episode) continue;

    const downloadLinks = [];
    const linkMatches = itemHtml.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>/gi);
    for (const lm of linkMatches) {
      let href = lm[1];
      if (href.startsWith("//")) href = "https:" + href;
      if (href.startsWith("http")) downloadLinks.push(href);
    }
    if (!downloadLinks.length) continue;

    let size = null;
    const sizeMatch = itemHtml.match(/badge-size[^>]*>\s*([^<]+)/i);
    if (sizeMatch) size = parseSize(sizeMatch[1]);
    if (!size) {
      const gs = itemHtml.match(/([\d.]+)\s*(?:TB|GB|MB)/i);
      if (gs) size = parseSize(gs[0]);
    }

    const quality = parseQuality(itemHtml) || "Auto";
    const codec = /HEVC|H\.?265/i.test(itemHtml) ? "HEVC" : "";
    const hdr = /Dolby\s*Vision|DV[^A-Za-z]|HDR(?:10)?/i.test(itemHtml) ? "HDR" : "";

    const filenameMatch = itemHtml.match(/([A-Z][\w.\-\[\]()]+\.(?:mkv|mp4|avi))/i);
    const filename = filenameMatch ? filenameMatch[1] : "";

    items.push({ size, quality, codec, hdr, filename, downloadLinks });
  }

  return items;
}

async function convertImdbToTmdb(imdbId) {
  const apiKey = globalThis.__tmdbApiKey;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`,
      { headers: { "User-Agent": UA } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.movie_results?.[0] || data?.tv_results?.[0] || null;
  } catch {
    return null;
  }
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
      ? await loadSeriesContent(pageUrl, season ? Number(season) : null, episode ? Number(episode) : null)
      : await loadMovieContent(pageUrl);

    if (!items.length) return null;

    const streams = [];
    const seenUrls = new Set();

    for (const item of items) {
      const finalUrls = [];

      for (const link of item.downloadLinks) {
        if (link.includes("hubcloud") || link.match(/\/\?id=/)) {
          const hubUrls = await extractHubCloudLinks(link);
          finalUrls.push(...hubUrls);
        } else if (link.includes("hubdrive")) {
          const r = await fetchWithTimeout(link, {
            headers: { "User-Agent": UA, Referer: pageUrl },
          });
          if (r && r.ok) {
            const h = await r.text();
            const innerLinks = extractAll(h, "<a", "</a>");
            for (const il of innerLinks) {
              const hm = il.match(/href="([^"]+)"/);
              if (hm && hm[1].includes("hubcloud")) {
                const hubUrls = await extractHubCloudLinks(hm[1]);
                finalUrls.push(...hubUrls);
              }
            }
          }
        } else if (link.match(/\.(mp4|mkv|avi)$/i)) {
          finalUrls.push(link);
        } else if (link.match(/gadgetsweb|hblink|redirect/i)) {
          const resolved = await resolveRedirect(link);
          if (resolved) finalUrls.push(resolved);
        } else {
          finalUrls.push(link);
        }
      }

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
          name: parts.join(" · "),
        });
      }
    }

    return streams.length ? streams : null;
  } catch (err) {
    console.error(`[scraper] 4khdhub error:`, err.message);
    return null;
  }
}
