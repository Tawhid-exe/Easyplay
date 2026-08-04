@echo off
rem ============================================================
rem  Easyplay - one-click engine for Windows
rem
rem  Double-click this file to START the engine, double-click it
rem  again to STOP.
rem
rem  It runs the scraper on your PC and relays it through a free
rem  Cloudflare tunnel to the stable addon URL - so every device
rem  installs ONE URL that never changes:
rem
rem      https://easyplay-9id.pages.dev/manifest.json
rem
rem  The engine also auto-stops after 90 min without activity.
rem ============================================================
setlocal
title Easyplay engine (port 7000)

set "APP_DIR=%USERPROFILE%\Easyplay"
set "CF=%APP_DIR%\cloudflared.exe"
set "NODE_PID_FILE=%TEMP%\easyplay-node.pid"
set "TUNNEL_PID_FILE=%TEMP%\easyplay-tunnel.pid"
set "SERVER_LOG=%TEMP%\easyplay-server.log"
set "SERVER_ERR=%TEMP%\easyplay-server-err.log"
set "TUNNEL_LOG=%TEMP%\easyplay-tunnel.log"
set "TUNNEL_ERR=%TEMP%\easyplay-tunnel-err.log"
set "REGISTER_URL=https://easyplay-9id.pages.dev/api/register"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  echo         then double-click this file again.
  pause
  exit /b 1
)

rem ---- Stop if the engine is already running (toggle) --------
if not exist "%NODE_PID_FILE%" goto :bootstrap
set /p NODE_PID=<"%NODE_PID_FILE%"
tasklist /FI "PID eq %NODE_PID%" 2>nul | find /i "%NODE_PID%" >nul
if errorlevel 1 goto :bootstrap

echo [Easyplay] Engine is running - stopping...
set "TUNNEL_PID="
if exist "%TUNNEL_PID_FILE%" set /p TUNNEL_PID=<"%TUNNEL_PID_FILE%"
if defined TUNNEL_PID (taskkill /PID %TUNNEL_PID% /F >nul 2>nul) else (taskkill /IM cloudflared.exe /F >nul 2>nul)
taskkill /PID %NODE_PID% /F >nul 2>nul
del /q "%NODE_PID_FILE%" "%TUNNEL_PID_FILE%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[string]$env:REGISTER_TOKEN; Invoke-WebRequest -Uri '%REGISTER_URL%?url=&token='+[uri]::EscapeDataString($t) -Method Post -UseBasicParsing -TimeoutSec 20 | Out-Null" >nul 2>nul
echo [Easyplay] Stopped. The addon will fall back to cloud sources.
pause
exit /b 0

:bootstrap
del /q "%NODE_PID_FILE%" "%TUNNEL_PID_FILE%" >nul 2>nul

rem ---- Download Easyplay once ---------------------------------
if not exist "%APP_DIR%" (
  echo [1/4] Downloading Easyplay...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $z='%TEMP%\easyplay.zip'; $x='%TEMP%\easyplay-extract'; if (Test-Path $x) { Remove-Item $x -Recurse -Force }; Invoke-WebRequest -Uri 'https://github.com/Tawhid-exe/Easyplay/archive/refs/heads/main.zip' -OutFile $z; Expand-Archive -Path $z -DestinationPath $x -Force; Move-Item -Path (Join-Path $x 'Easyplay-main') -Destination '%APP_DIR%' -Force; Remove-Item $z -Force"
  if errorlevel 1 (
    echo [ERROR] Download failed. Check your internet connection.
    echo         If the folder is incomplete, delete "%APP_DIR%" and retry.
    pause
    exit /b 1
  )
)

cd /d "%APP_DIR%"

if not exist node_modules (
  echo [2/4] Installing dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

rem ---- Download cloudflared once ------------------------------
if not exist "%CF%" (
  echo [INFO] Downloading cloudflared (one time)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CF%'"
  if errorlevel 1 (
    echo [ERROR] cloudflared download failed. Check your internet connection.
    pause
    exit /b 1
  )
)

for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue|?{$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*'};$p=@($c|?{$_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[01])\.'})[0];if(-not $p){$p=@($c)[0]};if($p){$p.IPAddress}"') do set "LAN_IP=%%i"

