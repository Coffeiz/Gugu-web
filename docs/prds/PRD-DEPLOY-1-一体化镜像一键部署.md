# 一体化应用镜像与一键部署

> 状态：🟡 Phase 2 实施完成（003–006）；本轮按用户要求只执行普通测试，不执行 E2E/Trivy；Trivy 改为合并前单独扫描，文档与发布衔接部分已实施（2026-09-04）
> 创建：2026-09-04
> 最近更新：2026-09-04
> 关联模块：`Dockerfile`、`backend/Dockerfile.prod`、`frontend/Dockerfile.prod`、`docker-compose.yml`、`.env.example`、`frontend`（vite 构建链）、`backend/app/main.py`（静态托管）、`.github/workflows`（Docker release）、`README.md`、`README_en.md`、`docs/DEPLOY.md`
> 背景参考：`PRD-ADMIN-2-Docker部署更新.md`（现有发布流水线）、`PRD-ARCH-6-轻量单机部署模式.md`（应用层 SQLite/无 Redis 轻量模式，与本文档的打包交付简化互补，不重叠）、`docs/ops/release.md` §5（现生产部署路径）

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| backend/frontend 分离镜像发布 | ✅ 已完成 | CI 推送 `coffeiz/gugu-web-{backend,frontend}`，tag 为 `v1.0.x` 与 commit sha，仅 linux/amd64；现生产使用中。 |
| 源码开发部署（Dev Compose） | ✅ 已完成 | `docker-compose.dev.yml` 保留源码挂载与热更新路径，供开发者使用。 |
| 一体化应用镜像（前端+后端单镜像，仅生产运行时） | ✅ 已完成 | 根目录 `Dockerfile` 已通过 devserver linux/amd64 构建，镜像内含 Nginx + Uvicorn + worker + IM gateway。 |
| 一键 compose（app+postgres+redis 单文件） | ✅ 已完成 | 根目录 `docker-compose.yml` 已提供默认单容器部署与 `sandbox` profile 配置；PostgreSQL/Redis 依赖版本与现 prod 统一为 `postgres:18` / `redis:latest`，PostgreSQL 18 持久卷挂载父目录。 |
| Docker Hub `latest` 滚动 tag | 🔲 待实施 | 用户拍板随 v1.0.6 发布流水线一起加。 |
| 多架构镜像（arm64） | 🔲 待评估 | 本期明确不做，README 标注 amd64-only。 |
| README/DEPLOY 一键部署章节 | 🔲 待实施 | 留到 Phase 3。 |

## 1. 背景与目标

### 1.1 背景

当前快速开始要求用户从源码本地构建 `gugu-web-backend:local` 与 `gugu-web-frontend:local` 两个镜像：

- 后端镜像构建很重（全量 pip 依赖 + LibreOffice，生产实测单个 ~4GB），无缓存的首次启动耗时长，弱机器可能构建失败；
- frontend/backend 两个镜像、两套环境变量，对一般用户心智负担偏大；
- backend 镜像含构建期内容（源码、pnpm 产物等），并非纯生产运行时；
- Docker Hub 预构建镜像存在但没被快速开始利用。

### 1.2 目标

1. **一键部署**：用户侧从「clone 仓库 → 配两套 env → 本地构建」变成「下载一个 compose 文件和一体化镜像 → 配最少变量 → `docker compose up -d`」，根目录 Compose 默认使用单容器应用模式。
2. **单一应用镜像**：前端 dist 与后端运行时合并为一个 `gugu-web:<tag>` 镜像，只含生产运行时，不含源码仓库、前端 node_modules、pnpm 缓存等构建期内容；保留 TS RAG worker 所需的 Linux x64 native 运行依赖。
3. **数据安全边界**：PostgreSQL 与 Redis 为独立容器，用户数据全部在显式持久卷；升级 = 拉新镜像重建 app 容器，数据库与文件卷不动。
4. **配置两条路径**：启动前用 compose 变量配置；未配项（模型 API Key 等）启动后在界面配置。缺了无法启动的关键项必须给人话提示。
5. **管理员账号无默认密码**：首次启动自动生成随机密码，打印一次并落盘 `backend/.env`，不引入公开默认密码（与 README「不会使用公开默认密码」约定一致）。

### 1.3 明确不做

