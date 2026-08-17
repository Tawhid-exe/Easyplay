#!/data/data/com.termux/files/usr/bin/bash
# Easyplay (local) - toggle server for Android (Termux)
#
# Self-bootstrapping installer: installs packages, downloads the repo once,
# installs the self-updating widget, then starts the engine + tunnel.
# After that, just tap the home-screen "start-server.sh" widget.
#
# One-time install (paste in Termux):
#    curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/public/easyplay-android.sh | bash
set -e

WIDGET_URL="https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/start-server.sh"
APP_DIR="$HOME/Easyplay"
SHORTCUTS="$HOME/.shortcuts"

echo "==> Installing packages (nodejs, git, curl, cloudflared)..."
command -v node       >/dev/null 2>&1 || pkg install -y nodejs-lts
command -v git        >/dev/null 2>&1 || pkg install -y git
command -v curl       >/dev/null 2>&1 || pkg install -y curl
command -v cloudflared >/dev/null 2>&1 || pkg install -y cloudflared

if [ ! -d "$APP_DIR" ]; then
  echo "==> Downloading Easyplay (one time)..."
  git clone --depth 1 https://github.com/Tawhid-exe/Easyplay.git "$APP_DIR" || {
    echo "[ERROR] git clone failed. Check your connection."; exit 1;
  }
  cd "$APP_DIR" || exit 1
  npm install --omit=dev || { echo "[ERROR] npm install failed."; exit 1; }
else
  cd "$APP_DIR" || exit 1
fi

echo "==> Installing the self-updating widget..."
mkdir -p "$SHORTCUTS"
if ! curl -fsSL "$WIDGET_URL" -o "$SHORTCUTS/start-server.sh" 2>/dev/null && [ -f "$APP_DIR/start-server.sh" ]; then
  cp "$APP_DIR/start-server.sh" "$SHORTCUTS/start-server.sh"
fi
chmod +x "$SHORTCUTS/start-server.sh" 2>/dev/null || true
cp "$SHORTCUTS/start-server.sh" "$SHORTCUTS/Easyplay" 2>/dev/null || true
chmod +x "$SHORTCUTS/Easyplay" 2>/dev/null || true

echo "==> Widget 'start-server.sh' installed (Termux:Widget)."
echo "    It self-updates on every tap. Starting now..."
echo ""
exec bash "$SHORTCUTS/start-server.sh"
