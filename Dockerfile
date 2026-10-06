FROM oven/bun:1.4.2-slim

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY public ./public

# The app needs no privileges; sessions are written to the mounted /data.
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080

CMD ["bun", "src/server.ts"]