rem ---- Start engine (background) ------------------------------
echo [3/4] Starting engine...
set "ADDON_NAME=Easyplay"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '%APP_DIR%' -RedirectStandardOutput '%SERVER_LOG%' -RedirectStandardError '%SERVER_ERR%' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '%NODE_PID_FILE%' -Value $p.Id"
timeout /t 2 /nobreak >nul
if not exist "%NODE_PID_FILE%" (
  echo [ERROR] Engine failed to start. See: %SERVER_ERR%
  pause
  exit /b 1
)
set /p NODE_PID=<"%NODE_PID_FILE%"
tasklist /FI "PID eq %NODE_PID%" 2>nul | find /i "%NODE_PID%" >nul
if errorlevel 1 (
  echo [ERROR] Engine failed to start. See: %SERVER_ERR%
  pause
  exit /b 1
)

rem ---- Open free Cloudflare tunnel ----------------------------
echo [INFO] Opening free Cloudflare tunnel...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%CF%' -ArgumentList 'tunnel','--url','http://localhost:7000' -RedirectStandardOutput '%TUNNEL_LOG%' -RedirectStandardError '%TUNNEL_ERR%' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '%TUNNEL_PID_FILE%' -Value $p.Id"

echo [INFO] Waiting for tunnel URL...
set "TUNNEL_URL="
for /f "delims=" %%u in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%TUNNEL_LOG%'; for($i=0;$i -lt 60;$i++){ $c=Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue; $m=[regex]::Match($c,'https://[a-z0-9.-]+\.trycloudflare\.com'); if($m.Success){ $m.Value; exit }; Start-Sleep -Seconds 1 }"') do set "TUNNEL_URL=%%u"

rem ---- Register with the relay --------------------------------
echo [4/4] Registering engine with relay...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%TUNNEL_URL%'; $t=[string]$env:REGISTER_TOKEN; Invoke-WebRequest -Uri '%REGISTER_URL%?url='+[uri]::EscapeDataString($u)+'&token='+[uri]::EscapeDataString($t) -Method Post -UseBasicParsing -TimeoutSec 20 | Out-Null" >nul 2>nul

echo.
echo  ==========================================================
echo   INSTALL ONCE (any device) - never changes:
echo     https://easyplay-9id.pages.dev/manifest.json
echo.
echo   Local URLs (same network, optional):
echo     This PC : http://localhost:7000/manifest.json
if defined LAN_IP (
  echo     Phone   : http://%LAN_IP%:7000/manifest.json
)
if defined TUNNEL_URL (
  echo.
  echo   PC engine online at:  %TUNNEL_URL%
) else (
  echo.
  echo   [WARNING] Tunnel URL not ready - check: %TUNNEL_ERR%
)
echo.
echo   Run this file again to STOP the engine.
echo   It also auto-stops after 90 min without activity.
echo  ==========================================================
echo.

rem ---- Keep this window open while the engine runs -----------
:wait
if not exist "%NODE_PID_FILE%" goto :stopped
set /p NODE_PID=<"%NODE_PID_FILE%"
tasklist /FI "PID eq %NODE_PID%" 2>nul | find /i "%NODE_PID%" >nul
if errorlevel 1 goto :stopped
timeout /t 5 /nobreak >nul
goto :wait

:stopped
echo.
echo [Easyplay] Engine stopped.
set "TUNNEL_PID="
if exist "%TUNNEL_PID_FILE%" set /p TUNNEL_PID=<"%TUNNEL_PID_FILE%"
if defined TUNNEL_PID (taskkill /PID %TUNNEL_PID% /F >nul 2>nul) else (taskkill /IM cloudflared.exe /F >nul 2>nul)
if defined NODE_PID taskkill /PID %NODE_PID% /F >nul 2>nul
del /q "%NODE_PID_FILE%" "%TUNNEL_PID_FILE%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[string]$env:REGISTER_TOKEN; Invoke-WebRequest -Uri '%REGISTER_URL%?url=&token='+[uri]::EscapeDataString($t) -Method Post -UseBasicParsing -TimeoutSec 20 | Out-Null" >nul 2>nul
echo  Relay unregistered - the addon will fall back to cloud sources.
pause
exit /b 0
