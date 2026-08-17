#!/data/data/com.termux/files/usr/bin/bash
# Easyplay toggle widget - tap to START, tap again to STOP.
#
# Self-updates from the repo on every tap so the phone never runs a stale
# copy. Starts the scraper engine, then publishes a public HTTPS tunnel URL
# to the relay:
#   1) cloudflared quick tunnel (with the Android edge/protocol workarounds)
#   2) falls back to Tailscale Funnel (rootless patched CLI) if cloudflared
#      produces no URL
# Registration is verified via GET /api/register and everything is logged to
# ~/.easyplay-relay.log so failures are visible instead of silent.

WIDGET_URL="https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/start-server.sh"
REGISTER_URL="https://easyplay-9id.pages.dev/api/register"
APP_DIR="$HOME/Easyplay"
PORT="7000"
TS_HOSTNAME="easyplay-phone"
PID_FILE="$HOME/.easyplay.pid"
TUNNEL_PID_FILE="$HOME/.easyplay-tunnel.pid"
LOG_FILE="$HOME/.easyplay.log"
LOG_TUNNEL="$HOME/.easyplay-tunnel.log"
LOG_TAILSCALE="$HOME/.easyplay-tailscale.log"
LOG_RELAY="$HOME/.easyplay-relay.log"
WIDGET_A="$HOME/.shortcuts/start-server.sh"
WIDGET_B="$HOME/.shortcuts/Easyplay"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_RELAY" 2>/dev/null || true; }

# ---- Self-update on every tap --------------------------------------------
maybe_self_update() {
  command -v curl >/dev/null 2>&1 || return 0
  local tmp="$HOME/.easyplay.widget.new"
  curl -fsSL "$WIDGET_URL" -o "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  [ -s "$tmp" ] || { rm -f "$tmp"; return 0; }
  if [ -f "$0" ] && cmp -s "$0" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 0
  fi
  chmod +x "$tmp"
  mkdir -p "$HOME/.shortcuts"
  cp "$tmp" "$WIDGET_A" 2>/dev/null || true
  cp "$tmp" "$WIDGET_B" 2>/dev/null || true
  cp "$tmp" "$0" 2>/dev/null || true
  rm -f "$tmp"
  echo "[Easyplay] widget updated - restarting..."
  log "widget self-updated"
  exec bash "$WIDGET_A"
}
maybe_self_update

# ---- Stop helpers ---------------------------------------------------------
stop_all() {
  local p
  p=$(cat "$PID_FILE" 2>/dev/null);      [ -n "$p" ] && kill "$p" 2>/dev/null
  p=$(cat "$TUNNEL_PID_FILE" 2>/dev/null); [ -n "$p" ] && kill "$p" 2>/dev/null
  pkill -f "node server.mjs" 2>/dev/null
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null
  command -v tailscale >/dev/null 2>&1 && tailscale funnel off >/dev/null 2>&1
  sleep 1
  rm -f "$PID_FILE" "$TUNNEL_PID_FILE"
  curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1 || true
  log "stopped (relay cleared)"
}

# ---- Toggle: stop if already running -------------------------------------
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  stop_all
  echo "[Easyplay] server + tunnel stopped (relay will fall back to cloud)."
  exit 0
fi
rm -f "$PID_FILE" "$TUNNEL_PID_FILE"

# ---- Start ---------------------------------------------------------------
[ -d "$APP_DIR" ] || { echo "[Easyplay] repo missing - re-run:  curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/setup-termux.sh | bash"; exit 1; }
cd "$APP_DIR" || exit 1
export ADDON_NAME="Easyplay"
termux-wake-lock 2>/dev/null
stop_all

nohup node server.mjs > "$LOG_FILE" 2>&1 &
NODE_PID=$!
echo $NODE_PID > "$PID_FILE"
sleep 2
if ! kill -0 "$NODE_PID" 2>/dev/null; then
  echo "[Easyplay] engine failed to start - check:  cat ~/.easyplay.log"
  rm -f "$PID_FILE"
  exit 1
fi

URL=""
TUNNEL_KIND=""

# ---- Attempt 1: cloudflared quick tunnel ---------------------------------
command -v cloudflared >/dev/null 2>&1 || pkg install -y cloudflared >/dev/null 2>&1
if command -v cloudflared >/dev/null 2>&1; then
  nohup cloudflared tunnel --url http://localhost:$PORT --edge-ip-version 4 --protocol http2 > "$LOG_TUNNEL" 2>&1 &
  echo $! > "$TUNNEL_PID_FILE"
  for i in $(seq 1 25); do
    [ -f "$PID_FILE" ] || exit 0
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_TUNNEL" 2>/dev/null | grep -v 'https://api\.trycloudflare\.com' | head -n1)
    [ -n "$URL" ] && break
    sleep 1
  done
  if [ -n "$URL" ]; then
    TUNNEL_KIND="cloudflared"
  else
    echo "[Easyplay] cloudflared produced no URL - trying Tailscale Funnel..."
    log "cloudflared gave no URL; tunnel log tail:"
    tail -n 6 "$LOG_TUNNEL" 2>/dev/null >> "$LOG_RELAY" || true
  fi
