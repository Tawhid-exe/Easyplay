import { fetchWithRetry, chromeHeaders, convertImdbToTmdb } from "./utils.js";

const VIXSRC_BASE = "https://vixsrc.to";

function extractVixSrcParams(html) {
  const token = html.match(/['"]token['"]\s*:\s*['"](\w+)['"]/);
  const expires = html.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
  const urlMatch = html.match(/masterPlaylist\s*=\s*\{[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/);
  if (!token || !expires || !urlMatch) return null;
  return { token: token[1], expires: expires[1], url: urlMatch[1] };
}

export async function tryVixSrc(imdbId, type, season, episode) {
  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;

    const apiUrl = type === "series"
      ? `${VIXSRC_BASE}/api/tv/${tmdb.id}/${season}/${episode}`
      : `${VIXSRC_BASE}/api/movie/${tmdb.id}`;

    const apiRes = await fetchWithRetry(apiUrl, {
      headers: chromeHeaders({ referer: VIXSRC_BASE + "/", origin: VIXSRC_BASE, mode: "api", site: "same-origin" }),
    });
    if (!apiRes || !apiRes.ok) return null;

    let apiData;
    try { apiData = await apiRes.json(); } catch { return null; }
    if (!apiData?.src) return null;

    const playerUrl = `${VIXSRC_BASE}${apiData.src}`;
    const playerRes = await fetchWithRetry(playerUrl, {
      headers: chromeHeaders({ referer: VIXSRC_BASE + "/", origin: VIXSRC_BASE, mode: "html", site: "same-origin" }),
    });
    if (!playerRes || !playerRes.ok) return null;

    const html = await playerRes.text();
    const params = extractVixSrcParams(html);
    if (!params) return null;

    const fhd = html.includes("canPlayFHD = true");
    const finalUrl = `${params.url}?token=${params.token}&expires=${params.expires}${fhd ? "&h=1" : ""}`;

    return [{
      url: finalUrl,
      quality: "Auto",
      referer: VIXSRC_BASE + "/",
    }];
  } catch (err) {
    console.error(`[vixsrc] error:`, err.message);
    return null;
  }
}
