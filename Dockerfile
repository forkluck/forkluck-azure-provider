FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 has no musl prebuild, so it is compiled here; the toolchain is
# dropped again in the same layer to keep it out of the final image.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps
COPY server.js .
COPY lib/ lib/

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD sh -c 'if [ "${APP_ROLE:-all}" = "worker" ]; then exit 0; fi; wget --spider -q "http://localhost:${PORT:-3003}/health" || exit 1'

EXPOSE 3003

CMD ["node", "server.js"]
