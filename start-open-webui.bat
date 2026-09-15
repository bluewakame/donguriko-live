@echo off
setlocal
cd /d "%~dp0"

set "OLLAMA_MODELS=C:\Users\Public\OllamaModels"
set "OLLAMA_MODEL=gemma4:e2b"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
set "DOCKER_EXE=docker"
set "OPEN_WEBUI_URL=http://localhost:3000"
if not exist "%OLLAMA_MODELS%" mkdir "%OLLAMA_MODELS%" >nul 2>nul

echo [1/3] Checking Docker...
call :ResolveDockerExe
if errorlevel 1 (
  echo Docker Desktop was not found.
  echo Install Docker Desktop, start it, then run this file again.
  echo https://docs.docker.com/desktop/setup/install/windows-install/
  pause
  exit /b 1
)
"%DOCKER_EXE%" version >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop was found, but it is not running yet.
  echo Please start Docker Desktop, then run this file again.
  pause
  exit /b 1
)

echo [2/3] Starting Ollama for this project...
call :RestartOllamaForModelPath
call :StartOllama
call :WaitHttp "http://127.0.0.1:11434/api/tags" 20 "Ollama"
if errorlevel 1 (
  echo Ollama did not become ready. Open WebUI will start, but models may not appear yet.
) else (
  call :EnsureOllamaModel
)

echo [3/3] Starting Open WebUI...
"%DOCKER_EXE%" compose -f docker-compose.open-webui.yml up -d
if errorlevel 1 (
  echo Open WebUI could not be started.
  pause
  exit /b 1
)

echo.
echo Waiting for Open WebUI...
call :WaitHttp "%OPEN_WEBUI_URL%" 90 "Open WebUI"
if errorlevel 1 (
  echo Open WebUI is still starting. Try refreshing the browser after a minute.
)
echo Open WebUI URL:
echo %OPEN_WEBUI_URL%
echo.
start "" "%OPEN_WEBUI_URL%"
pause
exit /b 0

:ResolveDockerExe
where docker >nul 2>nul
if not errorlevel 1 (
  set "DOCKER_EXE=docker"
  exit /b 0
)
if exist "%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe" (
  set "DOCKER_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe"
  exit /b 0
)
if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" (
  set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  exit /b 0
)
exit /b 1

:ResolveOllamaExe
if exist "%OLLAMA_EXE%" exit /b 0
for /f "delims=" %%I in ('where ollama 2^>nul') do (
  set "OLLAMA_EXE=%%I"
  exit /b 0
)
exit /b 1

:StartOllama
call :ResolveOllamaExe
if errorlevel 1 (
  echo Ollama executable was not found.
  exit /b 1
)
start "Ollama server" /min cmd /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& ""%OLLAMA_EXE%"" serve"
exit /b 0

:RestartOllamaForModelPath
echo Restarting Ollama so it uses %OLLAMA_MODELS%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
timeout /t 2 /nobreak >nul
exit /b 0

:CheckOllamaModel
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5; if (@($tags.models | Where-Object { $_.name -eq $env:OLLAMA_MODEL }).Count -gt 0) { exit 0 }; exit 1"
exit /b %errorlevel%

:EnsureOllamaModel
call :CheckOllamaModel
if not errorlevel 1 (
  echo %OLLAMA_MODEL% is ready.
  exit /b 0
)
echo Pulling %OLLAMA_MODEL% into %OLLAMA_MODELS%
call :ResolveOllamaExe
if errorlevel 1 (
  echo Ollama executable was not found. Run: ollama pull %OLLAMA_MODEL%
  exit /b 1
)
cmd /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& ""%OLLAMA_EXE%"" pull %OLLAMA_MODEL%"
exit /b %errorlevel%

:CheckHttp
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%~1' -UseBasicParsing -TimeoutSec %~2 | Out-Null; exit 0 } catch { exit 1 }"
exit /b %errorlevel%

:WaitHttp
set "WAIT_URL=%~1"
set /a WAIT_SECONDS=%~2
set "WAIT_NAME=%~3"
set /a WAIT_COUNT=0
:WaitHttpLoop
call :CheckHttp "%WAIT_URL%" 2
if not errorlevel 1 (
  echo %WAIT_NAME% is ready.
  exit /b 0
)
set /a WAIT_COUNT+=2
if %WAIT_COUNT% GEQ %WAIT_SECONDS% (
  echo Timed out waiting for %WAIT_NAME%.
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto :WaitHttpLoop
