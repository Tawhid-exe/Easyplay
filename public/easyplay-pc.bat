@echo off
rem ============================================================
rem  Easyplay (local) - one-click server for Windows
rem  Double-click this file. It downloads Easyplay once, installs
rem  dependencies, then starts the server.
rem  Stop: press Ctrl+C in this window (or just close it).
rem  The server also auto-stops after 90 min without activity.
rem ============================================================
setlocal
title Easyplay (local) server setup
cd /d "%USERPROFILE%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  echo         then double-click this file again.
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\Easyplay" (
  echo [1/3] Downloading Easyplay...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $z='%TEMP%\easyplay.zip'; $x='%TEMP%\easyplay-extract'; if (Test-Path $x) { Remove-Item $x -Recurse -Force }; Invoke-WebRequest -Uri 'https://github.com/Tawhid-exe/Easyplay/archive/refs/heads/main.zip' -OutFile $z; Expand-Archive -Path $z -DestinationPath $x -Force; Move-Item -Path (Join-Path $x 'Easyplay-main') -Destination '%USERPROFILE%\Easyplay' -Force; Remove-Item $z -Force"
  if errorlevel 1 (
    echo [ERROR] Download failed. Check your internet connection.
    echo         If the folder is incomplete, delete "%USERPROFILE%\Easyplay" and retry.
    pause
    exit /b 1
  )
)

cd /d "%USERPROFILE%\Easyplay"

if not exist node_modules (
  echo [2/3] Installing dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue|?{$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*'};$p=@($c|?{$_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.'})[0];if(-not $p){$p=@($c)[0]};if($p){$p.IPAddress}"') do set "LAN_IP=%%i"

echo [3/3] Starting server...
echo.
echo  ==========================================================
echo   Addon URLs to install in Stremio:
echo.
echo   This PC : http://localhost:7000/manifest.json
if defined LAN_IP (
  echo   Phone   : http://%LAN_IP%:7000/manifest.json
)
echo.
echo   On phones/TV use the Phone URL above - NOT "localhost".
echo   ^(localhost on a phone means the phone itself.^)
echo  ==========================================================
echo.
echo  Press Ctrl+C when done watching to stop the server.
echo.

set "ADDON_NAME=Easyplay (local)"
node server.mjs
if errorlevel 1 (
  echo.
  echo [ERROR] Server exited unexpectedly. See message above.
  pause
)
