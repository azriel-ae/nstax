# syntax=docker/dockerfile:1
# NSTAX V1 — image `nstax`. Hanya V1: direktori client/src/v2, route /v2, dan CSS khusus V2 dikeluarkan saat build
# (lihat docker/strip-v2.mjs). Port aplikasi: 3000 (server/index.ts membaca env PORT, default 3000).
#
#   build   : docker build -t nstax:latest .
#   jalan   : docker run --rm -p 3000:3000 nstax:latest
#   tes     : docker build --target test .        (menjalankan vitest pada kode V1; tidak memengaruhi image final)

ARG NODE_VERSION=22

# ── 1) dependensi (persis sesuai package-lock.json) ──
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

# ── 2) source V1 saja ──
FROM deps AS src
COPY tsconfig.json tsconfig.node.json vite.config.ts components.json ./
COPY client ./client
COPY server ./server
COPY docker ./docker
RUN node docker/strip-v2.mjs

# ── 3) (opsional) tes: docker build --target test . ──
FROM src AS test
RUN npx vitest run

# ── 4) build production: client → dist/public, server → dist/index.js ──
FROM src AS build
RUN npm run build \
 && node docker/assert-no-v2.mjs

# ── 5) dependensi runtime saja (tanpa devDependencies) ──
FROM deps AS prod-deps
RUN npm prune --omit=dev --legacy-peer-deps --no-audit --no-fund

# ── 6) image final ──
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/package.json /app/package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
