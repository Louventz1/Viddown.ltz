FROM node:20-slim

# Install yt-dlp + ffmpeg (needed to merge video+audio for 4K)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Create downloads dir
RUN mkdir -p downloads

ENV YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV NODE_ENV=production

EXPOSE 3737

CMD ["node", "server.js"]

