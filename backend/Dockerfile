# syntax=docker/dockerfile:1
## 咕咕后端镜像 —— 本地/本机开发用的快速启动方式，不是生产部署方式。
## 生产环境用的是裸机 systemd 三服务（gugu-backend / gugu-worker / gugu-supervisor，
## 见 start.sh install），原因是 IM 网关（飞书/QQ/微信）常驻长连接 + 语音/文档转码要调
## libreoffice/ffmpeg 等系统工具，装进容器体积和运维复杂度都不划算；这个镜像只覆盖
## web（uvicorn）和 worker（IM 队列消费）两个进程，够本地跑通全栈、验证功能。
FROM python:3.12-slim

# poppler-utils → pdftotext（文件预览正文提取）；fonts-noto-cjk → LibreOffice 中文 PDF 字形；
# ffmpeg → IM 语音消息转码；curl → HEALTHCHECK
# 用；build-essential → pilk（SILK 语音编解码）在 PyPI 只发布了 Windows 预编译 wheel，Linux 下
# 装它一定要从源码编译内嵌的 C 语言 SILK 编解码库，slim 镜像默认没有编译工具链
# （2026-07-14 排查：先只装 gcc 报 `command 'gcc' failed: No such file or directory`；
# 补上 gcc 后又报 `fatal error: stdint.h: No such file or directory`——gcc 本身有了，但
# libc6-dev 这个提供标准库头文件的包没装，gcc 找不到 stdint.h 之类基础头。改用
# build-essential 一次性带全 gcc/g++/make/libc6-dev/dpkg-dev，避免这类工具链缺件继续
# 一个一个探）。libreoffice（doc/docx/ppt 转 PDF 预览）体积很大（500MB+），默认不装——
# 需要这项功能就在这个镜像基础上自己叠一层 `apt-get install libreoffice`。
# --mount=type=cache 让 apt 下载缓存跨构建持久化（不进最终镜像层，只是构建时的缓存卷）——
# ffmpeg 在 Debian trixie 下会拉一整条音视频编解码库依赖链（100+ 包），每次 Dockerfile 这行
# 之前有改动都要重新全量下载，缓存后只需下一次。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils fonts-noto-cjk ffmpeg curl build-essential docker.io nodejs

WORKDIR /app

# 依赖单独一层：requirements.txt 没变时，改代码不用重装依赖，重建镜像快得多。
# pip 缓存改用 BuildKit 缓存挂载（而非 --no-cache-dir）：--no-cache-dir 会让 pip 每次都无视
# 本地缓存、从 PyPI 重新下载+编译全部依赖，缓存挂载把已下载/编译好的 wheel 持久化在构建缓存卷里
# （不进最终镜像层，体积不受影响），requirements.txt 没变时下次构建这层直接跳过、变了也只需
# 下载/编译真正变化的包。
#
# PIP_INDEX_URL 可换源：本仓库要发 GitHub 给各地的人自己 `docker build` 部署，直连 PyPI 官方源
# 在有的网络环境下会很慢甚至读超时（2026-07-14 实测某国内网络 ~10KB/s，装 langchain 这种依赖树
# 巨大的包能拖到 25+ 分钟甚至失败；换清华 TUNA 镜像后同一个包 <1s 跑满带宽）——但这是网络环境
# 差异，不是所有部署者都会遇到，写死镜像源对官方源本就够快的用户反而更慢/不必要地依赖第三方源。
# 默认走官方源，网络不佳时按需覆盖：
#   docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple ./backend
# 或用 docker-compose.yml 里同名 build arg（读同名环境变量，见其注释）。
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -i "${PIP_INDEX_URL}" -r requirements.txt

COPY . .
RUN mkdir -p logs

# 不像 systemd 单元那样切非 root 用户跑（那份加固对生产才有意义）——这个镜像的
# docker-compose.yml 用法会把 ./backend 整个 bind mount 进 /app，运行时的文件属主
# 由宿主机那份说了算，容器里镜像构建阶段 chown 的结果会被挂载直接盖掉，非 root 用户
# 反而可能在宿主机 UID 对不上时写不进 logs（各操作系统 Docker 的 UID 映射
# 行为不一致，尤其是 macOS/Windows Docker Desktop）。本镜像仅用于本地开发，不担心这层。
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://127.0.0.1:8000/health || exit 1

# 入口脚本先跑 alembic upgrade head 再拉起主进程——docker-compose.yml 的 worker 服务
# 复用同一个镜像，靠 command 覆盖成 `python -m worker`，入口脚本对两者都适用（迁移只需
# 跑一次，重复跑是幂等的，两个服务谁先起都不会漏迁移）。--reload 配合 compose 的源码
# bind mount：改了宿主机上的代码，容器内 uvicorn 自动重启，不用手动重建镜像。
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
