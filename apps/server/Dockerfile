# Build context: repo root (docker compose sets it). docker build -f apps/server/Dockerfile .
FROM node:24-alpine AS build
RUN npm install -g pnpm@9.15.4
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@watchparty/server...
RUN pnpm --filter @watchparty/server deploy --prod /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
