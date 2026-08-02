#!/usr/bin/env bash
# ============================================================
#  Easyplay (local) - toggle server for Android (Termux)
#
#  Run this script to START the server, run it again to STOP.
#  First run auto-installs nodejs + git, downloads the repo once
#  and installs a home-screen widget (Termux:Widget) so you can
#  toggle the server with one tap.
#
#  One-time install (paste in Termux):
#    curl -sL https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/public/easyplay-android.sh | bash
#
#  After that, just tap the "Easyplay" home-screen widget.
# ============================================================

SCRIPT_URL="https://raw.githubusercontent.com/Tawhid-exe/Easyplay/main/public/easyplay-android.sh"

APP_DIR="$HOME/Easyplay"
PID_FILE="$HOME/.easyplay.pid"
TUNNEL_PID_FILE="$HOME/.easyplay-tunnel.pid"
LOG_FILE="$HOME/.easyplay.log"
LOG_TUNNEL="$HOME/.easyplay-tunnel.log"

# ---- Install home-screen widget (one-time) ------------------
if [ -d "$HOME/.shortcuts" ] && [ ! -f "$HOME/.shortcuts/Easyplay" ]; then
  if [ -f "$0" ]; then
    cp "$0" "$HOME/.shortcuts/Easyplay"
  else
    curl -sL "$SCRIPT_URL" -o "$HOME/.shortcuts/Easyplay"
  fi
  chmod +x "$HOME/.shortcuts/Easyplay" 2>/dev/null
  echo "==> Home-screen widget 'Easyplay' installed (Termux:Widget)."
fi

# ---- First-run bootstrap (downloads repo once) --------------
if [ ! -d "$APP_DIR" ]; then
  echo "==> First run: installing packages (nodejs, git)..."
  command -v node >/dev/null 2>&1 || pkg install -y nodejs-lts
  command -v git  >/dev/null 2>&1 || pkg install -y git
  echo "==> Downloading Easyplay (one time)..."
  git clone --depth 1 https://github.com/Tawhid-exe/Easyplay.git "$APP_DIR" || {
    echo "[ERROR] git clone failed. Check your connection."; exit 1;
  }
  cd "$APP_DIR" || exit 1
  npm install --omit=dev || { echo "[ERROR] npm install failed."; exit 1; }
else
  cd "$APP_DIR" || exit 1
fi

# ---- Toggle: stop if running -------------------------------
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
    echo "[Easyplay] server + tunnel stopped."
    exit 0
  fi
  rm -f "$PID_FILE" "$TUNNEL_PID_FILE"
fi

# ---- Start --------------------------------------------------
export ADDON_NAME="Easyplay (local)"
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
echo "[Easyplay] server + tunnel started."
echo "  THIS phone     : add  http://localhost:7000/manifest.json"
if [ -n "$URL" ]; then
  echo "  ALL devices    : add  $URL/manifest.json"
  echo "                  (TV/PC/phones, anywhere - tunnel URL)"
else
  echo "  Tunnel URL not ready - check:  cat ~/.easyplay-tunnel.log"
fi
echo "  Run this script again (or tap the widget) to stop."
