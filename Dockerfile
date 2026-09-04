# 默认 Compose 一体化镜像：前端 dist + 后端生产运行时，单镜像承载完整站点。
# 与 backend/Dockerfile.prod、frontend/Dockerfile.prod（供生产分离 Compose 使用）并存；
# 构建上下文 = 仓库根目录。
#
# 产物只含生产运行时：不含前端源码、前端 node_modules、pnpm 缓存、测试代码与 docs/；
# 仅保留 TS RAG worker 所需的 Linux x64 native node_modules。
# 平台：linux/amd64（多架构暂不支持，见 PRD-DEPLOY-1）。

# ── Stage 1：前端构建 ────────────────────────────────────────────────────────
FROM node:22-trixie AS frontend-build

WORKDIR /workspace

RUN npm install --global pnpm@10.15.0

# 依赖单独一层：workspace 元数据和 manifest 未变时改代码不重装。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --filter gugu-web --frozen-lockfile

COPY frontend/ ./frontend/
RUN cd frontend && pnpm build

# ── Stage 1.5：TS RAG worker 的 Linux x64 原生运行时依赖 ─────────────────────
# worker 构建时将 @node-rs/jieba 设为 external；默认镜像固定发布 linux/amd64，
# 因此必须把对应 N-API 包随制品带入最终镜像，不能只复制 .mjs。
FROM node:22-trixie AS rag-runtime

WORKDIR /rag

COPY backend/ts/workers/rag/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-fund --no-audit \
        @node-rs/jieba@2.0.1 \
        @node-rs/jieba-linux-x64-gnu@2.0.1 \
    && node -e "import('@node-rs/jieba').then(() => console.log('RAG Jieba runtime ready'))"

# ── Stage 2：后端依赖构建（venv 与最终镜像分离） ─────────────────────────────
FROM python:3.14-trixie AS backend-deps

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
WORKDIR /build

COPY backend/requirements.txt ./requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -i "${PIP_INDEX_URL}" -r requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade --force-reinstall \
        -i "${PIP_INDEX_URL}" \
        "msgpack==1.2.2" "setuptools==84.0.0" \
    && /opt/venv/bin/python -c "from importlib.metadata import version; assert version('msgpack') == '1.2.2'; assert version('setuptools') == '84.0.0'"

# ── Stage 3：后端生产运行时 + 前端静态产物 ──────────────────────────────────
# 钉住明确版本，理由同 Dockerfile.prod：trixie 才有 docker-cli（沙盒兄弟容器需要）。
FROM python:3.14-trixie

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
# 是否安装 LibreOffice（doc/docx/ppt 转 PDF 预览）。体积大（500MB+），
# 不需要文档预览时可传 --build-arg GUGU_INSTALL_LIBREOFFICE=false 关闭。
ARG GUGU_INSTALL_LIBREOFFICE=true

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        nginx poppler-utils fonts-noto-cjk ffmpeg curl docker-cli nodejs \
        $(if [ "${GUGU_INSTALL_LIBREOFFICE}" = "true" ]; then echo libreoffice libreoffice-writer fonts-noto-cjk; fi) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PATH=/opt/venv/bin:${PATH}
COPY --from=backend-deps /opt/venv /opt/venv

# 只复制运行时所需的后端模块和迁移文件，明确排除 tests/、test_*.py、docs/ 等。
COPY backend/app ./app
COPY backend/agent ./agent
COPY backend/onboarding ./onboarding
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
COPY backend/worker.py ./worker.py
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
COPY backend/compose_bootstrap.py ./compose_bootstrap.py
COPY backend/scripts/sandbox_rootless_init.sh /usr/local/bin/gugu-sandbox-init.sh
COPY squid/egress.conf /opt/gugu/egress.conf
RUN mkdir -p ./bin
COPY backend/bin/gugu-rag-ts-worker.mjs ./bin/gugu-rag-ts-worker.mjs
COPY --from=rag-runtime /rag/node_modules ./bin/node_modules
RUN node bin/gugu-rag-ts-worker.mjs --version
# 前端静态产物：由 Nginx 直接托管，API/SSE/WebSocket 反代到容器内 Uvicorn。
COPY --from=frontend-build /workspace/frontend/dist ./static/
COPY nginx/compose.conf /etc/nginx/nginx.conf
RUN mkdir -p logs \
    && find ./static -type d -exec chmod 755 {} + \
    && find ./static -type f -exec chmod 644 {} + \
    && chmod 755 docker-entrypoint.sh compose_bootstrap.py /usr/local/bin/gugu-sandbox-init.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://127.0.0.1:8000/health || exit 1

# 复用与 Dockerfile.prod 相同的入口：等数据库就绪 → 迁移 → 执行传入命令。
# 默认 Compose 的 nginx 命令会由入口同时托管 Uvicorn、消息 worker 与 IM gateway；sandboxd
# 服务显式清空入口。
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
