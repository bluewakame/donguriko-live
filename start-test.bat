@echo off
setlocal
cd /d "%~dp0"

set "OLLAMA_MODELS=C:\Users\Public\OllamaModels"
set "OLLAMA_MODEL=gemma4:e2b"

echo Starting local test...
node src/app.js --local-test
pause
