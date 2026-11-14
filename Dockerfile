# Stoop — build image.
#
# Node 24 runs the TypeScript directly (type stripping), so there is no build
# step and no dist/ to keep in sync. The image carries the app, the tests and
# the schema; nothing else.

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so the layer caches.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY db ./db
COPY test ./test
COPY README.md docs ./docs/

RUN addgroup -S stoop && adduser -S -G stoop stoop \
 && chown -R stoop:stoop /app
USER stoop

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
