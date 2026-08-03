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
#!/usr/bin/env bash
termux-wake-lock
cd "$HOME/Easyplay" || exit 1
export ADDON_NAME="Easyplay"
REGISTER_URL="https://easyplay-9id.pages.dev/api/register"
command -v cloudflared >/dev/null 2>&1 || pkg install -y cloudflared

nohup node server.mjs > "$HOME/.easyplay.log" 2>&1 &
NODE_PID=$!
nohup cloudflared tunnel --url http://localhost:7000 > "$HOME/.easyplay-tunnel.log" 2>&1 &
TUNNEL_PID=$!

echo ""
echo "=============================================================="
echo "  Easyplay engine starting..."
echo "  INSTALL ONCE (any device): https://easyplay-9id.pages.dev/manifest.json"
echo "=============================================================="

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/.easyplay-tunnel.log" 2>/dev/null | head -n1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -n "$URL" ]; then
  curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=$URL" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1 || true
  echo ""
  echo "  Phone engine online. No addon URL needed -"
  echo "  the pages.dev addon now relays through:  $URL"
  echo ""
else
  echo ""
  echo "  Tunnel URL not detected yet - check:  cat ~/.easyplay-tunnel.log"
  echo ""
fi

echo "  Press Ctrl+C (or close this window) to STOP server + tunnel."
echo "=============================================================="
echo ""

trap 'kill $NODE_PID $TUNNEL_PID 2>/dev/null; curl -s -G -X POST "$REGISTER_URL" --data-urlencode "url=" --data-urlencode "token=${REGISTER_TOKEN:-}" >/dev/null 2>&1; exit 0' INT TERM HUP EXIT
tail -f "$HOME/.easyplay-tunnel.log"
EOF
chmod +x "$SHORTCUTS/start-server.sh"

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
echo " Tap the icon to serve. Stop with Ctrl+C or volume-down + C."
echo " Server also auto-stops after 90 min without a stream lookup"
echo " (override: IDLE_TIMEOUT_MIN=30 node server.mjs)."
echo "=============================================================="
