export const STREAMDATA_API_URL = "https://streamdata.vaplayer.ru/api.php";

// VidAPI backend is defunct (streamdata.vaplayer.ru 404, nextgencloudfabric.com 404).
// Set to true if a successor backend surfaces; otherwise skip to avoid burning the batch budget.
export const VIDAPI_ENABLED = false;

export const TMDB_API_KEY = (typeof process !== "undefined" && process.env && process.env.TMDB_API_KEY) || "1b7f3baba19e266ea22cc48ac0b3b40c";

export const FETCH_TIMEOUT = 10000;
export const RETRY_ATTEMPTS = 3;
export const BATCH_TIMEOUT = 12000;

export const VIDLINK_BASE = "https://vidlink.pro";
export const ENC_VIDLINK_URL = "https://enc-dec.app/api/enc-vidlink";
export const TMDB_API_URL = "https://api.themoviedb.org/3";
export const TMDB_FIND_URL = (imdbId, key) =>
  `${TMDB_API_URL}/find/${imdbId}?external_source=imdb_id&api_key=${key}`;

export const ADDON_ID = "org.custom.scraper";
export const ADDON_NAME = "Easyplay";
export const ADDON_DESCRIPTION = "Fetches streams from multiple sources with HLS proxy support";
export const ADDON_VERSION = "1.0.0";

export const SOURCE_NAMES = {
  vidapi: "VidAPI",
  vidlink: "Vidlink",
  vixsrc: "VixSrc",
  khdhub: "4KHDHub",
  };
