# syntax=docker/dockerfile:1
# 默认 Compose 一体化应用镜像：前端 dist + 后端生产运行时，由统一应用服务提供站点。
# 与 backend/Dockerfile.prod、frontend/Dockerfile.prod（供生产分离 Compose 使用）并存；
# 构建上下文 = 仓库根目录。
#
# 产物只含生产运行时：不含前端源码、前端 node_modules、pnpm 缓存、测试代码与 docs/；
# 仅保留 TS RAG worker 所需的 Linux x64 native node_modules。
# 平台：linux/amd64（多架构暂不支持，见 PRD-DEPLOY-1）。

# ── Stage 1：前端构建 ────────────────────────────────────────────────────────
FROM node:22-trixie AS frontend-build

WORKDIR /workspace

RUN npm install --global pnpm@latest

# 依赖单独一层：workspace 元数据和 manifest 未变时改代码不重装；
# pnpm store 走 cache mount，lockfile 变更时只下载增量。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY frontend/package.json ./frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --filter gugu-web --frozen-lockfile

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
FROM python:3.14-slim-trixie AS backend-deps

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
WORKDIR /build

# apt 下载走 cache mount：索引每轮照拉、包照装（安全语义不变），
# 只复用未变更版本的 .deb 下载；docker-clean 会装完即删归档，先移除。
# lists 留在 cache mount 里不进镜像层，无需再手工清理。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libffi-dev libpq-dev libssl-dev

COPY backend/requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /opt/venv \
    && /opt/venv/bin/pip install -i "${PIP_INDEX_URL}" -r requirements.txt \
    && /opt/venv/bin/pip install --upgrade --force-reinstall \
        -i "${PIP_INDEX_URL}" \
        "msgpack==1.2.2" "setuptools==84.0.0" \
    && /opt/venv/bin/python -c "from importlib.metadata import version; assert version('msgpack') == '1.2.2'; assert version('setuptools') == '84.0.0'"

# ── Stage 3：后端生产运行时 + 前端静态产物 ──────────────────────────────────
# 钉住明确版本；sandbox-bootstrap/sandboxd 仍需要 Docker CLI，应用服务本身不挂载 Docker socket。
FROM python:3.14-slim-trixie

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
ARG GUGU_VERSION=unknown
ARG GUGU_REVISION=unknown

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        nginx poppler-utils fonts-noto-cjk ffmpeg curl docker-cli nodejs acl

# CVE-2026-18297（gstreamer-plugins-base OGG 任意代码执行，HIGH）安全门补丁，
# 与 backend/Dockerfile.prod 同款：libgstreamer-plugins-base1.0-0 是 ffmpeg 的传递
# 依赖，基础镜像携带旧版；直接从 security pool 拉修复版 .deb 安装，不依赖镜像源
# 索引新鲜度。基础镜像自带版本 >= 修复版后即可删除本段。
ARG GSTREAMER_BASE_FIXED_DEB=libgstreamer-plugins-base1.0-0_1.26.2-1+deb13u2
# TARGETARCH 是 BuildKit 预定义 ARG，stage 内必须显式声明才能引用，否则展开为空串
ARG TARGETARCH
RUN sed -i \
        -e "s|${APT_MIRROR}/debian-security|https://deb.debian.org/debian-security|g" \
        -e "s|${APT_MIRROR}/debian|https://deb.debian.org/debian|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && curl -fsSL -o /tmp/gst-base.deb \
        "https://deb.debian.org/debian-security/pool/updates/main/g/gst-plugins-base1.0/${GSTREAMER_BASE_FIXED_DEB}_${TARGETARCH}.deb" \
    && apt-get install -y --no-install-recommends /tmp/gst-base.deb \
    && rm -f /tmp/gst-base.deb

# 基础包安全补丁升级，与 backend/Dockerfile.prod 同款：APT_MIRROR（TUNA）对
# trixie-security 同步滞后，gzip/glib/mbedtls/pcre2/python3.13/sqlite3/libssh2/perl
# 会停在带 CVE 的旧版（2026-09-12 docker-release trivy 门失败根因）。逐包追 deb
# 是无底洞，切回官方 security pool 做整段 upgrade 自动覆盖后续 CVE；
# 镜像源同步追平后可移除本段。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i \
        -e "s|${APT_MIRROR}/debian-security|https://deb.debian.org/debian-security|g" \
        -e "s|${APT_MIRROR}/debian|https://deb.debian.org/debian|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y

WORKDIR /app

ENV PATH=/opt/venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
LABEL org.opencontainers.image.version="${GUGU_VERSION}" \
    org.opencontainers.image.revision="${GUGU_REVISION}"
COPY --from=backend-deps /opt/venv /opt/venv

# 只复制运行时所需的后端模块和迁移文件，明确排除 tests/、test_*.py、docs/ 等。
COPY backend/app ./app
COPY backend/updater ./updater
COPY backend/agent ./agent
COPY backend/onboarding ./onboarding
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
COPY backend/worker.py ./worker.py
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
COPY backend/compose_bootstrap.py ./compose_bootstrap.py
COPY backend/scripts/sandbox_rootless_init.sh /usr/local/bin/gugu-sandbox-init.sh
COPY backend/scripts/prepare_rootless_storage.py /usr/local/bin/prepare_rootless_storage.py
COPY squid/egress.conf /opt/gugu/egress.conf
RUN mkdir -p ./bin
COPY backend/bin/gugu-rag-ts-worker.mjs ./bin/gugu-rag-ts-worker.mjs
COPY backend/bin/gugu-filesync-ts-worker.cjs ./bin/gugu-filesync-ts-worker.cjs
COPY --from=rag-runtime /rag/node_modules ./bin/node_modules
RUN node bin/gugu-rag-ts-worker.mjs --version
RUN node bin/gugu-filesync-ts-worker.cjs --version

