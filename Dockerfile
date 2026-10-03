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

RUN npm install --global pnpm@10.15.0

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

# ── Stage 2.5：从固定上游源码构建修复版 Cosign ───────────────────────────────
# Cosign v3.1.3 官方镜像内的 Go 依赖已被 Trivy 标记为高危漏洞。
# 保持官方签名版本与固定源码提交，只更新已修复的 Go 依赖并使用修复版工具链。
FROM golang:1.26.6-trixie AS cosign-build

WORKDIR /src

ADD --checksum=sha256:3a718446bac51466efff6853639e1ca108b456ecbf07cd92938f548715d22d6b \
    https://github.com/sigstore/cosign/archive/11926fa5bbbbde47e88fc006b625a17769b743b2.tar.gz \
    /tmp/cosign.tar.gz

RUN mkdir -p /out \
    && tar -xzf /tmp/cosign.tar.gz --strip-components=1 -C /src \
    && rm /tmp/cosign.tar.gz \
    && go mod edit \
        -require=golang.org/x/crypto@v0.55.0 \
        -require=golang.org/x/mod@v0.40.0 \
        -require=golang.org/x/text@v0.39.0 \
        -require=google.golang.org/grpc@v1.83.1 \
    && go mod tidy \
    && go mod verify \
    && CGO_ENABLED=0 go build -trimpath \
        -ldflags="-buildid= -X sigs.k8s.io/release-utils/version.gitVersion=v3.1.3 -X sigs.k8s.io/release-utils/version.gitCommit=11926fa5bbbbde47e88fc006b625a17769b743b2 -X sigs.k8s.io/release-utils/version.gitTreeState=clean -X sigs.k8s.io/release-utils/version.buildDate=2026-08-06T00:10:15Z" \
        -o /out/cosign ./cmd/cosign \
    && /out/cosign version

# ── Stage 3：后端生产运行时 + 前端静态产物 ──────────────────────────────────
# Docker CLI 供受控更新器和显式启用的内嵌 sandbox manager 使用。
FROM python:3.14-slim-trixie

# 应用包更新需要容器内独立验签；只把固定上游提交构建的 Cosign CLI 复制进运行镜像，不带 Docker socket。
COPY --from=cosign-build /out/cosign /usr/local/bin/cosign

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        nginx poppler-utils fonts-noto-cjk ffmpeg curl docker.io docker-cli nodejs acl \
        rootlesskit slirp4netns fuse-overlayfs uidmap iproute2 iptables \
        postgresql redis-server supervisor \
    # snakeoil 是 ssl-cert 包（postgresql 依赖）装的 Debian 全机通用示例证书，随层公开
    # 会被 trivy secrets 扫描判为私钥泄漏；内嵌 PostgreSQL 只监听 127.0.0.1 且 ssl=off
    # （见 docker-entrypoint.sh），用不到它，直接删。
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem

# CVE-2026-18297（gstreamer-plugins-base OGG 任意代码执行，HIGH）安全门补丁，
# 与 backend/Dockerfile.prod 同款：libgstreamer-plugins-base1.0-0 是 ffmpeg 的传递
# 依赖，基础镜像携带旧版；直接从 security pool 拉修复版 .deb 安装，不依赖镜像源
# 索引新鲜度。基础镜像自带版本 >= 修复版后即可删除本段。
ARG GSTREAMER_BASE_FIXED_DEB=libgstreamer-plugins-base1.0-0_1.26.2-1+deb13u2
# TARGETARCH 是 BuildKit 预定义 ARG，stage 内必须显式声明才能引用，否则展开为空串
ARG TARGETARCH
ARG HTTPS_PROXY
RUN if [ -n "${HTTPS_PROXY:-}" ]; then export http_proxy="${HTTPS_PROXY}" https_proxy="${HTTPS_PROXY}"; fi; \
    sed -i \
        -e "s|${APT_MIRROR}/debian-security|https://deb.debian.org/debian-security|g" \
        -e "s|${APT_MIRROR}/debian|https://deb.debian.org/debian|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && if [ -n "${HTTPS_PROXY:-}" ]; then \
        curl --proxy "${HTTPS_PROXY}" -fsSL -o /tmp/gst-base.deb \
            "https://deb.debian.org/debian-security/pool/updates/main/g/gst-plugins-base1.0/${GSTREAMER_BASE_FIXED_DEB}_${TARGETARCH}.deb"; \
    else \
        curl -fsSL -o /tmp/gst-base.deb \
            "https://deb.debian.org/debian-security/pool/updates/main/g/gst-plugins-base1.0/${GSTREAMER_BASE_FIXED_DEB}_${TARGETARCH}.deb"; \
    fi \
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
    && if [ -n "${HTTPS_PROXY:-}" ]; then export http_proxy="${HTTPS_PROXY}" https_proxy="${HTTPS_PROXY}"; fi \
    && sed -i \
        -e "s|${APT_MIRROR}/debian-security|https://deb.debian.org/debian-security|g" \
        -e "s|${APT_MIRROR}/debian|https://deb.debian.org/debian|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y

