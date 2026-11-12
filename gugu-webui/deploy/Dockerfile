FROM node:26.13.1-bookworm-slim AS build

WORKDIR /workspace

RUN npm install --global pnpm@10.15.0
COPY . .
RUN pnpm install --filter @gugu/webui --filter @gugu/core --frozen-lockfile \
    && pnpm --filter @gugu/core build \
    && pnpm --filter @gugu/webui build \
    && pnpm install --filter @gugu/webui --prod --frozen-lockfile

FROM node:26.13.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GUGU_WEBUI_HOST=0.0.0.0 \
    GUGU_WEBUI_PORT=9595
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/gugu-webui/node_modules ./gugu-webui/node_modules
COPY --from=build --chown=node:node /workspace/gugu-core/node_modules ./gugu-core/node_modules
COPY --from=build --chown=node:node /workspace/gugu-webui/package.json ./gugu-webui/package.json
COPY --from=build --chown=node:node /workspace/gugu-webui/dist ./gugu-webui/dist
COPY --from=build --chown=node:node /workspace/gugu-core/package.json ./gugu-core/package.json
COPY --from=build --chown=node:node /workspace/gugu-core/dist ./gugu-core/dist

USER node
EXPOSE 9595
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9595/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "gugu-webui/dist/main.js"]
