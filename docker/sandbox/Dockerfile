FROM debian:bookworm-slim

# 所有用户 PTY、咕咕 Shell 和后台 Shell 共用的运行时镜像。
# 工具在构建阶段一次性安装，运行时不联网、不使用 apt，也不以 root 运行。
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/ \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN sed -i \
       -e 's|deb.debian.org/debian|mirrors.tuna.tsinghua.edu.cn/debian|g' \
       -e 's|security.debian.org/debian-security|mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
       /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y \
       bash ca-certificates curl ffmpeg git jq less nodejs npm python-is-python3 python3 python3-pip python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
    && groupadd --gid 65532 sandbox \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir / --shell /bin/bash sandbox

USER 65532:65532
WORKDIR /
CMD ["bash", "--noprofile", "--norc"]
