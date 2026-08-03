#!/usr/bin/env bash
# Easyplay - one-tap Android addon server (Termux + Termux:Widget)
# Run once:  curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/setup-termux.sh | bash
set -e

echo "==> Installing packages (node, termux-api, git, cloudflared)..."
pkg update -y
pkg install -y nodejs-lts termux-api git cloudflared

if [ ! -d "$HOME/Easyplay" ]; then
  echo "==> Cloning the addon repo..."
  git clone https://github.com/Tawhid-exe/Easyplay.git "$HOME/Easyplay"
else
  echo "==> Easyplay already present, pulling latest..."
  git -C "$HOME/Easyplay" pull --ff-only
fi

echo "==> Installing npm dependencies (pure JS, no native builds)..."
cd "$HOME/Easyplay"
npm install --omit=dev

SHORTCUTS="$HOME/.shortcuts"
mkdir -p "$SHORTCUTS"

cat > "$SHORTCUTS/start-server.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Easyplay toggle widget - tap to START, tap again to STOP.
REGISTER_URL="https://easyplay-9id.pages.dev/api/register"
APP_DIR="$HOME/Easyplay"
PID_FILE="$HOME/.easyplay.pid"
TUNNEL_PID_FILE="$HOME/.easyplay-tunnel.pid"
LOG_FILE="$HOME/.easyplay.log"
LOG_TUNNEL="$HOME/.easyplay-tunnel.log"

# ---- Stop if already running --------------------------------
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 1
    rm -f "$PID_FILE"
    TUNNEL_PID=$(cat "$TUNNEL_PID_FILE" 2>/dev/null)
    if [ -n "$TUNNEL_PID" ]; then
      kill "$TUNNEL_PID" 2>/dev/null
      rm -f "$TUNNEL_PID_FILE"
    fi
    curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1 || true
    echo "[Easyplay] server + tunnel stopped (relay will fall back to cloud)."
    exit 0
  fi
  rm -f "$PID_FILE" "$TUNNEL_PID_FILE"
fi

# ---- Start ---------------------------------------------------
cd "$APP_DIR" || exit 1
export ADDON_NAME="Easyplay"
termux-wake-lock 2>/dev/null
command -v cloudflared >/dev/null 2>&1 || pkg install -y cloudflared
nohup node server.mjs > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
nohup cloudflared tunnel --url http://localhost:7000 > "$LOG_TUNNEL" 2>&1 &
echo $! > "$TUNNEL_PID_FILE"
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_TUNNEL" 2>/dev/null | head -n1)
  [ -n "$URL" ] && break
  sleep 1
done
curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=$URL" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1 || true
echo "[Easyplay] server + tunnel started."
echo "  INSTALL ONCE (any device):  https://easyplay-9id.pages.dev/manifest.json"
if [ -n "$URL" ]; then
  echo "  Phone engine online at:     $URL"
else
  echo "  Tunnel URL not ready - check:  cat ~/.easyplay-tunnel.log"
fi
echo "  Tap the widget again to STOP."
EOF
chmod +x "$SHORTCUTS/start-server.sh"
cp -f "$SHORTCUTS/start-server.sh" "$SHORTCUTS/Easyplay"
chmod +x "$SHORTCUTS/Easyplay"

echo ""
echo "=============================================================="
echo "  Setup complete."
echo ""
echo " 1. Disable battery optimization for Termux:"
echo "      Settings > Apps > Termux > Battery > Unrestricted"
echo " 2. Home screen: long-press empty area > Widgets >"
echo "      Termux:Widget > tap 'start-server.sh'"
echo "    The widget starts the scraper engine + a free Cloudflare"
echo "    tunnel and publishes the current tunnel URL to the relay."
echo ""
echo " 3. Install the addon ONCE (any device, including this phone):"
echo "      https://easyplay-9id.pages.dev/manifest.json"
echo "    That URL never changes - no re-install needed, ever."
echo ""
echo " 4. Streams come from this phone while the widget is on."
echo "    If the phone is off, the relay falls back to cloud-only"
echo "    (Vidlink) sources automatically."
echo ""
echo " Tap the icon to START, tap it again to STOP."
echo " Server also auto-stops after 90 min without a stream lookup"
echo " (override: IDLE_TIMEOUT_MIN=30 node server.mjs)."
echo "=============================================================="
