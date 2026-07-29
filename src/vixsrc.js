import { fetchWithTimeout, convertImdbToTmdb } from "./utils.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const VIXSRC_BASE = "https://vixsrc.to";

function extractVixSrcParams(html) {
  const token = html.match(/['"]token['"]\s*:\s*['"](\w+)['"]/);
  const expires = html.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
  const urlMatch = html.match(/masterPlaylist\s*=\s*\{[^}]*url:\s*['"]([^'"]+)['"]/);
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

    const apiRes = await fetchWithTimeout(apiUrl, {
      headers: { "User-Agent": UA, Referer: VIXSRC_BASE + "/" },
    });
    if (!apiRes || !apiRes.ok) return null;

    let apiData;
    try { apiData = await apiRes.json(); } catch { return null; }
    if (!apiData?.src) return null;

    const playerUrl = `${VIXSRC_BASE}${apiData.src}`;
    const playerRes = await fetchWithTimeout(playerUrl, {
      headers: { "User-Agent": UA, Referer: VIXSRC_BASE + "/" },
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
