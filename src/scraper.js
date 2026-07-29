import { SCRAPE_URL, SCRAPE_ALT_URL, STREAMDATA_API_URL, VIDLINK_BASE, ENC_VIDLINK_URL } from "./config.js";
import { tryMovieWeb } from "./moview.js";
import { try4KHDHub } from "./4khdhub.js";
import { tryVixSrc } from "./vixsrc.js";
import { fetchWithTimeout, headers, extractM3u8, convertImdbToTmdb } from "./utils.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function fetchFollow(url, referer, cookie) {
  const res = await fetchWithTimeout(url, {
    headers: { ...headers(referer), ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "follow",
  });
  if (!res || !res.ok) return null;
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

    const res = await fetchWithTimeout(playerUrl, {
      headers: headers("https://streamimdb.ru/"),
      redirect: "follow",
    });
    if (!res || !res.ok) return null;

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

function labelQuality(height) {
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 540) return "540p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return "240p";
}

async function extractVariants(masterUrl, referer, cookie) {
  try {
    const proxyOrigin = globalThis.__proxyOrigin || "http://localhost:8788";
    const encodedUrl = encodeURIComponent(masterUrl);
    const proxyUrl = `${proxyOrigin}/proxy/hls/stream.m3u8?url=${encodedUrl}&referer=${encodeURIComponent(referer)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ""}`;
    const res = await fetchWithTimeout(proxyUrl, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!res || !res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n");
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      if (!resolutionMatch) continue;
      const height = parseInt(resolutionMatch[2], 10);
      if (isNaN(height)) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const urlLine = lines[j].trim();
        if (!urlLine || urlLine.startsWith("#")) continue;
        variants.push({ proxyUrl: urlLine, quality: labelQuality(height), height });
        break;
      }
    }

    if (!variants.length) return null;
    variants.sort((a, b) => b.height - a.height);
    return variants;
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

    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": UA,
        Referer: session?.playerUrl || "https://nextgencloudfabric.com/",
        Origin: "https://nextgencloudfabric.com",
        ...(session?.sessionCookie ? { Cookie: session.sessionCookie } : {}),
      },
    });
    if (!res || !res.ok) return null;

    const data = await res.json();
    if (data.status_code !== "200" || !data.data?.stream_urls?.length) return null;

    const referer = session?.playerUrl || "https://nextgencloudfabric.com/";
    const cookie = session?.sessionCookie || "";
    const variants = await extractVariants(data.data.stream_urls[0], referer, cookie);
    if (!variants) return null;

    return variants.map(v => ({
      url: v.proxyUrl,
      quality: v.quality,
      originalUrl: "",
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
    const res = await fetchWithTimeout(url, {
      headers: headers("https://multiembed.mov/"),
      redirect: "follow",
    });
    if (!res || !res.ok) return null;

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

async function tryVidlink(imdbId, type, season, episode) {
  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;

    const encRes = await fetchWithTimeout(`${ENC_VIDLINK_URL}?text=${encodeURIComponent(String(tmdb.id))}`, {
      headers: { "User-Agent": UA },
    });
    if (!encRes || !encRes.ok) return null;
    const encData = await encRes.json();
    const encoded = encData?.result;
    if (!encoded) return null;

    const apiUrl = type === "series"
      ? `${VIDLINK_BASE}/api/b/tv/${encoded}/${season}/${episode}?multiLang=0`
      : `${VIDLINK_BASE}/api/b/movie/${encoded}?multiLang=0`;

    const res = await fetchWithTimeout(apiUrl, {
      headers: { "User-Agent": UA, Referer: VIDLINK_BASE },
    });
    if (!res || !res.ok) return null;

    const data = await res.json();
    const streamData = data?.stream;
    if (!streamData) return null;

    if (streamData.qualities) {
      const streams = [];
      for (const [quality, info] of Object.entries(streamData.qualities)) {
        if (!info?.url) continue;
        streams.push({
          url: info.url,
          quality: quality + "p",
          referer: VIDLINK_BASE + "/",
          headers: info.headers || undefined,
        });
      }
      if (streams.length) {
        const captions = Array.isArray(streamData.captions) ? streamData.captions : undefined;
        if (captions) streams[0].captions = captions;
        return streams;
      }
    }

    const playlist = streamData.playlist || streamData.stream || streamData.url || streamData.sourceId;
    if (!playlist) return null;

    const captions = Array.isArray(streamData.captions) ? streamData.captions : undefined;
    return [{
      url: playlist,
      quality: "Auto",
      referer: VIDLINK_BASE + "/",
      ...(captions ? { captions } : {}),
    }];
  } catch (err) {
    console.error(`[scraper] vidlink error:`, err.message);
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function scrapeStreams({ type, imdbId, season, episode }, batchTimeout = 4000) {
  const sourceFunctions = [
    { name: "VidAPI", fn: () => tryVidApiDirect(imdbId, type, season, episode) },
    { name: "StreamIMDb", fn: () => tryStreamImdbEmbed(imdbId, type, season, episode) },
    { name: "StreamIMDb.me", fn: () => tryStreamImdbMe(imdbId, type, season, episode) },
    { name: "MultiEmbed", fn: () => tryMultiEmbed(imdbId, type, season, episode) },
    { name: "Vidlink", fn: () => tryVidlink(imdbId, type, season, episode) },
    { name: "MovieWeb", fn: () => tryMovieWeb(imdbId, type, season, episode) },
    { name: "4KHDHub", fn: () => try4KHDHub(imdbId, type, season, episode) },
    { name: "VixSrc", fn: () => tryVixSrc(imdbId, type, season, episode) },
  ];

  const settled = new Array(sourceFunctions.length).fill(null);
  const promises = sourceFunctions.map((sf, i) =>
    (async () => {
      try {
        const v = await sf.fn();
        settled[i] = { status: "fulfilled", value: v };
      } catch (e) {
        settled[i] = { status: "rejected", reason: e };
      }
    })()
  );

  await Promise.race([Promise.all(promises), sleep(batchTimeout)]);

  const allStreams = [];
  const seenUrls = new Set();

  for (let i = 0; i < sourceFunctions.length; i++) {
    const sf = sourceFunctions[i];
    const result = settled[i];
    if (!result || result.status !== "fulfilled" || !result.value?.length) continue;
    for (const s of result.value) {
      const key = s.url || s.originalUrl;
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      allStreams.push({ ...s, source: sf.name });
    }
  }

  return allStreams;
}

async function probeVidlink(imdbId, type, season, episode) {
  const steps = {};
  const tmdb = await convertImdbToTmdb(imdbId);
  steps.tmdb = tmdb ? { ok: true, title: tmdb.title || tmdb.name, id: tmdb.id } : { ok: false, error: "tmdb lookup failed" };
  if (!tmdb) return { steps, decoded: null, playlist: null };
  const encRes = await fetchWithTimeout(`${ENC_VIDLINK_URL}?text=${encodeURIComponent(String(tmdb.id))}`, { headers: { "User-Agent": UA } });
  steps.encDec = encRes ? { ok: true, status: encRes.status } : { ok: false, error: "enc-dec.app unreachable" };
  if (!encRes) return { steps, decoded: null, playlist: null };
  let encData;
  try { encData = await encRes.json(); } catch { encData = null; }
  steps.encDecData = encData ? { keys: Object.keys(encData) } : { ok: false, error: "invalid json" };
  const encoded = encData?.result;
  steps.encoded = encoded ? { ok: true, value: encoded.slice(0, 20) + "..." } : { ok: false, error: "no result field" };
  if (!encoded) return { steps, decoded: null, playlist: null };
  const apiUrl = type === "series"
    ? `${VIDLINK_BASE}/api/b/tv/${encoded}/${season}/${episode}?multiLang=0`
    : `${VIDLINK_BASE}/api/b/movie/${encoded}?multiLang=0`;
  const res = await fetchWithTimeout(apiUrl, { headers: { "User-Agent": UA, Referer: VIDLINK_BASE } });
  steps.vidlinkApi = res ? { ok: true, status: res.status } : { ok: false, error: "vidlink.pro unreachable" };
  if (!res) return { steps, decoded: encoded, playlist: null };
  let data;
  try { data = await res.json(); } catch { data = null; }
  steps.vidlinkData = data ? { keys: Object.keys(data), hasStream: !!data?.stream } : { ok: false, error: "invalid json" };
  steps.streamObject = data?.stream;
  if (data?.stream) {
    const s = data.stream;
    steps.streamFields = Object.keys(s);
    steps.streamSample = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      steps.streamSample[k] = typeof v === "string" ? v.slice(0, 120) : typeof v === "object" ? `[${v.constructor.name}]` : v;
    }
  }
  const playlist = data?.stream?.playlist || data?.stream?.stream || data?.stream?.url || data?.stream?.sourceId;
  steps.playlist = playlist ? { ok: true, foundIn: playlist === data?.stream?.playlist ? "playlist" : playlist === data?.stream?.stream ? "stream" : playlist === data?.stream?.url ? "url" : "sourceId", preview: (playlist || "").slice(0, 80) } : { ok: false, error: "no playable field found" };
  return { steps, decoded: encoded, playlist };
}

async function probePage(url, label) {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res) return { status: "unreachable", statusCode: null, finalUrl: url, htmlPreview: null, sizeBytes: null };
  const body = await res.text();
  return {
    status: "ok",
    statusCode: res.status,
    finalUrl: res.url,
    sizeBytes: body.length,
    hasIframe: body.includes("<iframe"),
    hasM3u8: body.includes(".m3u8"),
    hasSources: body.includes('"sources"'),
    htmlPreview: body.slice(0, 600),
  };
}

async function probeVixsrc(imdbId, type, season, episode) {
  const steps = {};
  const tmdb = await convertImdbToTmdb(imdbId);
  steps.tmdb = tmdb ? { ok: true, title: tmdb.title || tmdb.name, id: tmdb.id } : { ok: false, error: "tmdb lookup failed" };
  if (!tmdb) return { steps, api: null, playerUrl: null };

  const apiUrl = type === "series"
    ? `https://vixsrc.to/api/tv/${tmdb.id}/${season}/${episode}`
    : `https://vixsrc.to/api/movie/${tmdb.id}`;
  const apiRes = await fetchWithTimeout(apiUrl, { headers: { "User-Agent": UA, Referer: "https://vixsrc.to/" } });
  steps.api = apiRes ? { ok: true, status: apiRes.status, url: apiUrl } : { ok: false, error: "unreachable" };
  if (!apiRes) return { steps, data: null, playerUrl: null };
  let apiData;
  try { apiData = await apiRes.json(); } catch { apiData = null; }
  steps.apiData = apiData ? { keys: Object.keys(apiData), src: apiData.src } : { ok: false, error: "invalid json" };
  if (!apiData?.src) return { steps, data: apiData, playerUrl: null };
  const playerUrl = `https://vixsrc.to${apiData.src}`;
  steps.playerUrl = playerUrl;
  const playerRes = await fetchWithTimeout(playerUrl, { headers: { "User-Agent": UA, Referer: "https://vixsrc.to/" } });
  steps.playerPage = playerRes ? { ok: true, status: playerRes.status } : { ok: false, error: "unreachable" };
  if (!playerRes) return { steps, data: apiData, playerUrl };
  const html = await playerRes.text();
  const token = html.match(/['"]token['"]\s*:\s*['"](\w+)['"]/);
  const expires = html.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
  const urlMatch = html.match(/masterPlaylist\s*=\s*\{[^}]*url:\s*['"]([^'"]+)['"]/);
  steps.extracted = {
    token: token ? token[1].slice(0, 20) + "..." : null,
    expires: expires ? expires[1] : null,
    url: urlMatch ? urlMatch[1].slice(0, 60) + "..." : null,
    canPlayFHD: html.includes("canPlayFHD = true"),
  };
  return { steps, data: apiData, playerUrl };
}

export async function debugSources({ type, imdbId, season, episode }) {
  const sourceFunctions = [
    { name: "VidAPI", fn: () => tryVidApiDirect(imdbId, type, season, episode) },
    { name: "StreamIMDb", fn: () => tryStreamImdbEmbed(imdbId, type, season, episode) },
    { name: "StreamIMDb.me", fn: () => tryStreamImdbMe(imdbId, type, season, episode) },
    { name: "MultiEmbed", fn: () => tryMultiEmbed(imdbId, type, season, episode) },
    { name: "Vidlink", fn: () => tryVidlink(imdbId, type, season, episode) },
    { name: "MovieWeb", fn: () => tryMovieWeb(imdbId, type, season, episode) },
    { name: "4KHDHub", fn: () => try4KHDHub(imdbId, type, season, episode) },
    { name: "VixSrc", fn: () => tryVixSrc(imdbId, type, season, episode) },
  ];

  const results = [];
  for (const sf of sourceFunctions) {
    const start = Date.now();
    try {
      const streams = await sf.fn();
      results.push({
        source: sf.name,
        status: streams && streams.length ? "success" : "empty",
        streamCount: streams ? streams.length : 0,
        duration: Date.now() - start,
        error: null,
        sampleUrls: (streams || []).slice(0, 2).map(s => s.url?.slice(0, 150)),
      });
    } catch (err) {
      results.push({
        source: sf.name,
        status: "error",
        streamCount: 0,
        duration: Date.now() - start,
        error: err.message || String(err),
        stack: (err.stack || "").split("\n").slice(0, 3).join(" | "),
        sampleUrls: [],
      });
    }
  }

  const streamimdbPath = type === "series"
    ? `/embed/${imdbId}/${season}/${episode}/`
    : `/embed/movie/${imdbId}`;

  const multiembedUrl = type === "series"
    ? `https://multiembed.mov/directstream.php?video_id=${imdbId}&s=${season}&e=${episode}`
    : `https://multiembed.mov/directstream.php?video_id=${imdbId}`;

  const [vidlinkProbe, streamimdbProbe, multiembedProbe, vixsrcProbe] = await Promise.all([
    probeVidlink(imdbId, type, season, episode),
    probePage(`${SCRAPE_URL}${streamimdbPath}`, "streamimdb.ru"),
    probePage(multiembedUrl, "multiembed.mov"),
    probeVixsrc(imdbId, type, season, episode),
  ]);
  results[4].vidlinkProbe = vidlinkProbe;
  results[1].pageProbe = streamimdbProbe;
  results[3].pageProbe = multiembedProbe;
  results[7].vixsrcProbe = vixsrcProbe;

  if (streamimdbProbe?.hasIframe && streamimdbProbe.htmlPreview) {
    const iframeSrcMatch = streamimdbProbe.htmlPreview.match(/<iframe[^>]+src="([^"]+)"/);
    if (iframeSrcMatch) {
      let iframeUrl = iframeSrcMatch[1];
      if (iframeUrl.startsWith("//")) iframeUrl = "https:" + iframeUrl;
      if (iframeUrl.startsWith("/")) iframeUrl = "https://streamimdb.ru" + iframeUrl;
      results[1].iframeProbe = await probePage(iframeUrl, "streamimdb.ru iframe");
    }
  }

  return results;
}
