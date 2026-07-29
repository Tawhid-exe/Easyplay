# Custom Scraper — Stremio Addon (Cloudflare Pages)

A self-hosted Stremio addon that scrapes a website you configure and returns
playable streams. Runs entirely on Cloudflare Pages Functions (edge runtime,
free tier) — no server to manage.

## 1. Set the website to scrape

Open `src/config.js` and paste the target site's base URL:

```js
export const SCRAPE_URL = "https://example.com";
export const SEARCH_PATH_PATTERN = "/search/{query}";
```

`{query}` gets replaced with the URL-encoded movie/show title Stremio is
asking about (looked up automatically via Cinemeta from the IMDb id).

## 2. Adjust the scraper for the site's actual HTML

Open `src/scraper.js`. Out of the box it does the simplest possible thing:
fetch the search results page and pull out every `magnet:` link it finds.
That works immediately if the target site lists magnet links right on the
search/results page.

If instead the site:
- links each result to a separate details page → use **Option A** in the
  file (commented out) — fetch each details page, then extract the magnet
  from there.
- gives direct video/stream URLs instead of torrents → use **Option B**
  (commented out) — return `{ url: ... }` streams instead of `infoHash`.

To find the right pattern: open the site's search results page in a
browser, view source (Ctrl+U), and look for how magnet links or details
links appear in the raw HTML, then adjust the regex in `scraper.js`
accordingly.

## 3. Test locally (optional, requires Node + npm)

```bash
npm install
npm run dev
```

This starts a local server (usually `http://localhost:8788`). Visit
`http://localhost:8788/manifest.json` to confirm it returns JSON.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Initial addon"
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

## 5. Deploy on Cloudflare Pages

1. Go to the Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Select the repo you just pushed.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. Click **Save and Deploy**.

Cloudflare auto-detects the `functions/` folder and deploys it alongside
the static `public/` folder — no extra config needed.

Your addon will be live at:
```
https://<your-project-name>.pages.dev
```

## 6. Install in Stremio

Open Stremio → click the search icon in the addons section → paste:
```
https://<your-project-name>.pages.dev/manifest.json
```
Click **Install**. Streams from your scraper will now show up whenever
you open a movie/show that matches something on the target site.

Or visit `https://<your-project-name>.pages.dev` in a browser — it shows
an **Install in Stremio** button that does this for you via a `stremio://` link.

## Notes

- Every response must return HTTP 200 with valid JSON, or Stremio will
  silently stop calling this addon — the code already handles errors by
  returning an empty stream list rather than throwing.
- Cloudflare's edge IPs are shared/rotating, which can help vs. the
  datacenter-IP blocking some sites apply to fixed VPS IPs — but a site
  that's aggressively protected (Cloudflare-behind-Cloudflare, heavy JS
  challenges) may still block it. If that happens you'd need a proxy or
  a FlareSolverr-style solver in front of the fetch call.
- This only supplies the `stream` resource (playable links for content
  Stremio already knows about via Cinemeta). It doesn't add its own
  browsable catalog — that would need the `catalog` resource added to
  the manifest and a matching route.