# 镜像应用代码固定放在独立路径；/app 在构建末尾创建为指向此目录的符号链接。
# 启动时不能把 OverlayFS 的 lower-layer 目录 rename 到别处（会返回 EXDEV）。
WORKDIR /opt/gugu/image-app

ENV PATH=/opt/venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY --from=backend-deps /opt/venv /opt/venv

# 只复制运行时所需的后端模块和迁移文件，明确排除 tests/、test_*.py、docs/ 等。
COPY backend/app ./app
COPY backend/updater ./updater
COPY backend/agent ./agent
COPY backend/onboarding ./onboarding
COPY backend/scripts/migrations ./scripts/migrations
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
COPY backend/worker.py ./worker.py
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
COPY backend/compose_bootstrap.py ./compose_bootstrap.py
COPY backend/scripts/runtime/sandbox_rootless_init.sh /usr/local/bin/gugu-sandbox-init.sh
COPY backend/scripts/runtime/sandbox_egress_init.sh /usr/local/bin/gugu-sandbox-egress-init.sh
COPY backend/scripts/runtime/start_embedded_sandbox_manager.sh /usr/local/bin/gugu-start-embedded-sandbox-manager.sh
COPY backend/scripts/runtime/dockerd-rootless.sh /usr/local/bin/dockerd-rootless.sh
COPY backend/scripts/runtime/prepare_rootless_storage.py /usr/local/bin/prepare_rootless_storage.py
COPY backend/scripts/runtime/ensure_embedded_pg_hba.py /usr/local/bin/ensure_embedded_pg_hba.py
COPY backend/scripts/runtime/wait_embedded_postgres.sh /usr/local/bin/gugu-wait-embedded-postgres.sh
COPY backend/scripts/runtime/wait_embedded_redis.sh /usr/local/bin/gugu-wait-embedded-redis.sh
RUN mkdir -p /opt/gugu \
    && cp /opt/gugu/image-app/updater/app_bundle_runtime.py /opt/gugu/app_bundle_runtime.py \
    && chmod 0555 /opt/gugu/app_bundle_runtime.py
COPY squid/egress.conf /opt/gugu/egress.conf
RUN chmod 0755 /usr/local/bin/gugu-sandbox-egress-init.sh /usr/local/bin/gugu-start-embedded-sandbox-manager.sh /usr/local/bin/dockerd-rootless.sh
RUN set -eux; \
    useradd --uid 1000 --user-group --create-home --home-dir /var/lib/gugu-rootless --shell /usr/sbin/nologin gugu-rootless; \
    grep -qxF 'gugu-rootless:100000:65536' /etc/subuid || printf '%s\n' 'gugu-rootless:100000:65536' >> /etc/subuid; \
    grep -qxF 'gugu-rootless:100000:65536' /etc/subgid || printf '%s\n' 'gugu-rootless:100000:65536' >> /etc/subgid; \
    mkdir -p /run/user/1000 /data/sandbox-rootless; \
    chown -R 1000:1000 /var/lib/gugu-rootless /run/user/1000 /data/sandbox-rootless; \
    chmod 0700 /run/user/1000
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
# 支持受限构建网络通过标准 Docker build proxy args 下载官方 Compose 插件。
ARG DOCKER_COMPOSE_VERSION=v5.5.1
# TARGETARCH 是 BuildKit 预定义 ARG，stage 内必须显式声明才能引用，否则展开为空串（URL 404）
ARG TARGETARCH
# compose 发布资源用 uname 风格命名（x86_64/aarch64），与 TARGETARCH（amd64/arm64）不同名
RUN mkdir -p /usr/local/libexec/docker/cli-plugins
RUN compose_arch="$(case "${TARGETARCH:-amd64}" in amd64) echo x86_64 ;; arm64) echo aarch64 ;; *) echo "不支持的 Docker Compose 架构: ${TARGETARCH}" >&2; exit 1 ;; esac)" \
    && compose_url="https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
    && if [ -n "${HTTPS_PROXY:-}" ]; then \
        curl --proxy "${HTTPS_PROXY}" -fsSL "$compose_url" -o /usr/local/libexec/docker/cli-plugins/docker-compose; \
    else \
        curl -fsSL "$compose_url" -o /usr/local/libexec/docker/cli-plugins/docker-compose; \
    fi \
    && chmod 0755 /usr/local/libexec/docker/cli-plugins/docker-compose \
    && docker compose version
