# Build context: repo root. NEXT_STANDALONE=1 below switches next.config to `output: 'standalone'` (docs/IMPLEMENTATION_ROADMAP.md §3.5).
FROM node:24-alpine AS build
RUN npm install -g pnpm@9.15.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
# NEXT_PUBLIC_* are inlined into the bundle at build time. Empty server URL = same origin (server proxies the web app).
ARG NEXT_PUBLIC_SERVER_URL=
ARG NEXT_PUBLIC_EXTENSION_ID=
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL \
    NEXT_PUBLIC_EXTENSION_ID=$NEXT_PUBLIC_EXTENSION_ID \
    NEXT_TELEMETRY_DISABLED=1 \n    NEXT_STANDALONE=1
RUN pnpm turbo run build --filter=@watchparty/web...
RUN mkdir -p apps/web/public

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