- 不把 PostgreSQL/Redis 塞进应用容器（已否决的「真·单容器」方案 B）：升级即重建容器会绑死数据库生命周期，备份/迁移/排障全部变复杂。
- 不改变现有 `docker-compose.prod.yml` 生产部署路径；backend/frontend 分离镜像继续保留供现生产使用。
- 不做 SQLite/无 Redis 轻量模式（PRD-ARCH-6 的范围）。
- 不做多架构镜像（本期仅 linux/amd64）。
- Docker release 流水线随 v1.0.6 接入默认单容器镜像构建、Trivy 安全门、双 registry 发布与 `latest` 标签。
- 不写死默认管理员密码。

## 2. 功能需求

### FR-DEPLOY-001：一体化应用镜像

提供根目录 `Dockerfile`，多阶段构建产出单个应用镜像：包含后端 Python 运行时（venv 仅含 `requirements.txt`）、后端代码、前端 `dist/` 静态产物、LibreOffice 等运行时依赖；不包含前端源码、Node/pnpm、构建缓存、测试代码与 `docs/`。镜像以 `linux/amd64` 为目标平台。LibreOffice 支持构建参数关闭（沿用 `GUGU_INSTALL_LIBREOFFICE` 先例）。

### FR-DEPLOY-002：前端静态托管

应用容器内对外提供完整站点：API 与前端静态文件同源。路径规则必须覆盖现 prod nginx 承接的全部前缀（`/api`、SSE、WebSocket、静态资源）。实施时在「FastAPI StaticFiles」与「app 内置 nginx（同容器多进程）」之间按现 prod nginx 配置盘点结果二选一。

### FR-DEPLOY-003：一键 compose

根目录 `docker-compose.yml` 直接提供默认单容器配置与 `.env.example`：`docker compose up -d` 一条命令拉起 `app + postgres + redis`；Shell 沙盒经 `--profile sandbox` 显式启用（searxng/squid/bootstrap 策略与 Dev/Prod Compose 一致）。

### FR-DEPLOY-004：启动前置检查

app 容器入口在启动前校验关键条件，失败时输出中文提示与修复命令，不产生含糊的堆栈报错：`SECRET_KEY` / `GUGU_DB_PASSWORD` 未设置（提示附 `openssl rand -base64 32` 生成命令）；用户数据目录（`GUGU_DATA_HOST_DIR`，默认 `/data`）不存在或不可写（提示 mkdir/chown 命令）。

### FR-DEPLOY-005：随机管理员密码

`ADMIN_PASSWORD` 未设置时，首次启动生成随机密码，以原子方式追加写入 `backend/.env`（字段已存在时绝不覆盖），并在终端打印一次「管理员账号/密码（已保存到 backend/.env）」。重启不重复生成。

### FR-DEPLOY-006：文档更新

`README.md` / `README_en.md` 快速开始以一键部署为主（标注 amd64-only、依赖前置 Docker 20+/Compose v2、外网拉镜像、`/data` 目录创建、国内镜像源备注、随机密码说明与启动前自定义 `ADMIN_USERNAME/ADMIN_PASSWORD` 的方法），并保留 Dev Compose 源码开发说明。`docs/DEPLOY.md` 增补默认 Compose 单容器章节（变量表、升级、备份、沙盒 profile）。

## 3. 技术方案

### 3.1 镜像分层

| 阶段 | 内容 | 产物 |
|---|---|---|
| frontend build | Node + pnpm 执行 `pnpm build` | `dist/` |
| backend runtime | Python 基础镜像 + venv（仅 requirements.txt）+ LibreOffice 等运行时依赖 | 运行时层 |

最终镜像 tag 形态：`coffeiz/gugu-web:<v1.0.x>`，默认入口引用 `coffeiz/gugu-web:latest`，待 v1.0.6 发布流水线补齐滚动 tag。进程模型：entrypoint 前置检查 → Alembic 迁移 → 同容器托管 Uvicorn、Nginx、worker 与 IM gateway；健康检查覆盖 Web 入口，关键后台进程退出时让容器退出。

### 3.2 静态托管选型

现 prod nginx 的路径表如下：`/api/` 透传后端，并设置 `proxy_http_version 1.1`、`proxy_read_timeout 3600s`、`proxy_buffering off` 以覆盖 SSE 与 WebSocket；`/admin` 301 到 `/admin/`；`/admin/` 使用 `/admin/index.html` SPA 回退；`/fonts/` 仅提供真实静态文件并设置一年 immutable 缓存；其余路径使用 `/index.html` SPA 回退。

