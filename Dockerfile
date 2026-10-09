FROM node:22-slim

# Instalar dependencias del sistema (Python3, ffmpeg y certificados)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instalar y actualizar yt-dlp a la versión más reciente
RUN python3 -m pip install --no-cache-dir -U --break-system-packages yt-dlp

WORKDIR /app

# Copiar manifiestos e instalar dependencias de Node
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto del código (incluyendo cookies.txt si existe en la raíz)
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
