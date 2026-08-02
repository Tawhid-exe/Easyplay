#!/usr/bin/env bash
# Easyplay - one-tap Android addon server (Termux + Termux:Widget)
# Run once:  curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/setup-termux.sh | bash
set -e

echo "==> Installing packages (node, termux-api, git)..."
pkg update -y
pkg install -y nodejs-lts termux-api git

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
PHONE_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
if [ -z "$PHONE_IP" ]; then
  PHONE_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
echo ""
echo "=============================================================="
echo "  Easyplay server starting on port 7000"
echo ""
echo "  THIS phone    : add  http://localhost:7000/manifest.json"
if [ -n "$PHONE_IP" ]; then
  echo "  OTHER devices : add  http://$PHONE_IP:7000/manifest.json"
  echo "                  (TV, PC, other phones - same WiFi)"
fi
echo "=============================================================="
echo ""
exec node server.mjs
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
echo "    The widget prints your URLs when it starts."
echo ""
echo " 3. Stremio on THIS phone: Add-ons > Add external addon:"
echo "      http://localhost:7000/manifest.json"
echo ""
echo " 4. Other devices (TV/PC/phones on the same WiFi) must add:"
echo "      http://<this-phone's-LAN-IP>:7000/manifest.json"
echo "    The LAN IP is printed when you tap the widget, and by"
echo "    'node server.mjs' at startup. Do NOT use localhost there."
echo ""
echo " Tap the icon to serve. Stop with volume-down + C."
echo " Server also auto-stops after 90 min without a stream lookup"
echo " (override: IDLE_TIMEOUT_MIN=30 node server.mjs)."
echo "=============================================================="
