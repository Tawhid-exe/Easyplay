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
export ADDON_NAME="Easyplay (local)"
command -v cloudflared >/dev/null 2>&1 || pkg install -y cloudflared

nohup node server.mjs > "$HOME/.easyplay.log" 2>&1 &
NODE_PID=$!
nohup cloudflared tunnel --url http://localhost:7000 > "$HOME/.easyplay-tunnel.log" 2>&1 &
TUNNEL_PID=$!

echo ""
echo "=============================================================="
echo "  Easyplay + tunnel starting..."
echo "  THIS phone    : add  http://localhost:7000/manifest.json"
echo "=============================================================="

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$HOME/.easyplay-tunnel.log" 2>/dev/null | head -n1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -n "$URL" ]; then
  echo ""
  echo "  ALL devices (TV/PC/phones, anywhere):"
  echo "      add  $URL/manifest.json"
  echo ""
else
  echo ""
  echo "  Tunnel URL not detected yet - check:  cat ~/.easyplay-tunnel.log"
  echo ""
fi

echo "  Press Ctrl+C (or close this window) to STOP server + tunnel."
echo "=============================================================="
echo ""

trap 'kill $NODE_PID $TUNNEL_PID 2>/dev/null; exit 0' INT TERM HUP EXIT
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
echo "    The widget starts the server + a free Cloudflare tunnel"
echo "    and prints your URLs when ready."
echo ""
echo " 3. Stremio on THIS phone: Add-ons > Add external addon:"
echo "      http://localhost:7000/manifest.json"
echo ""
echo " 4. ALL other devices (TV/PC/phones, even outside WiFi):"
echo "      add the https://xxxxx.trycloudflare.com/manifest.json"
echo "      URL that the widget prints. This URL changes every"
echo "      time you tap the widget, so re-add it if it changes."
echo ""
echo " Tap the icon to serve. Stop with Ctrl+C or volume-down + C."
echo " Server also auto-stops after 90 min without a stream lookup"
echo " (override: IDLE_TIMEOUT_MIN=30 node server.mjs)."
echo "=============================================================="
