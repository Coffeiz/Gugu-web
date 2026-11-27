FROM node:26.13.1-bookworm-slim AS build

WORKDIR /workspace

RUN npm install --global pnpm@10.15.0
COPY . .
RUN --mount=type=cache,id=gugu2-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @gugu/webui --filter @gugu/scheduler --filter @gugu/database --filter @gugu/email --filter @gugu/core --filter gugu-web --frozen-lockfile \
    && pnpm --filter @gugu/fs build \
    && pnpm --filter @gugu/core build \
    && pnpm --filter gugu-web build \
    && pnpm --filter @gugu/webui build \
    && pnpm install --filter @gugu/webui --prod --frozen-lockfile

FROM node:26.13.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GUGU_WEBUI_HOST=0.0.0.0 \
    GUGU_WEBUI_PORT=9595
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/web-host/node_modules ./apps/web-host/node_modules
COPY --from=build --chown=node:node /workspace/packages/core/node_modules ./packages/core/node_modules
COPY --from=build --chown=node:node /workspace/packages/sandbox/node_modules ./packages/sandbox/node_modules
COPY --from=build --chown=node:node /workspace/apps/web-host/package.json ./apps/web-host/package.json
COPY --from=build --chown=node:node /workspace/apps/web-host/dist ./apps/web-host/dist
COPY --from=build --chown=node:node /workspace/packages/auth/package.json ./packages/auth/package.json
COPY --from=build --chown=node:node /workspace/packages/auth/dist ./packages/auth/dist
COPY --from=build --chown=node:node /workspace/packages/users/package.json ./packages/users/package.json
COPY --from=build --chown=node:node /workspace/packages/users/dist ./packages/users/dist
COPY --from=build --chown=node:node /workspace/packages/users/node_modules ./packages/users/node_modules
COPY --from=build --chown=node:node /workspace/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=build --chown=node:node /workspace/packages/scheduler/package.json ./packages/scheduler/package.json
COPY --from=build --chown=node:node /workspace/packages/scheduler/dist ./packages/scheduler/dist
COPY --from=build --chown=node:node /workspace/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /workspace/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /workspace/packages/core/resources/prompts ./packages/core/resources/prompts
COPY --from=build --chown=node:node /workspace/packages/database/node_modules ./packages/database/node_modules
COPY --from=build --chown=node:node /workspace/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=node:node /workspace/packages/database/dist ./packages/database/dist
COPY --from=build --chown=node:node /workspace/packages/sandbox/package.json ./packages/sandbox/package.json
COPY --from=build --chown=node:node /workspace/packages/sandbox/dist ./packages/sandbox/dist
COPY --from=build --chown=node:node /workspace/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=node:node /workspace/packages/gateway/dist ./packages/gateway/dist
COPY --from=build --chown=node:node /workspace/packages/email/package.json ./packages/email/package.json
COPY --from=build --chown=node:node /workspace/packages/email/dist ./packages/email/dist
COPY --from=build --chown=node:node /workspace/packages/email/node_modules ./packages/email/node_modules
COPY --from=build --chown=node:node /workspace/packages/search/package.json ./packages/search/package.json
COPY --from=build --chown=node:node /workspace/packages/search/dist ./packages/search/dist
COPY --from=build --chown=node:node /workspace/packages/gateway/node_modules ./packages/gateway/node_modules
COPY --from=build --chown=node:node /workspace/packages/fs/package.json ./packages/fs/package.json
COPY --from=build --chown=node:node /workspace/packages/fs/dist ./packages/fs/dist
COPY --from=build --chown=node:node /workspace/packages/log/ ./packages/log/
COPY --from=build --chown=node:node /workspace/packages/loopscope/ ./packages/loopscope/
COPY --from=build --chown=node:node /workspace/apps/ui/dist ./apps/ui/dist
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 9595
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9595/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/web-host/dist/main.js"]
