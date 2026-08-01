@echo off
rem ============================================================
rem  Easyplay - one-click local addon server for Windows
rem  Double-click this file, then add this in Stremio:
rem      http://localhost:7000/manifest.json
rem  On the phone (same WiFi): use the "Phone" URL that the
rem  server prints at startup (http://192.168.x.x:7000/...).
rem  First run: allow Node.js through Windows Firewall when
rem  prompted so the phone can reach this PC.
rem  Stop: press Ctrl+C in this window (or just close it).
rem  The server also auto-stops after 90 min without activity.
rem ============================================================
setlocal
title Easyplay addon server (port 7000)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  echo         then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] Installing dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo  Addon URL:  http://localhost:7000/manifest.json
echo  Press Ctrl+C when done watching to stop the server.
echo.

node server.mjs
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited unexpectedly. See message above.
  pause
)
