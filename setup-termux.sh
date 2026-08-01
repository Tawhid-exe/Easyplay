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
echo " 3. Stremio (same phone): Add-ons > Add external addon:"
echo "      http://localhost:7000/manifest.json"
echo ""
echo " Tap the icon to serve. Stop with volume-down + C."
echo " Server also auto-stops after 90 min without a stream lookup"
echo " (override: IDLE_TIMEOUT_MIN=30 node server.mjs)."
echo "=============================================================="
