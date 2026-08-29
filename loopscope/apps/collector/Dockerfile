FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY apps/collector/package.json apps/collector/package.json
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps/collector ./apps/collector
RUN pnpm --filter @loopscope/contracts build \
 && pnpm --filter @loopscope/db build \
 && pnpm --filter @loopscope/storage build \
 && pnpm --filter @loopscope/collector build
ENV LOOPSCOPE_HOST=0.0.0.0 \
    LOOPSCOPE_PORT=4320 \
    LOOPSCOPE_DB_PATH=/data/loopscope.db \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4320
CMD ["node", "apps/collector/dist/server.js"]
