@echo off
setlocal
cd /d "%~dp0"
set "APP_DIR=%~dp0"

rem Drama 3 version: voices come from the Fish Audio Drama 3 cloud API instead of irodori-TTS.
set "TTS_ENGINE=fish-drama3"
set "OLLAMA_MODELS=C:\Users\Public\OllamaModels"
set "OLLAMA_MODEL=gemma4:e4b"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not exist "%OLLAMA_MODELS%" mkdir "%OLLAMA_MODELS%" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-Content -Raw -Encoding UTF8 'config.json' | ConvertFrom-Json; if ($c.tiktok -and $c.tiktok.uniqueId) { exit 0 }; exit 1"
if errorlevel 1 (
  echo config.json tiktok.uniqueId is empty. Put your TikTok user name ^(after @^) there.
  pause
  exit /b 1
)

echo [1/4] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\tiktok-live-connector" (
  echo Installing Node.js packages for TikTok...
  call npm install --no-audit --no-fund
  if errorlevel 1 echo npm install failed. TikTok comments will not work until it succeeds.
)

echo [2/4] Checking Ollama...
call :RestartOllamaForModelPath
call :StartOllama
call :WaitHttp "http://127.0.0.1:11434/api/tags" 20 "Ollama"
if errorlevel 1 echo Ollama is still starting. Replies may wait until Ollama is ready.
call :EnsureOllamaModel
call :RepairOllamaModelIfNeeded
if errorlevel 1 echo %OLLAMA_MODEL% still failed to load. Replies may not work until the model is repaired manually.

echo [3/4] Checking Fish Audio Drama 3 settings...
call :CheckFishAudio
if errorlevel 1 (
  pause
  exit /b 1
)

echo [4/4] Starting live bot (TikTok only)...
call :FindFreeUiPort 8790 8899
if errorlevel 1 (
  echo Could not find a free UI port between 8790 and 8899.
  pause
  exit /b 1
)
echo OBS URL: http://127.0.0.1:%PORT%
echo OBS vertical URL: http://127.0.0.1:%PORT%/vertical
node src/app.js --tiktok-only

echo.
echo Live bot stopped.
pause
exit /b 0

:ResolveOllamaExe
if exist "%OLLAMA_EXE%" exit /b 0
for /f "delims=" %%I in ('where ollama 2^>nul') do (
  set "OLLAMA_EXE=%%I"
  exit /b 0
)
exit /b 1

:StartOllama
echo Starting Ollama server...
call :ResolveOllamaExe
if errorlevel 1 (
  echo Ollama executable was not found. Replies may not work until Ollama is started manually.
  exit /b 1
)
rem Flash Attention and a q8_0 KV cache shrink Ollama's GPU memory so Gemma stays 100%% on GPU.
start "Ollama server" /min cmd /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& set OLLAMA_FLASH_ATTENTION=1&& set OLLAMA_KV_CACHE_TYPE=q8_0&& ""%OLLAMA_EXE%"" serve"
exit /b 0

:RestartOllamaForModelPath
echo Restarting Ollama so it uses %OLLAMA_MODELS%
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name 'ollama*','llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
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
if errorlevel 1 echo Could not pull %OLLAMA_MODEL%. Run: ollama pull %OLLAMA_MODEL%
exit /b %errorlevel%

:CheckOllamaModelLoads
echo Testing %OLLAMA_MODEL% load...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $body = @{ model = $env:OLLAMA_MODEL; prompt = 'ping'; stream = $false; options = @{ num_predict = 1 } } ^| ConvertTo-Json -Depth 4; $res = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 45; if ($res.error) { Write-Host $res.error; exit 1 }; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
exit /b %errorlevel%

:RepairOllamaModelIfNeeded
call :CheckOllamaModelLoads
if not errorlevel 1 (
  echo %OLLAMA_MODEL% loaded successfully.
  exit /b 0
)
echo %OLLAMA_MODEL% failed to load. Removing and pulling a fresh copy...
call :ResolveOllamaExe
if errorlevel 1 (
  echo Ollama executable was not found. Run: ollama rm %OLLAMA_MODEL% then ollama pull %OLLAMA_MODEL%
  exit /b 1
)
cmd /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& ""%OLLAMA_EXE%"" rm %OLLAMA_MODEL%"
cmd /c "set OLLAMA_MODELS=%OLLAMA_MODELS%&& ""%OLLAMA_EXE%"" pull %OLLAMA_MODEL%"
if errorlevel 1 exit /b %errorlevel%
call :CheckOllamaModelLoads
exit /b %errorlevel%

:CheckFishAudio
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-Content -Raw -Encoding UTF8 'config.json' | ConvertFrom-Json; $f = $c.tts.fish; $key = $env:FISH_API_KEY; if (-not $key -and $f) { $key = $f.apiKey }; if (-not $key) { exit 1 }; if (-not ($f -and ($f.referenceId -or $f.refWav))) { Write-Host 'tts.fish.referenceId / refWav is empty. Drama 3 will use its default voice.' }; exit 0"
if errorlevel 1 (
  echo Fish Audio API key was not found.
  echo Put it in config.json tts.fish.apiKey, or set the FISH_API_KEY environment variable.
  exit /b 1
)
echo Fish Audio Drama 3 is ready.
exit /b 0

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

:CheckTcp
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $c = New-Object Net.Sockets.TcpClient; $iar = $c.BeginConnect('%~1',%~2,$null,$null); if (-not $iar.AsyncWaitHandle.WaitOne((%~3 * 1000),$false)) { $c.Close(); exit 1 }; $c.EndConnect($iar); $c.Close(); exit 0 } catch { exit 1 }"
exit /b %errorlevel%

:FindFreeUiPort
set /a UI_PORT=%~1
set /a UI_PORT_MAX=%~2
:FindFreeUiPortLoop
call :CheckTcp 127.0.0.1 %UI_PORT% 1
if errorlevel 1 (
  set "PORT=%UI_PORT%"
  exit /b 0
)
echo Port %UI_PORT% is already in use. Trying next port...
set /a UI_PORT+=1
if %UI_PORT% GTR %UI_PORT_MAX% exit /b 1
goto :FindFreeUiPortLoop

:WaitTcp
set "WAIT_HOST=%~1"
set "WAIT_PORT=%~2"
set /a WAIT_SECONDS=%~3
set "WAIT_NAME=%~4"
set /a WAIT_COUNT=0
:WaitTcpLoop
call :CheckTcp "%WAIT_HOST%" %WAIT_PORT% 2
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
goto :WaitTcpLoop
