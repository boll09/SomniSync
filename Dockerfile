FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    ALLOW_REMOTE=true \
    TELEGRAM_PYTHON_PATH=python3

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-telegram-call.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements-telegram-call.txt

COPY somnisync_sim.js somnisync_v2.html telegram_voice_call.py somnisync_emergency.wav ./

EXPOSE 3000
CMD ["node", "somnisync_sim.js"]
