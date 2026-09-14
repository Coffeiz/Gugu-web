# 受限 Docker Compose 更新器。Docker Socket 只挂载到这个 sidecar，业务 app 不持有它。
# 与发布管线固定为 Cosign v3.1.3：支持 OCI 1.1 referrer 签名和新 bundle，且
# 避免构建签名端与 updater 验签端因浮动版本产生格式或行为差异。
FROM ghcr.io/sigstore/cosign/cosign:v3.1.3 AS cosign-bin

FROM docker:cli

# base 包补丁到最新，压掉 alpine 残留 HIGH（trivy 门 --ignore-unfixed 仍会拦已修复项）
RUN apk upgrade --no-cache \
    && apk add --no-cache bash python3 nodejs \
    && mkdir -p /opt/gugu-updater /var/lib/gugu-updater /run/gugu-updater \
    # updater 只做拉取/重启/验签，不构建镜像；buildx 插件是基础镜像被动带入的，
    # 删除以缩小扫描面与攻击面（compose 插件保留，更新流程依赖 docker compose）。
    && rm -f /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /opt/gugu-updater
COPY --from=cosign-bin /ko-app/cosign /usr/local/bin/cosign
COPY backend/updater ./updater
COPY scripts/release/compose-update.sh ./scripts/release/compose-update.sh
COPY scripts/release/validate-update-manifest.mjs ./scripts/release/validate-update-manifest.mjs
COPY deploy/update-manifest.schema.json ./deploy/update-manifest.schema.json

RUN chmod 755 /opt/gugu-updater/scripts/release/compose-update.sh \
    && python3 -c 'import updater.daemon' \
    && node --version \
    && docker compose version \
    && cosign version

ENV PYTHONUNBUFFERED=1 \
    GUGU_UPDATER_CODE_DIR=/opt/gugu-updater \
    GUGU_UPDATER_STATE_DIR=/var/lib/gugu-updater \
    GUGU_UPDATER_SOCKET=/run/gugu-updater/control.sock

CMD ["python3", "-m", "updater.daemon"]
