FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY collaboration-server/package.json collaboration-server/package.json
RUN pnpm install --frozen-lockfile --filter @casebang/collaboration-server...

COPY collaboration-server collaboration-server
RUN pnpm --filter @casebang/collaboration-server build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY collaboration-server/package.json collaboration-server/package.json
RUN pnpm install --frozen-lockfile --prod --filter @casebang/collaboration-server... \
  && mkdir -p /data/workbooks \
  && chown -R node:node /data/workbooks /app

COPY --from=build --chown=node:node /app/collaboration-server/dist collaboration-server/dist
COPY --chown=node:node collaboration-server/migrations collaboration-server/migrations

USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "collaboration-server/dist/index.js"]
