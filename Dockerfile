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
FROM python:3.14-slim-trixie AS backend-deps

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
WORKDIR /build

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential libffi-dev libpq-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -i "${PIP_INDEX_URL}" -r requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade --force-reinstall \
        -i "${PIP_INDEX_URL}" \
        "msgpack==1.2.2" "setuptools==84.0.0" \
    && /opt/venv/bin/python -c "from importlib.metadata import version; assert version('msgpack') == '1.2.2'; assert version('setuptools') == '84.0.0'"

# ── Stage 3：后端生产运行时 + 前端静态产物 ──────────────────────────────────
# 钉住明确版本；sandbox-bootstrap/sandboxd 仍需要 Docker CLI，应用服务本身不挂载 Docker socket。
FROM python:3.14-slim-trixie

ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
# 是否安装 LibreOffice（doc/docx/ppt 转 PDF 预览）。体积大（500MB+），
# 不需要文档预览时可传 --build-arg GUGU_INSTALL_LIBREOFFICE=false 关闭。
ARG GUGU_INSTALL_LIBREOFFICE=true

RUN sed -i \
        -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
        -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        nginx poppler-utils fonts-noto-cjk ffmpeg curl docker-cli nodejs acl \
        # 内置依赖（GUGU_EMBEDDED_DEPS=1 时由入口拉起）：单容器一键部署无需外部
        # postgres/redis。仅监听 127.0.0.1，数据在 /data/postgres、/data/redis。
        postgresql redis-server supervisor \
        $(if [ "${GUGU_INSTALL_LIBREOFFICE}" = "true" ]; then echo libreoffice libreoffice-writer fonts-noto-cjk; fi) \
    # snakeoil 是 ssl-cert 包（postgresql 依赖）装的 Debian 全机通用示例证书，随层公开
    # 会被 trivy secrets 扫描判为私钥泄漏；内嵌 PostgreSQL 只监听 127.0.0.1 且 ssl=off
    # （见 docker-entrypoint.sh），用不到它，直接删。
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PATH=/opt/venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
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
COPY backend/scripts/migrate_storage_root.py ./scripts/migrate_storage_root.py
COPY backend/scripts/sandbox_rootless_init.sh /usr/local/bin/gugu-sandbox-init.sh
COPY backend/scripts/prepare_rootless_storage.py /usr/local/bin/prepare_rootless_storage.py
COPY squid/egress.conf /opt/gugu/egress.conf
RUN mkdir -p ./bin
COPY backend/bin/gugu-rag-ts-worker.mjs ./bin/gugu-rag-ts-worker.mjs
COPY backend/bin/gugu-filesync-ts-worker.cjs ./bin/gugu-filesync-ts-worker.cjs
COPY --from=rag-runtime /rag/node_modules ./bin/node_modules
RUN node bin/gugu-rag-ts-worker.mjs --version
RUN node bin/gugu-filesync-ts-worker.cjs --version
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

# 一键部署面板（fnOS / 群晖 / Portainer 等）从镜像 ENV 枚举「可填变量」——业务默认值
# 必须在这里声明，否则面板只露出 Python 自带的 PATH/PYTHON_*，用户根本不知道要填
# 数据库。默认值与 docker-compose.yml 注入的值保持一致；SECRET_KEY 留空时由入口首次
# 启动生成并写入持久化 env 文件，DB__PASSWORD 由面板或 backend/.env 填写。入口端口统一 9595：Nginx 在容器内监听 9595，
# Uvicorn 藏在 127.0.0.1:8001 后面（GUGU_APP_PORT），对外只有 9595 一个入口。
#
# 单容器完整启动契约也在这里默认成立（裸 docker run = 完整应用）：
#   GUGU_SINGLE_CONTAINER=1  入口同时托管 Uvicorn/worker/IM gateway/Nginx；
#   持久化路径收口 /data 与 /config 两个卷（STORAGE__LOCAL_PATH、BYOK 主密钥、
#   Admin 配置覆盖文件、sandboxd socket），删容器重建数据不丢。
# Compose 部署显式注入同名变量（含 GUGU_EMBEDDED_DEPS=0 走外部服务），互不影响。
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
    GUGU_SINGLE_CONTAINER=1 \
    GUGU_APP_PORT=8001 \
    GUGU_ENABLE_WORKER=1 \
    GUGU_ENABLE_GATEWAY=1 \
    GUGU_DATA_DIR=/data \
    # 首启自动生成的 SECRET_KEY/ADMIN_PASSWORD 写到这里，随 /data 卷持久化。
    GUGU_ENV_FILE=/data/.env \
    STORAGE__LOCAL_PATH=/data/users \
    CREDENTIALS_MASTER_KEY_FILE=/data/byok/.byok-master-key \
    GUGU_CONFIG_OVERRIDE_FILE=/config/config.override.json \
    GUGU_SANDBOXD_SOCKET=/run/gugu/sandboxd.sock \
    # 默认内置 postgres/redis（单容器一键部署开箱即用）；Compose 部署显式置 0 走外部服务。
    GUGU_EMBEDDED_DEPS=1

# 未显式绑定宿主目录时，让 Docker 自动创建匿名持久卷；显式 bind mount 仍优先。
VOLUME ["/data", "/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -sf http://127.0.0.1:9595/health || exit 1

# 复用与 Dockerfile.prod 相同的入口：等数据库就绪 → 迁移 → 执行传入命令。
# 默认 Compose 的 nginx 命令会由入口同时托管 Uvicorn、消息 worker 与 IM gateway；sandboxd
# 服务显式清空入口。
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
