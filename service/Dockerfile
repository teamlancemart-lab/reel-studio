# Railway builds this with Root Directory "/" and Dockerfile Path "service/Dockerfile",
# so every COPY path below is relative to the REPO ROOT, not to service/.
FROM node:20-bookworm-slim

# ffmpeg for every render, python3 + venv for Pillow (all overlays are Pillow-rendered
# PNG sequences; this ffmpeg has no freetype, so drawtext does not exist).
# curl and ca-certificates are needed to fetch the fonts below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-venv \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Pillow lives in its own venv so nothing here fights the system python.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir "Pillow==11.0.0"
ENV PYTHON_BIN=/opt/venv/bin/python3
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY service/package.json service/package-lock.json ./
RUN npm ci --omit=dev

# Fonts at BUILD time, not at boot: a cold start must not depend on Google being up.
COPY service/scripts/fetch-fonts.sh ./scripts/fetch-fonts.sh
RUN bash scripts/fetch-fonts.sh /app/assets/fonts

COPY service/ ./
# Both deployables read /shared. In the container it lands at /app/shared.
COPY shared/ ./shared/

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

# The paid-video gate. Stays false until Stage 6 regardless of what Railway sets,
# unless it is set to exactly "true".
ENV GENERATIVE_ENABLED=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
