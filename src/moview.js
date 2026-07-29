import { makeProviders, makeStandardFetcher, targets } from "@movie-web/providers";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const TIMEOUT = 8000;

const providers = makeProviders({
  fetcher: makeStandardFetcher(async (url, init) => {
    const res = await fetch(url, {
      ...init,
      headers: { ...init?.headers, "User-Agent": UA },
    });
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text: () => res.text(),
      json: () => res.json(),
    };
  }),
  target: targets.NATIVE,
});

function convertImdbToTmdb(imdbId) {
  const apiKey = globalThis.__tmdbApiKey;
  if (!apiKey) return null;
  return fetch(
    `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`,
    { headers: { "User-Agent": UA } }
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.movie_results?.[0] || d?.tv_results?.[0] || null)
    .catch(() => null);
}

export async function tryMovieWeb(imdbId, type, season, episode) {
  try {
    const tmdb = await convertImdbToTmdb(imdbId);
    if (!tmdb) return null;

    const media = {
      type: type === "series" ? "show" : "movie",
      tmdbId: String(tmdb.id),
      title: tmdb.title || tmdb.name || "",
      releaseYear: tmdb.release_date
        ? parseInt(tmdb.release_date.split("-")[0], 10)
        : tmdb.first_air_date
          ? parseInt(tmdb.first_air_date.split("-")[0], 10)
          : undefined,
    };

    if (type === "series" && season != null && episode != null) {
      media.seasonNumber = Number(season);
      media.episodeNumber = Number(episode);
    }

    const output = await Promise.race([
      providers.runAll({
        media,
        events: {
          update(evt) {
            if (evt.status === "success")
              console.log(`[moview] ${evt.id}`);
            else if (evt.status === "failure")
              console.log(`[moview] ${evt.id}: ${evt.reason || ""}`);
          },
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), TIMEOUT)
      ),
    ]);

    if (!output?.sources?.length) return null;

    const streams = [];
    for (const source of output.sources) {
      if (source.qualities) {
        const keys = Object.keys(source.qualities).filter(
          (k) => k !== "unknown"
        );
        if (keys.length) {
          for (const q of keys) {
            const entry = source.qualities[q];
            if (!entry?.url) continue;
            streams.push({
              url: entry.url,
              quality: q,
              referer: source.headers?.Referer || "",
              headers: source.headers || undefined,
              captions: source.captions?.length ? source.captions : undefined,
            });
          }
          continue;
        }
      }

      const url = source.url || source.playlist;
      if (!url) continue;
      streams.push({
        url,
        quality: source.quality || "Auto",
        referer: source.headers?.Referer || "",
        headers: source.headers || undefined,
        captions: source.captions?.length ? source.captions : undefined,
      });
    }

    return streams.length ? streams : null;
  } catch (err) {
    console.error(`[scraper] moview error:`, err.message);
    return null;
  }
}
