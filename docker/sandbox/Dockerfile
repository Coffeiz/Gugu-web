# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

# 所有用户 PTY、咕咕 Shell 和后台 Shell 共用的运行时镜像。
# 工具在构建阶段一次性安装，运行时不联网、不使用 apt，也不以 root 运行。
# CI（海外 runner）构建时以 build-arg APT_MIRROR=http://deb.debian.org 覆盖默认
# 国内镜像。镜像源必须用 http://：bookworm-slim 容器内尚无 ca-certificates
#（它就在待安装清单里），https 握手会因证书不可信失败；apt 以 GPG 签名
# 校验完整性，明文镜像源是 Debian 官方认可的用法。
ARG APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/ \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# apt 下载走 cache mount：镜像构建仍禁用层缓存（upgrade 必须每轮真跑，
# 防 trivy 假红），cache mount 只复用未变更版本的 .deb 下载，安全语义不变。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i \
       -e "s|https\?://deb.debian.org/debian|${APT_MIRROR}/debian|g" \
       -e "s|https\?://security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" \
       /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y \
       bash ca-certificates curl ffmpeg fontconfig fonts-noto-cjk git jq less libssh2-1 nodejs npm \
       python-is-python3 python3 python3-matplotlib python3-pil python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f \
    && groupadd --gid 65532 sandbox \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir / --shell /bin/bash sandbox

# 根文件系统运行时只读；字体探测产生的用户缓存必须落在执行器提供的 /tmp tmpfs。
ENV XDG_CACHE_HOME=/tmp/.cache

USER 65532:65532
WORKDIR /
CMD ["bash", "--noprofile", "--norc"]
