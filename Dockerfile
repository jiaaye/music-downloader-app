FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir --upgrade yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV HOST=0.0.0.0 \
  PORT=4587 \
  MUSIC_ROOT=/music \
  CONFIG_PATH=/data/config.json \
  DB_PATH=/data/music.db \
  PREVIEW_DIR=/data/preview-cache

RUN mkdir -p /data /music

EXPOSE 4587

CMD ["npm", "start"]
