# syntax=docker/dockerfile:1

# Multi-stage production image:
# - Builds Expo web + backend (TypeScript) and runs the backend server.
# - Includes Prisma CLI + migrations so deployments can run `prisma migrate deploy` inside the container.
# - Retains the repository license and required notice in the runtime image.

# Pin the multi-platform base digest so release rebuilds do not silently change underneath a tag.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS base
RUN apk add --no-cache bash openssl ca-certificates
WORKDIR /app

FROM base AS deps

# The pinned release toolkit is a Git dependency used only while building the application.
RUN apk add --no-cache git

COPY package.json package-lock.json ./
COPY mobile/package.json ./mobile/package.json
COPY mobile/modules/wear-pairing/package.json ./mobile/modules/wear-pairing/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --no-audit --fund=false

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --no-audit --fund=false

FROM deps AS build

COPY backend ./backend
COPY mobile ./mobile
COPY packages ./packages
COPY shared ./shared
COPY scripts/expo-cli-environment.mjs scripts/expo-web-build.mjs scripts/expo-web-release.mjs ./scripts/

RUN cd backend && npm run build
RUN npm run build:expo-web

FROM base AS runtime-deps

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev --no-audit --fund=false

FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV FRONTEND_DIST_DIR=/app/web/dist

WORKDIR /app

COPY LICENSE NOTICE ./
COPY backend/LICENSE ./backend/LICENSE
COPY --from=build /app/backend/package.json /app/backend/package.json
COPY --from=runtime-deps /app/backend/node_modules /app/backend/node_modules
# `npm ci --omit=dev` installs @prisma/client but does not generate its schema-specific runtime.
COPY --from=build /app/backend/node_modules/.prisma /app/backend/node_modules/.prisma
COPY --from=build /app/backend/dist /app/backend/dist
COPY --from=build /app/backend/prisma /app/backend/prisma
COPY --from=build /app/backend/prisma.config.ts /app/backend/prisma.config.ts
COPY --from=build /app/backend/src/config/databaseUtils.ts /app/backend/src/config/databaseUtils.ts
COPY --from=build /app/backend/scripts /app/backend/scripts

COPY --from=build /app/mobile/dist /app/web/dist

WORKDIR /app/backend
EXPOSE 3000

# The entrypoint calls Node and Prisma directly; npm is build tooling and is not part of the
# production attack surface. Removing it also avoids shipping npm's bundled dependencies.
RUN chmod +x /app/backend/scripts/start-prod.sh \
    && rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /opt/yarn-*

# Supply DB-backed readiness to existing homelab Compose stacks that do not define a healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=45s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["./scripts/start-prod.sh"]
