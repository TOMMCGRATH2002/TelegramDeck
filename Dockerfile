# TelegramDeck — Node + truthbrush (Python venv) for Truth Social columns
# bookworm-slim: glibc + wheels for curl_cffi (truthbrush dependency)
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv \
    build-essential \
    python3-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app

USER node
RUN python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
  && /app/.venv/bin/pip install --no-cache-dir truthbrush

# Inside the container; override with .env only if you use a custom path
ENV TRUTHBRUSH_BIN=/app/.venv/bin/truthbrush

EXPOSE 3000
CMD ["node", "server/index.js"]
