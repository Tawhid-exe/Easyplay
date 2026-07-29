import { SCRAPE_URL, SCRAPE_ALT_URL, STREAMDATA_API_URL } from "./config.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function headers(referer) {
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: referer || "https://nextgencloudfabric.com/",
  };
}

function extractM3u8(text) {
  const m = text.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/);
  return m ? m[0].replace(/\\/g, "") : null;
}

async function fetchFollow(url, referer, cookie) {
  const res = await fetch(url, {
    headers: { ...headers(referer), ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "follow",
  });
  if (!res.ok) return null;
  return {
    body: await res.text(),
    finalUrl: res.url,
    cookie: res.headers.get("set-cookie") || cookie || "",
  };
}

async function getVidApiSession(imdbId, type, season, episode) {
  try {
    const path = type === "series"
      ? `/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
      : `/embed/movie/${imdbId}`;
    const playerUrl = `https://nextgencloudfabric.com${path}`;

    const res = await fetch(playerUrl, {
      headers: headers("https://streamimdb.ru/"),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const html = await res.text();
    const playToken = html.match(/"playToken"\s*:\s*"([^"]+)"/);
    const sessionCookie = res.headers.get("set-cookie") || "";

    if (!playToken) return null;

    return {
      playToken: playToken[1],
      sessionCookie,
      playerUrl,
    };
  } catch {
    return null;
  }
}

async function extractQuality(streamUrl, referer, cookie) {
  try {
    const proxyOrigin = globalThis.__proxyOrigin || "http://localhost:8788";
    const encodedUrl = encodeURIComponent(streamUrl);
    const proxyUrl = `${proxyOrigin}/proxy/hls?url=${encodedUrl}&referer=${encodeURIComponent(referer)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ""}`;
    const res = await fetch(proxyUrl, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const text = await res.text();
    const resolutions = [...text.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)/g)];
    const heights = resolutions.map(r => parseInt(r[2], 10)).filter(h => !isNaN(h));
    if (!heights.length) return null;
    const maxH = Math.max(...heights);
    return `${maxH}p`;
  } catch {
    return null;
  }
}

async function tryVidApiDirect(imdbId, type, season, episode) {
  try {
    const session = await getVidApiSession(imdbId, type, season, episode);

    let url = `${STREAMDATA_API_URL}?imdb=${imdbId}&type=${type === "series" ? "tv" : "movie"}`;
    if (type === "series" && season != null && episode != null) {
      url += `&season=${season}&episode=${episode}`;
    }
    if (session?.playToken) {
      url += `&playToken=${session.playToken}`;
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: session?.playerUrl || "https://nextgencloudfabric.com/",
        Origin: "https://nextgencloudfabric.com",
        ...(session?.sessionCookie ? { Cookie: session.sessionCookie } : {}),
      },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (data.status_code !== "200" || !data.data?.stream_urls?.length) return null;

    const rawUrls = data.data.stream_urls;
    const referer = session?.playerUrl || "https://nextgencloudfabric.com/";
    const cookie = session?.sessionCookie || "";

    const qualities = await Promise.all(
      rawUrls.map(u => extractQuality(u, referer, cookie))
    );

    return rawUrls.map((streamUrl, i) => ({
      url: `/proxy/hls?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ""}`,
      quality: qualities[i] || "Auto",
      originalUrl: streamUrl,
      referer,
      cookie,
    }));
  } catch (err) {
    console.error(`[scraper] vidapi direct error:`, err.message);
    return null;
  }
}

async function tryStreamImdbEmbed(imdbId, type, season, episode) {
  const path = type === "series"
    ? `/embed/${imdbId}/${season}/${episode}/`
    : `/embed/movie/${imdbId}`;
  const embedUrl = `${SCRAPE_URL}${path}`;

  try {
    const result = await fetchFollow(embedUrl, "https://streamimdb.ru/");
    if (!result) return null;

    const iframeMatch = result.body.match(/<iframe[^>]+src="([^"]+)"/);
    if (!iframeMatch) {
      const m3u8 = extractM3u8(result.body);
      if (m3u8) return [{ url: m3u8, quality: "Auto" }];
      return null;
    }

    let iframeSrc = iframeMatch[1];
    if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;

    const player = await fetchFollow(iframeSrc, embedUrl, result.cookie);
    if (!player) return null;

    const streams = [];
    const m3u8 = extractM3u8(player.body);
    if (m3u8) streams.push({ url: m3u8, quality: "Auto", referer: iframeSrc });

    const sourcesMatch = player.body.match(/"sources"\s*:\s*(\[[\s\S]*?\])\s*[;}]/);
    if (sourcesMatch) {
      try {
        const sources = JSON.parse(sourcesMatch[1]);
        for (const s of sources) {
          const url = s.file || s.src || s.url;
          if (!url) continue;
          const label = s.label || s.type || "Auto";
          if (url.includes(".m3u8") || url.includes(".mp4") || url.includes(".mkv")) {
            streams.push({ url, quality: label, referer: iframeSrc });
          }
        }
      } catch {}
    }

    if (streams.length) return streams;
    return null;
  } catch (err) {
    console.error(`[scraper] streamimdb.ru error:`, err.message);
    return null;
  }
}