RUN cd /opt/gugu/image-app && python3 -c "import updater.daemon, updater.client"

# 前端静态产物：由 Nginx 直接托管，API/SSE/WebSocket 反代到容器内 Uvicorn。
COPY --from=frontend-build /workspace/frontend/dist ./static/
COPY nginx/compose.conf /etc/nginx/nginx.conf
RUN mkdir -p logs \
    && GUGU_IMAGE_VERSION="$GUGU_VERSION" GUGU_RUNTIME_CONTRACT="$GUGU_APP_RUNTIME_CONTRACT" python3 -c 'import json, os; from pathlib import Path; Path(".gugu-app-release.json").write_text(json.dumps({"version": os.environ["GUGU_IMAGE_VERSION"], "runtime_contract": os.environ["GUGU_RUNTIME_CONTRACT"]}, separators=(",", ":")) + "\n", encoding="utf-8")' \
    && ln -s /opt/gugu/image-app /app \
    && find /opt/gugu/image-app -type f -name '._*' -delete \
    && find ./static -type d -exec chmod 755 {} + \
    && find ./static -type f -exec chmod 644 {} + \
    && chmod 755 docker-entrypoint.sh compose_bootstrap.py /usr/local/bin/gugu-sandbox-init.sh /usr/local/bin/prepare_rootless_storage.py /usr/local/bin/gugu-wait-embedded-postgres.sh /usr/local/bin/gugu-wait-embedded-redis.sh \
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
    GUGU_LOG_FILE=/data/logs/gugu.log \
    # 首启自动生成的 SECRET_KEY/ADMIN_PASSWORD 写到这里，随 /data 卷持久化。
    GUGU_ENV_FILE=/data/.env \
    STORAGE__LOCAL_PATH=/data/users \
    CREDENTIALS_MASTER_KEY_FILE=/data/byok/.byok-master-key \
    GUGU_CONFIG_OVERRIDE_FILE=/config/config.override.json \
    GUGU_SANDBOXD_SOCKET=/run/gugu/sandboxd.sock \
    GUGU_SANDBOX_MANAGER_MODE=embedded \
    SANDBOX__ROOTLESS_REQUIRED=true \
    SANDBOX__ENABLED=true \
    SANDBOX__EGRESS_ISOLATION_ENABLED=true \
    SANDBOX__EGRESS_PROXY_URL=http://egress-proxy:3128 \
    # 默认内置 postgres/redis（单容器一键部署开箱即用）；Compose 部署显式置 0 走外部服务。
    GUGU_EMBEDDED_DEPS=1

# 未显式绑定宿主目录时，让 Docker 自动创建匿名持久卷兜底；显式 bind mount 仍优先
# （fnOS 等面板务必绑定宿主机目录，匿名卷在面板重建容器后可能被回收，见部署文档）。
VOLUME ["/data", "/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -sf http://127.0.0.1:9595/health || exit 1

# 复用与 Dockerfile.prod 相同的入口：等数据库就绪 → 迁移 → 执行传入命令。
# 默认 Compose 的 nginx 命令会由入口同时托管 Uvicorn、消息 worker 与 IM gateway。
# 一体化镜像默认托管内部 Rootless Docker 与 embedded sandboxd；需要外层容器
# 以 privileged 模式运行，但不连接宿主 Docker Socket，也不回退到本机执行。
# 分体镜像使用独立 Dockerfile 与显式 external 配置。
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

# 版本号和提交 SHA 每次构建都会变化，只在最终镜像元数据中使用。
# 放在所有文件系统层之后，避免每次提交都使运行时依赖和应用文件层失效。
ARG GUGU_VERSION=unknown
ARG GUGU_REVISION=unknown
ARG GUGU_APP_RUNTIME_CONTRACT=1
ENV GUGU_IMAGE_VERSION=${GUGU_VERSION} \
    GUGU_APP_RUNTIME_CONTRACT=${GUGU_APP_RUNTIME_CONTRACT}
LABEL org.opencontainers.image.version="${GUGU_VERSION}" \
    org.opencontainers.image.revision="${GUGU_REVISION}"
