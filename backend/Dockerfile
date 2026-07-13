## 咕咕后端镜像 —— 本地/本机开发用的快速启动方式，不是生产部署方式。
## 生产环境用的是裸机 systemd 三服务（gugu-backend / gugu-worker / gugu-supervisor，
## 见 start.sh install），原因是 IM 网关（飞书/QQ/微信）常驻长连接 + 语音/文档转码要调
## libreoffice/ffmpeg 等系统工具，装进容器体积和运维复杂度都不划算；这个镜像只覆盖
## web（uvicorn）和 worker（IM 队列消费）两个进程，够本地跑通全栈、验证功能。
FROM python:3.12-slim

# poppler-utils → pdftotext（文件预览正文提取）；ffmpeg → IM 语音消息转码；
# curl → HEALTHCHECK 用。libreoffice（doc/docx/ppt 转 PDF 预览）体积很大（500MB+），
# 默认不装——需要这项功能就在这个镜像基础上自己叠一层 `apt-get install libreoffice`。
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖单独一层：requirements.txt 没变时，改代码不用重装依赖，重建镜像快得多。
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p uploads logs

# 不像 systemd 单元那样切非 root 用户跑（那份加固对生产才有意义）——这个镜像的
# docker-compose.yml 用法会把 ./backend 整个 bind mount 进 /app，运行时的文件属主
# 由宿主机那份说了算，容器里镜像构建阶段 chown 的结果会被挂载直接盖掉，非 root 用户
# 反而可能在宿主机 UID 对不上时写不进 uploads/logs（各操作系统 Docker 的 UID 映射
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