async function tryStreamImdbMe(imdbId, type, season, episode) {
  const path = type === "series"
    ? `/embed/${imdbId}/${season}/${episode}/`
    : `/embed/${imdbId}/`;
  const embedUrl = `${SCRAPE_ALT_URL}${path}`;

  try {
    const result = await fetchFollow(embedUrl, "https://streamimdb.me/");
    if (!result) return null;

    const iframeMatch = result.body.match(/id="player_iframe"[^>]+src="([^"]+)"/);
    if (!iframeMatch) {
      const m3u8 = extractM3u8(result.body);
      if (m3u8) return [{ url: m3u8, quality: "Auto" }];
      return null;
    }

    let iframeSrc = iframeMatch[1];
    if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;

    const player = await fetchFollow(iframeSrc, embedUrl, result.cookie);
    if (!player) return null;

    const streams = [];
    const m3u8 = extractM3u8(player.body);
    if (m3u8) streams.push({ url: m3u8, quality: "Auto", referer: iframeSrc });

    const sourcesMatch = player.body.match(/"sources"\s*:\s*(\[[\s\S]*?\])\s*[;}]/);
    if (sourcesMatch) {
      try {
        const sources = JSON.parse(sourcesMatch[1]);
        for (const s of sources) {
          const url = s.file || s.src || s.url;
          if (!url) continue;
          const label = s.label || s.type || "Auto";
          if (url.includes(".m3u8") || url.includes(".mp4") || url.includes(".mkv")) {
            streams.push({ url, quality: label, referer: iframeSrc });
          }
        }
      } catch {}
    }

    if (streams.length) return streams;
    return null;
  } catch (err) {
    console.error(`[scraper] streamimdb.me error:`, err.message);
    return null;
  }
}

async function tryMultiEmbed(imdbId, type, season, episode) {
  const url = type === "series"
    ? `https://multiembed.mov/directstream.php?video_id=${imdbId}&s=${season}&e=${episode}`
    : `https://multiembed.mov/directstream.php?video_id=${imdbId}`;

  try {
    const res = await fetch(url, {
      headers: headers("https://multiembed.mov/"),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const finalUrl = res.url;
    if (finalUrl.includes(".m3u8")) {
      return [{ url: finalUrl, quality: "Auto", referer: "https://multiembed.mov/" }];
    }

    const body = await res.text();
    const m3u8 = extractM3u8(body);
    if (m3u8) return [{ url: m3u8, quality: "Auto", referer: "https://multiembed.mov/" }];

    const sourcesMatch = body.match(/"sources"\s*:\s*(\[[\s\S]*?])/);
    if (sourcesMatch) {
      try {
        const sources = JSON.parse(sourcesMatch[1]);
        const valid = sources.filter(s => {
          const url = s.file || s.src || s.url;
          return url && (url.includes(".m3u8") || url.includes(".mp4"));
        }).map(s => ({
          url: s.file || s.src || s.url,
          quality: s.label || s.type || "Auto",
          referer: "https://multiembed.mov/",
        }));
        if (valid.length) return valid;
      } catch {}
    }

    return null;
  } catch (err) {
    console.error(`[scraper] multiembed error:`, err.message);
    return null;
  }
}

export async function scrapeStreams({ type, imdbId, season, episode }) {
  const sources = [
    () => tryVidApiDirect(imdbId, type, season, episode),
    () => tryStreamImdbEmbed(imdbId, type, season, episode),
    () => tryStreamImdbMe(imdbId, type, season, episode),
    () => tryMultiEmbed(imdbId, type, season, episode),
  ];

  for (const trySource of sources) {
    try {
      const result = await trySource();
      if (result && result.length > 0) {
        return result;
      }
    } catch (err) {
      console.error(`[scraper] source error:`, err.message);
    }
  }

  return [];
}
