FROM node:26.13.1-bookworm-slim AS build

WORKDIR /workspace

RUN npm install --global pnpm@10.15.0
COPY . .
RUN --mount=type=cache,id=gugu2-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter @gugu/webui --filter @gugu/core --filter gugu-web --frozen-lockfile \
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
COPY --from=build --chown=node:node /workspace/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /workspace/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /workspace/packages/sandbox/package.json ./packages/sandbox/package.json
COPY --from=build --chown=node:node /workspace/packages/sandbox/dist ./packages/sandbox/dist
COPY --from=build --chown=node:node /workspace/packages/fs/package.json ./packages/fs/package.json
COPY --from=build --chown=node:node /workspace/packages/fs/dist ./packages/fs/dist
COPY --from=build --chown=node:node /workspace/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /workspace/backend/onboarding/assets ./backend/onboarding/assets
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 9595
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9595/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/web-host/dist/main.js"]