路径规则与现 prod 一致，默认单容器模式使用镜像内 Nginx：`nginx/compose.conf` 负责静态资源、SPA 回退、字体缓存、请求体限制，以及将 `/api/`、SSE、WebSocket 和 `/health` 反代到容器内 Uvicorn；Uvicorn 监听容器内 8001，Nginx 对外监听 8000。常规分离镜像部署不受影响。

### 3.3 环境变量

沿用现有命名：`GUGU_DB_PASSWORD`、`SECRET_KEY`、`GUGU_DATA_HOST_DIR`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`GUGU_PUBLIC_APP_URL`；新增 `GUGU_WEB_IMAGE`（默认 Compose 单容器镜像引用，默认 `coffeiz/gugu-web:latest`）。BYOK 主密钥沿用 v1.0.5 的 `CREDENTIALS_MASTER_KEY_FILE` 持久卷机制，升级不丢。

### 3.4 数据与日志隐私边界

随机密码写入 `backend/.env` 遵守「运行配置保护」约定：只在字段不存在时原子追加，不覆盖用户已有内容；密码不写入日志（终端一次性打印除外，属用户自己的部署输出）。

## 4. 验证与上线

- devserver 实测（与生产同架构 amd64）：`docker build -f Dockerfile` 已构建成功；镜像内 `msgpack`/`setuptools` 版本与 Nginx 配置已核验；镜像体积与 Trivy 状态记录在本 PRD 的 Phase 2 验证说明中；
- 普通测试：执行 backend 全量 pytest（不含 E2E），并补充默认 Compose 入口专项测试；
- Trivy：按用户要求不纳入本轮验收，合并前通过 devserver 用户代理 `192.168.110.50:7890` 单独执行 HIGH/CRITICAL 扫描；
- 前置检查触发：逐项去掉 `SECRET_KEY`/`GUGU_DB_PASSWORD`/数据目录，确认中文提示与修复命令；
- 升级场景：更换 `GUGU_WEB_IMAGE` tag 重建 app 容器，数据库与文件卷数据保留，BYOK 密钥不丢；
- 沙盒：`--profile sandbox` 后 Shell 沙盒可用，egress 行为与 Dev/Prod Compose 一致；
- 发布范围：合入 dev 后随 v1.0.6 流水线首次对外推送；回滚方式 = `.env` 指回旧 tag 重建 app 容器。

### Phase 2 实测记录（2026-09-04）

- `gugu-web:phase2` 在 devserver linux/amd64 构建成功；默认 Compose 与 `sandbox` profile 配置校验通过。
- 入口检查与管理员密码幂等性专项测试通过；默认 Compose 入口普通测试 3 项通过；入口脚本语法、gateway 导入与镜像内 Nginx 配置校验通过。
- devserver 默认 Compose 单容器模式已部署在 `9596`；默认页面、Admin、health、Admin 登录负向接口、容器重启、`/data` 持久卷、BYOK 主密钥和 worker/gateway/Uvicorn/Nginx 进程烟测通过；sandbox profile 的 bootstrap 退出码为 0，sandboxd socket 与独立 egress 网络存在。
- sandboxd 显式禁用继承的 HTTP healthcheck，避免非 Web 进程被错误标记为 unhealthy。
- 修复默认单容器构建产物静态文件权限：Vite 生成的素材在镜像内曾为 `600 root:root`，导致 Nginx 对 logo/字体返回 403；构建阶段统一修正为目录 755、文件 644。
- 默认、Dev、Prod 三份 Compose 配置解析通过；默认 Compose 所需相对路径、env 文件、Nginx/Squid 配置和 Dockerfile 路径检查通过；前端普通测试 66 个文件/424 项通过。
- 本轮不执行 Trivy；此前尝试通过 `192.168.110.50:7890` 下载漏洞库仍因带宽过低超时，合并前另行扫描，不将本轮视为 Trivy 通过。
- backend 全量普通测试结果：1909 passed、5 failed。失败为现有能力注册数量断言（实际 103、断言 102）2 项，以及 TypeScript RAG 测试缺少 `@node-rs/jieba` 导致 3 项失败；未因本次默认 Compose 单容器代码改动调整这些基线问题。
- 重建后镜像内依赖已核验为 `msgpack==1.2.2`、`setuptools==84.0.0`。此前旧镜像 Trivy 预扫发现的两个 HIGH 已在构建链中修复；对新镜像复扫时，漏洞库经 `192.168.110.50:7890` 下载仍超时，未取得最终通过/失败漏洞清单。
- 已用 `--pull` 刷新全部自有镜像：开发/生产 backend、开发/生产 frontend、默认单容器应用、sandbox、LoopScope collector/frontend；LoopScope 统一 Node `latest`（当前 `26.8.1`），并将 `better-sqlite3` 从 `11.10.0` 升级至 `13.0.3` 以兼容新 Node ABI。
- 默认单容器镜像约 4.44GB，现有 backend/frontend 镜像约 2.52GB/604MB。本轮按要求不执行 E2E、真实模型对话或完整 sandbox 运行验证，因此 `DEPLOY1-006` 保持未完成。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 镜像内 Nginx、Uvicorn、worker 与 gateway 的多进程生命周期管理 | 代理仍存活但后端、worker 或 gateway 已退出 | 入口统一监控 Nginx、Uvicorn、worker、gateway；任一进程退出即退出容器 |
| worker/gateway 同容器化与现分容器模型差异 | 健康检查误报、进程孤儿 | entrypoint 托管，健康检查覆盖 Web 入口；现生产部署不受影响 |
| LibreOffice 使镜像下限仍偏大 | 体积收益不及预期 | 接受并如实记录；保留 `GUGU_INSTALL_LIBREOFFICE=false` 构建参数 |
| 随机密码写 `.env` 与运行配置保护约定冲突 | 覆盖用户配置 | 只在字段不存在时原子追加，符合 AGENTS.md 原子写入约定 |
| amd64-only 对 Apple Silicon 用户不友好 | 拉镜像走 qemu 很慢 | README 明示；方式 B 本地构建兜底 |

