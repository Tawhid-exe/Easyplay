# Easyplay — Stremio Multi-Source Scraper Addon

A self-hosted Stremio addon that aggregates streams from 8+ sources. Runs as a **hybrid architecture**: a Cloudflare Pages edge worker acts as the always-on entry point, and an Android phone running Termux can serve as an additional engine with sources that require residential/mobile IPs.

## Architecture

```
Stremio Client
      │
      ▼
Cloudflare Pages (easyplay-9id.pages.dev)
      │
      ├── Phone online?  ──►  Relay to phone tunnel  ──►  ALL sources
      │
      └── Phone offline? ──►  Cloud-only fallback    ──►  Vidlink + Castle + MovieBox
```

- **Cloudflare Pages Functions** handle routing, manifest, and relay logic
- **Phone (Termux)** runs `server.mjs` with all 8 sources locally, exposed via cloudflared tunnel
- **KV store** (`EASYPLAY_KV`) holds the phone's tunnel URL; the phone re-registers periodically
- When the phone is offline, the addon falls back to sources that work from datacenter IPs

## Sources

| Source | Type | Requires Phone | Notes |
|--------|------|:-:|-------|
| **Vidlink** | HLS embed | No | Always available from CF edge |
| **Castle** | AES-encrypted API | No | Works from datacenter IPs |
| **MovieBox** | HMAC-MD5 signed mobile API | No | Falls back to H5 API |
| **VixSrc** | TMDB → player scrape | Yes | |
| **4KHDHub** | Link shortener + HLS | Yes | Lazy-loaded by default |
| **HDHub4u** | WordPress scraper | Yes | Domain rotation via community JSON |
| **MoviesDrive** | WordPress scraper | Yes | Domain rotation via community JSON |
| **VegaMovies** | WordPress scraper | Yes | Bollywood/Hollywood + series |

## Quick Install (Phone)

Paste this one-liner in Termux:

```bash
curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/public/easyplay-android.sh | bash
```

This installs Node.js, git, cloudflared, clones the repo, and sets up a home-screen widget. After setup:

- **Tap the widget** to start/stop the server + tunnel
- Install the addon once in Stremio: `https://easyplay-9id.pages.dev/manifest.json`
- That URL never changes — no re-install needed

### Manual Setup (PC)

```bash
git clone https://github.com/Tawhid-exe/Easyplay.git
cd Easyplay
npm install
npm start
```

The local server runs on `http://localhost:7000`.

## Deploy to Cloudflare Pages

1. Connect the GitHub repo to Cloudflare Pages (Workers & Pages > Create > Pages)
2. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
3. Bind an `EASYPLAY_KV` KV namespace in Settings > Functions > KV bindings
4. Set `TMDB_API_KEY` in Settings > Environment Variables (optional, has a default)

Deploy manually:
```bash
npm run deploy
```

## Configuration

Environment variables (set in Cloudflare dashboard or `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `TMDB_API_KEY` | *(built-in)* | TMDB API key for title lookups |
| `ADDON_NAME` | `Easyplay` | Display name in Stremio |
| `HDHUB4U_ENABLED` | `true` | Enable/disable HDHub4u source |
| `MOVIESDRIVE_ENABLED` | `true` | Enable/disable MoviesDrive source |
| `VEGAMOVIES_ENABLED` | `true` | Enable/disable VegaMovies source |
| `HIANIME_ENABLED` | `true` | Enable/disable HiAnime source |
| `CASTLE_ENABLED` | `true` | Enable/disable Castle source |
| `MOVIEBOX_ENABLED` | `true` | Enable/disable MovieBox source |
| `KHDHUB_LAZY_LOAD` | `true` | Lazy-load 4KHDHub (resolve on play) |
| `HIANIME_API_BASE` | *(built-in)* | HiAnime API endpoint |

## Project Structure

```
├── functions/              # Cloudflare Pages Functions (edge routes)
│   ├── stream/[type]/[id].js   # Main stream handler (relay or fallback)
│   ├── api/register.js         # Phone registration endpoint
│   ├── api/status.js           # Status/health check
│   └── manifest.json.js        # Stremio manifest
├── src/
│   ├── addon.js            # Stremio addon builder + stream handler
│   ├── scraper.js          # Source orchestrator (parallel scraping, timeout)
│   ├── cfStream.js         # Cloudflare stream handler (relay + fallback)
│   ├── config.js           # All configuration constants
│   ├── moviebox.js         # MovieBox — signed mobile API + H5 fallback
│   ├── castle.js           # Castle — AES-CBC encrypted API
│   ├── vidlink.js          # Vidlink — HLS embed with token encryption
│   ├── vixsrc.js           # VixSrc — TMDB-based player
│   ├── 4khdhub.js          # 4KHDHub — link shortener + HLS
│   ├── hdhub4u.js          # HDHub4u — WordPress scraper
│   ├── moviesdrive.js      # MoviesDrive — WordPress scraper
│   ├── vegamovies.js       # VegaMovies — WordPress scraper
│   ├── hianime.js          # HiAnime — third-party API
│   ├── utils.js            # Shared fetch helpers, TMDB lookup
│   ├── cors.js             # CORS headers
│   └── cookies.js          # Cookie handling
├── public/                 # Static files (deployed to Pages)
│   ├── index.html          # Landing page with Install button
│   ├── easyplay-android.sh # Self-bootstrapping Termux installer
│   ├── setup-termux.sh     # Alternative Termux setup
│   └── easyplay-pc.bat     # Windows quick-start
├── server.mjs              # Local Express server (phone/PC)
├── start-server.sh         # Termux widget script (toggle start/stop)
├── wrangler.toml           # Cloudflare Pages + KV config
└── package.json
```

## How It Works

1. Stremio requests streams for an IMDb ID (e.g., `tt1234567`)
2. The addon resolves the IMDb ID to a TMDB title via the TMDB API
3. All enabled sources are queried in parallel with a 12-second batch timeout
4. Results are deduplicated by URL, tagged with source name, and returned
5. Quality filtering is configurable via Stremio's addon config UI

## Troubleshooting

- **Only Vidlink + Castle showing**: The phone is offline or the relay failed. Tap the widget to restart.
- **No streams at all**: Check `https://easyplay-9id.pages.dev/api/status` for relay status.
- **Phone logs**: `cat ~/.easyplay.log` (server) and `cat ~/.easyplay-relay.log` (tunnel/relay)
- **Restart phone server**: Tap the Termux widget twice (once to stop, once to start)
