export const SCRAPE_URL = "https://streamimdb.ru";
export const SCRAPE_ALT_URL = "https://streamimdb.me";
export const STREAMDATA_API_URL = "https://streamdata.vaplayer.ru/api.php";

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
  streamimdb_ru: "StreamIMDb",
  streamimdb_me: "StreamIMDb.me",
  multiembed: "MultiEmbed",
  vidlink: "Vidlink",
};
