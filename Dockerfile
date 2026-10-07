# Node 22 evita el crash de WebSocket de supabase-js
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
# cookies opcional
COPY cookies.txt* ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
