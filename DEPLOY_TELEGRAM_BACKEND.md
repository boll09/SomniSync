# Deploy the live Telegram backend

The GitHub Pages workflow serves the dashboard only. Live Telegram calls require the Docker service in this repository.

## Create a Telegram session string

Run locally after installing the requirements and completing login:

```powershell
$env:TELEGRAM_API_ID = "..."
$env:TELEGRAM_API_HASH = "..."
.\.venv-telegram\Scripts\python.exe .\telegram_voice_call.py --login --export-session
```

Copy the value after `TELEGRAM_SESSION_STRING=` into the deployment platform's secret manager. Never commit it.

## Required environment variables

```text
TELEGRAM_API_ID        # from https://my.telegram.org/apps
TELEGRAM_API_HASH      # secret
TELEGRAM_CALL_TO       # recipient username, for example @somni_contact
TELEGRAM_SESSION_STRING # secret exported by the command above
CALL_MODE               # leave unset; select Telegram call in the dashboard
```

The container listens on `0.0.0.0:$PORT` and exposes `GET /healthz` for the platform health check. The Docker image contains the emergency WAV and installs `ntgcalls` and Pyrogram.

## Railway / Render

Create a service from the GitHub repository and choose Dockerfile deployment. Set the variables above as secrets, expose port `3000` (or use the platform-provided `PORT`), and set the health check path to `/healthz`. Open the service URL, select **Telegram call**, then trigger an alert.

A real call is placed only after the 15-second countdown and only when the recipient accepts the Telegram user-to-user call. GitHub Pages alone cannot run this backend.
