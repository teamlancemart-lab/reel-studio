FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv python3-pip libvips \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY worker/package*.json ./
RUN npm install --omit=dev
COPY worker/ ./
COPY shared/ ./shared/
CMD ["node", "src/index.js"]
