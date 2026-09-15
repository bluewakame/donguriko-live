@echo off
setlocal
cd /d "%~dp0"

set "DOCKER_EXE=docker"
call :ResolveDockerExe
if errorlevel 1 (
  echo Docker Desktop was not found.
  pause
  exit /b 1
)

"%DOCKER_EXE%" compose -f docker-compose.open-webui.yml down
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
