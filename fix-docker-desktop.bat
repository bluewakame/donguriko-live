@echo off
setlocal

net session >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo This will restart Docker Desktop and WSL.
echo Any running WSL or Docker work will be stopped.
echo.
pause

echo [1/5] Stopping Docker Desktop processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name 'Docker Desktop','com.docker*','docker-agent','docker-sandbox' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

echo [2/5] Shutting down WSL...
wsl --shutdown

echo [3/5] Starting Docker Desktop service...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue"

echo [4/5] Starting Docker Desktop...
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
) else (
  echo Docker Desktop executable was not found at the standard location.
)

echo [5/5] Waiting for Docker Engine...
set /a WAIT_SECONDS=0
:WaitDocker
"C:\Program Files\Docker\Docker\resources\bin\docker.exe" version >nul 2>nul
if not errorlevel 1 (
  echo Docker Engine is ready.
  echo.
  echo You can now run start-open-webui.bat.
  pause
  exit /b 0
)
set /a WAIT_SECONDS+=5
if %WAIT_SECONDS% GEQ 120 (
  echo Docker Engine did not become ready within 2 minutes.
  echo Try rebooting Windows, then run this file again.
  pause
  exit /b 1
)
timeout /t 5 /nobreak >nul
goto :WaitDocker
