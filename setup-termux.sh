#!/usr/bin/env bash
# Easyplay - one-tap Android addon server (Termux + Termux:Widget)
# Run once:  curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/setup-termux.sh | bash
set -e

echo "==> Installing packages (node, termux-api, git, curl, cloudflared)..."
pkg update -y
pkg install -y nodejs-lts termux-api git curl cloudflared

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

echo "==> Installing the self-updating widget..."
if [ -f "$HOME/Easyplay/start-server.sh" ]; then
  cp "$HOME/Easyplay/start-server.sh" "$SHORTCUTS/start-server.sh"
else
  echo "==> start-server.sh missing in repo - downloading..."
  curl -fsSL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/start-server.sh -o "$SHORTCUTS/start-server.sh"
fi
chmod +x "$SHORTCUTS/start-server.sh"
cp "$SHORTCUTS/start-server.sh" "$SHORTCUTS/Easyplay" 2>/dev/null || true
chmod +x "$SHORTCUTS/Easyplay" 2>/dev/null || true

echo ""
echo "=============================================================="
echo "  Setup complete."
echo ""
echo " 1. Disable battery optimization for Termux:"
echo "      Settings > Apps > Termux > Battery > Unrestricted"
echo " 2. Home screen: long-press empty area > Widgets >"
echo "      Termux:Widget > tap 'start-server.sh'"
echo "    The widget starts the scraper engine + a tunnel and publishes"
echo "    it to the relay. It self-updates on every tap."
echo ""
echo " 3. Install the addon ONCE (any device, including this phone):"
echo "      https://easyplay-9id.pages.dev/manifest.json"
echo "    That URL never changes - no re-install needed, ever."
echo ""
echo " 4. Streams come from this phone while the widget is on."
echo "    If the phone is off, the relay falls back to cloud-only"
echo "    (Vidlink + Castle) sources automatically."
echo ""
echo " Status:  cat ~/.easyplay-relay.log"
echo "=============================================================="
