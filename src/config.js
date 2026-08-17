export const STREAMDATA_API_URL = "https://streamdata.vaplayer.ru/api.php";

// VidAPI backend is defunct (streamdata.vaplayer.ru 404, nextgencloudfabric.com 404).
// Set to true if a successor backend surfaces; otherwise skip to avoid burning the batch budget.
export const VIDAPI_ENABLED = false;

export const TMDB_API_KEY = (typeof process !== "undefined" && process.env && process.env.TMDB_API_KEY) || "1b7f3baba19e266ea22cc48ac0b3b40c";

export const FETCH_TIMEOUT = 10000;
export const RETRY_ATTEMPTS = 3;
export const BATCH_TIMEOUT = 12000;

// Lazy-load 4KHDHub: return preview streams immediately and resolve the real
// direct link only when the user presses play (via /resolve on the local server).
// Set KHDHUB_LAZY_LOAD=0 to force full extraction at lookup time.
export const KHDHUB_LAZY_LOAD = (typeof process !== "undefined" && process.env && process.env.KHDHUB_LAZY_LOAD !== "0");

export const VIDLINK_BASE = "https://vidlink.pro";
export const ENC_VIDLINK_URL = "https://enc-dec.app/api/enc-vidlink";
export const TMDB_API_URL = "https://api.themoviedb.org/3";
export const TMDB_FIND_URL = (imdbId, key) =>
  `${TMDB_API_URL}/find/${imdbId}?external_source=imdb_id&api_key=${key}`;

const env = (typeof process !== "undefined" && process.env) || {};

function boolEnv(name, def) {
  const v = env[name];
  if (v === undefined || v === null || v === "") return def;
  return v !== "0" && v !== "false" && v !== "no";
}

// HDHub4u: WordPress index site; domains rotate, live list fetched from community JSON.
export const HDHUB4U_ENABLED = boolEnv("HDHUB4U_ENABLED", true);
export const HDHUB4U_BASE_URLS = ["https://hdhub4u.frl"];
export const HDHUB4U_DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
export const HDHUB4U_DOMAINS_KEY = "hdhub4u";

// MoviesDrive: WordPress download aggregator; domains rotate.
export const MOVIESDRIVE_ENABLED = boolEnv("MOVIESDRIVE_ENABLED", true);
export const MOVIESDRIVE_BASE_URLS = ["https://moviesdrive.net"];
export const MOVIESDRIVE_DOMAINS_URL = "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
export const MOVIESDRIVE_DOMAINS_KEY = "moviesdrive";

// HiAnime: third-party API wrapping hianime.to (megacloud decryptor lives server-side).
// Public instances come and go; HIANIME_API_BASE is the primary and HIANIME_API_BASES
// is the ordered fallback list (can be set via comma-separated HIANIME_API_BASES env).
export const HIANIME_ENABLED = boolEnv("HIANIME_ENABLED", true);
export const HIANIME_API_BASE = env.HIANIME_API_BASE || "https://hianime-api-b6ix.onrender.com";
export const HIANIME_API_BASES = (env.HIANIME_API_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .concat([HIANIME_API_BASE, "https://hianime-api-iy4s.onrender.com"]);
export const HIANIME_REFERER = "https://hianime.to/";

// Castle: encrypted JSON API (api.hlowb.com) powering the Castle app. API-based,
// so it also works from Cloudflare datacenter IPs. Responses are AES-CBC encrypted.
export const CASTLE_ENABLED = boolEnv("CASTLE_ENABLED", true);
export const CASTLE_API_BASE = env.CASTLE_API_BASE || "https://api.hlowb.com";

// VegaMovies: WordPress index site (Bollywood/Hollywood + series). Domains rotate,
// live list fetched from the same community JSON MoviesDrive uses.
export const VEGAMOVIES_ENABLED = boolEnv("VEGAMOVIES_ENABLED", true);
export const VEGAMOVIES_BASE_URLS = ["https://new1.vegamovies.futbol"];
export const VEGAMOVIES_DOMAINS_URL = "https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json";
export const VEGAMOVIES_DOMAINS_KEY = "vegamovies";

// MovieBox: Android app API (HMAC-MD5 signed requests). Host pool for failover.
export const MOVIEBOX_ENABLED = boolEnv("MOVIEBOX_ENABLED", true);
export const MOVIEBOX_SECRET = env.MOVIEBOX_SECRET || "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
export const MOVIEBOX_HOSTS = env.MOVIEBOX_HOSTS || "api.inmoviebox.com,api6.aoneroom.com,api5.aoneroom.com,api4.aoneroom.com,api3.aoneroom.com";

export const ADDON_ID = "org.custom.scraper";
export const ADDON_NAME = (typeof process !== "undefined" && process.env && process.env.ADDON_NAME) || "Easyplay";
export const ADDON_DESCRIPTION = "Fetches streams from multiple sources with HLS proxy support";
export const ADDON_VERSION = "1.0.0";

export const SOURCE_NAMES = {
  vidapi: "VidAPI",
  vidlink: "Vidlink",
  vixsrc: "VixSrc",
  khdhub: "4KHDHub",
  hdhub4u: "HDHub4u",
  moviesdrive: "MoviesDrive",
  hianime: "HiAnime",
  castle: "Castle",
  vegamovies: "VegaMovies",
  moviebox: "MovieBox",
  };