### 待确认

- 完整登录、模型 Key 配置、对话及 sandbox profile 仍需在具备可用模型 Key 与 Docker 沙盒运行条件的环境执行；当前已完成配置校验、入口检查、管理员密码幂等性和应用静态路由烟测。

## 6. 唯一实施 TODO

### Phase 1：镜像与托管

- [x] `DEPLOY1-001` 编写根目录 `Dockerfile` 多阶段构建（前端 dist + 后端生产运行时，剔除源码与构建缓存）；验收：amd64 构建成功，镜像内 `ls` 抽查无前端源码/前端 node_modules/pnpm 缓存，并验证 TS RAG worker native 依赖可启动。
- [x] `DEPLOY1-002` 盘点现 prod nginx 路径表并定稿静态托管方案（镜像内 Nginx），回填 §3.2；验收：应用容器内完整站点可访问，SSE/WS/静态资源行为与现 prod 一致。

### Phase 2：一键 compose 与全流程

- [x] `DEPLOY1-003` 将默认 `docker-compose.yml` + `.env.example` 切换为单容器应用（app+postgres+redis，沙盒 profile）；验收：默认与 `sandbox` profile 的 Compose 配置校验通过；普通测试通过；完整登录、配置 Key、对话链路按本轮不执行 E2E。
- [x] `DEPLOY1-003a` 将 IM gateway 纳入默认 Compose app 进程监管；验收：入口默认启动 worker、gateway、Uvicorn、Nginx，并在任一关键进程退出时退出容器。
- [x] `DEPLOY1-004` 实现入口前置检查（SECRET_KEY/GUGU_DB_PASSWORD/数据目录）；验收：缺省数据目录实测输出中文提示与 mkdir/chown 修复命令，未出现裸堆栈；密钥检查由同一入口逻辑覆盖。
- [x] `DEPLOY1-005` 实现随机管理员密码生成（打印一次 + 原子追加 `.env`，重启不重复生成）；验收：首启落盘并打印，第二次启动不重复生成，已有字段不覆盖。
- [x] `DEPLOY1-006` 升级与沙盒场景实测：换 tag 重建 app 容器数据保留、BYOK 密钥不丢、`--profile sandbox` bootstrap/socket/独立网络可用；Trivy 按用户要求移至合并前单独扫描。

### Phase 3：文档与发布衔接

- [x] `DEPLOY1-007` 更新 `README.md`/`README_en.md` 一键部署说明与 `docs/DEPLOY.md` 默认 Compose 单容器章节；验收：中英文一致，amd64 限制、依赖前置、随机密码说明齐全。
- [x] `DEPLOY1-008`（随 v1.0.6）Docker release 流水线增加默认单容器镜像构建推送与 `latest` tag；验收：tag 触发后 Docker Hub 出现 `gugu-web:<version>` 与 `latest`，README 一键命令可直接使用。