fi

# ---- Attempt 2: Tailscale Funnel fallback --------------------------------
if [ -z "$URL" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "[Easyplay] installing Tailscale CLI (rootless, one time)..."
    curl -fsSL https://raw.githubusercontent.com/bropines/tailscale-termux-cli/main/remote-install.sh | bash >> "$LOG_RELAY" 2>&1 || true
  fi
  if command -v tailscale >/dev/null 2>&1; then
    if command -v tailscaled-start >/dev/null 2>&1; then
      tailscaled-start >> "$LOG_RELAY" 2>&1
    else
      tailscaled --tun=userspace-networking --statedir="$PREFIX/var/lib/tailscale" --socket="$PREFIX/var/run/tailscale/tailscaled.sock" >> "$LOG_RELAY" 2>&1 &
    fi
    sleep 2
  fi
  if command -v tailscale >/dev/null 2>&1; then
    if ! tailscale status >/dev/null 2>&1; then
      nohup tailscale up --hostname="$TS_HOSTNAME" > "$LOG_TAILSCALE" 2>&1 &
      AUTH_URL=""
      for i in $(seq 1 15); do
        AUTH_URL=$(grep -oE 'https://login\.tailscale\.com/[a-zA-Z0-9/?=&._-]+' "$LOG_TAILSCALE" 2>/dev/null | head -n1)
        [ -n "$AUTH_URL" ] && break
        sleep 1
      done
      if [ -n "$AUTH_URL" ]; then
        if command -v termux-open-url >/dev/null 2>&1; then
          termux-open-url "$AUTH_URL" 2>/dev/null
          echo "[Easyplay] Tailscale login opened in your browser - approve it (one time)."
        else
          echo "[Easyplay] First-time Tailscale login - open this URL: $AUTH_URL"
        fi
      fi
      for i in $(seq 1 45); do
        [ -f "$PID_FILE" ] || exit 0
        tailscale status >/dev/null 2>&1 && break
        sleep 1
      done
    fi
    if tailscale status >/dev/null 2>&1; then
      tailscale funnel --bg "$PORT" >> "$LOG_RELAY" 2>&1
      TS_DNS=$(tailscale status --json 2>/dev/null | grep -oE '"DNSName"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)".*/\1/' | sed 's/\.$//')
      if [ -n "$TS_DNS" ]; then
        URL="https://$TS_DNS"
        TUNNEL_KIND="tailscale"
      else
        echo "[Easyplay] Tailscale connected but no DNS name yet - check:  cat ~/.easyplay-relay.log"
      fi
    else
      echo "[Easyplay] Tailscale not logged in yet - tap the widget again after approving."
    fi
  fi
fi

# ---- Publish + verify ----------------------------------------------------
if [ -n "$URL" ]; then
  curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=$URL" --data-urlencode "token=${REGISTER_TOKEN:-}" >> "$LOG_RELAY" 2>&1 || true
  GOT=$(curl -s "$REGISTER_URL" 2>/dev/null || true)
  if printf '%s' "$GOT" | grep -Fq "\"phoneUrl\":\"$URL\""; then
    echo ""
    echo "  Phone engine ONLINE:        $URL"
    echo "  Relay verified via /api/register."
  else
    echo ""
    echo "  WARNING: registration not confirmed."
    echo "  Server said: $GOT"
  fi
  log "publish url=$URL kind=$TUNNEL_KIND verified=yes"
else
  echo ""
  echo "  No tunnel URL could be created (cloudflared AND Tailscale failed)."
  echo "  Check:  cat ~/.easyplay-relay.log"
  echo "  Check:  cat ~/.easyplay-tunnel.log"
  log "no tunnel URL available (cloudflared + tailscale both failed)"
fi
echo ""
echo "  INSTALL ONCE (any device):  https://easyplay-9id.pages.dev/manifest.json"
echo "  Tap the widget again to STOP."
echo "  Status log:  ~/.easyplay-relay.log"
echo ""

# ---- Keep session alive + heartbeat re-register every ~6h ----------------
HB=0
while [ -f "$PID_FILE" ] && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 300
  HB=$((HB+1))
  if [ $((HB % 72)) -eq 0 ] && [ -n "$URL" ]; then
    curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=$URL" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1 || true
    log "heartbeat re-registered url=$URL"
    echo "[Easyplay] relay heartbeat ok ($(date '+%H:%M'))"
  fi
done
echo "[Easyplay] server ended - tap the widget to start again."
stop_all
exit 0
