FROM oven/bun:1.4.2-slim

# Document extraction stays inside the service: PDF text, OCR for scans, legacy Word.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng antiword \
    && rm -rf /var/lib/apt/lists/*

ARG APP_VERSION=dev
ARG APP_REVISION=unknown
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_REVISION
ENV APP_REVISION=$APP_REVISION

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY public ./public
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY scripts/create-user.ts ./scripts/create-user.ts
COPY migrations ./migrations

# The app needs no privileges; sessions are written to the mounted /data.
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080

CMD ["bun", "src/server.ts"]
