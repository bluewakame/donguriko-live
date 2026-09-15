# Open WebUI

This project can run Open WebUI in Docker and connect it to the Ollama server
running on Windows.

## Start

1. Start Docker Desktop.
2. Double-click `start-open-webui.bat`.
3. Open `http://localhost:3000`.

The first run may take a while because Docker needs to download the Open WebUI
image.

If Docker Desktop stays on "Starting the Docker Engine", run
`fix-docker-desktop.bat` once. It restarts Docker Desktop and WSL, then waits for
Docker Engine to become ready.

## Stop

Double-click `stop-open-webui.bat`.

## Ollama Connection

Open WebUI connects to Ollama at:

```text
http://host.docker.internal:11434
```

If no models appear in Open WebUI, check the Open WebUI admin settings and make
sure the Ollama connection URL matches the URL above.

## Data

Chat history and settings are stored in the Docker volume `open-webui-data`.