# ── 自更新工具链（执行器并入 app 进程，PRD-ADMIN-2 §1.1）───────────────────
# 签名校验随定位修订移除，仅保留 compose 插件供更新流程重建容器。
# v5.5.1：内嵌 containerd v2.3.4 / docker-cli v29.7.2 均高于 trivy 门要求的修复版
# （v2.39.2 因此被扫出 57 个 HIGH/CRITICAL，2026-09-16 docker-release 失败根因）。
# updater 资产（固定更新脚本/manifest 校验器/schema）落到 /opt/gugu-updater。
ARG DOCKER_COMPOSE_VERSION=v5.5.1
# TARGETARCH 是 BuildKit 预定义 ARG，stage 内必须显式声明才能引用，否则展开为空串（URL 404）
ARG TARGETARCH
# compose 发布资源用 uname 风格命名（x86_64/aarch64），与 TARGETARCH（amd64/arm64）不同名
RUN mkdir -p /usr/local/libexec/docker/cli-plugins /opt/gugu-updater/scripts/release /opt/gugu-updater/deploy \
    && compose_arch="$(case "${TARGETARCH}" in amd64) echo x86_64 ;; arm64) echo aarch64 ;; *) echo "${TARGETARCH}" ;; esac)" \
    && curl -fsSL -o /usr/local/libexec/docker/cli-plugins/docker-compose \
        "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
    && chmod 0755 /usr/local/libexec/docker/cli-plugins/docker-compose \
    && docker compose version
COPY scripts/release/compose-update.sh /opt/gugu-updater/scripts/release/compose-update.sh
COPY scripts/release/validate-update-manifest.mjs /opt/gugu-updater/scripts/release/validate-update-manifest.mjs
COPY deploy/update-manifest.schema.json /opt/gugu-updater/deploy/update-manifest.schema.json
RUN chmod 0755 /opt/gugu-updater/scripts/release/compose-update.sh
RUN cd /app && python3 -c "import updater.daemon, updater.client"

# 前端静态产物：由 Nginx 直接托管，API/SSE/WebSocket 反代到容器内 Uvicorn。
COPY --from=frontend-build /workspace/frontend/dist ./static/
COPY nginx/compose.conf /etc/nginx/nginx.conf
RUN mkdir -p logs \
    && find ./static -type d -exec chmod 755 {} + \
    && find ./static -type f -exec chmod 644 {} + \
    && chmod 755 docker-entrypoint.sh compose_bootstrap.py /usr/local/bin/gugu-sandbox-init.sh /usr/local/bin/prepare_rootless_storage.py \
    && test ! -e /app/.venv \
    && test ! -e /app/ts \
    && test ! -e /app/tests \
    && test ! -e /app/docs \
    && test ! -e /app/node_modules \
    && ! command -v gcc \
    && ! command -v g++ \
    && ! command -v make \
    && ! command -v git \
    && ! command -v hg

EXPOSE 9595

# 默认 Compose 使用一体化应用镜像；前端、Nginx、Uvicorn、worker 与 IM gateway
# 由同一个应用服务提供，PostgreSQL / Redis / SearXNG 由 Compose 中的独立服务提供。
# 镜像声明应用变量，便于部署面板识别；SECRET_KEY 留空时由入口首次启动生成，
# DB__PASSWORD 由 Compose 注入。入口端口统一 9595：Nginx 在容器内监听 9595，
# Uvicorn 藏在 127.0.0.1:8001 后面（GUGU_APP_PORT），对外只有 9595 一个入口。
ENV DB__HOST=postgres \
    DB__PORT=5432 \
    DB__NAME=gugu \
    DB__USER=gugu \
    DB__PASSWORD="" \
    REDIS__HOST=redis \
    REDIS__PORT=6379 \
    SECRET_KEY="" \
    GUGU_DB_PASSWORD="" \
    ADMIN_USERNAME=admin \
    # 不写死默认密码：随镜像公开的默认口令会压过用户在 env 文件配置的强密码
    # （process env 优先级高于 dotenv）。留空 = 首次启动自动生成随机密码写入
    # 持久化 env 文件并打印一次，公网部署用户显式覆盖即可。
    ADMIN_PASSWORD="" \
    GUGU_UNIFIED_APP=1 \
    GUGU_APP_PORT=8001 \
    GUGU_ENABLE_WORKER=1 \
    GUGU_ENABLE_GATEWAY=1 \
    GUGU_DATA_DIR=/data \
    # 首启自动生成的 SECRET_KEY/ADMIN_PASSWORD 写到这里，随 /data 卷持久化。
    GUGU_ENV_FILE=/data/.env \
    STORAGE__LOCAL_PATH=/data/users \
    CREDENTIALS_MASTER_KEY_FILE=/data/byok/.byok-master-key \
    GUGU_CONFIG_OVERRIDE_FILE=/config/config.override.json \
    GUGU_SANDBOXD_SOCKET=/run/gugu/sandboxd.sock

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -sf http://127.0.0.1:9595/health || exit 1

# 复用与 Dockerfile.prod 相同的入口：等数据库就绪 → 迁移 → 执行传入命令。
# 默认 Compose 的 nginx 命令会由入口同时托管 Uvicorn、消息 worker 与 IM gateway；sandboxd
# 服务显式清空入口。
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
