# 咕咕 部署文档（开发 + 生产完整教程）

从零把咕咕跑起来：开发环境一步步起服务，生产环境上 nginx + systemd。含 venv、数据库、AI、IM 频道（飞书）的完整配置。

---

## 0. 架构总览：要跑哪些进程

咕咕分前端 + 后端，后端又有 **3 个常驻进程** + **2 个依赖服务**：

| 角色 | 是什么 | 命令（在 `backend/`，用 `.venv`） | 何时需要 |
|------|--------|-----------------------------------|----------|
| **web** | FastAPI（API + Admin），uvicorn :8000 | `make start` / `./start.sh start` | 必须 |
| **worker** | 消费 IM 队列 → 跑咕咕大脑 → 发回平台 | `.venv/bin/python -m worker` | 接 IM 时 |
| **supervisor** | 频道管家：按 Admin 频道面板起停各平台网关子进程 | `.venv/bin/python -m agent.adapters.supervisor` | 接 IM 时 |
| PostgreSQL | 主数据库 | 系统服务 / Docker | 必须 |
| Redis | IM 消息队列（Streams） | 系统服务 / Docker | 接 IM 时 |

> 前端：开发用 `npm run dev`（:5173）；生产 `npm run build` 出 `dist/`，由 nginx 托管。
> 不接 IM（飞书/QQ/微信）时，worker / supervisor / Redis 可以不跑。

---

## 1. 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Python | 3.11+ | 后端 |
| Node.js | 18+ | 前端构建 |
| PostgreSQL | 15+ | 数据库 |
| Redis | 7+ | IM 队列（接 IM 才需） |
| **LibreOffice** | 任意 | 咕咕生成 Word/PDF/Excel（`create_document`）靠 `libreoffice --headless` 转换 |

系统包（Debian/Ubuntu 示例）：
```bash
sudo apt update
sudo apt install -y python3-venv python3-dev build-essential \
                    postgresql redis-server libreoffice nginx
# Node 用 nvm 或 nodesource 装 18+
```

---

## 2. 开发环境部署

### 2.1 拿代码
本项目部署**不依赖 git**，`scp`/`rsync` 传整个目录即可。开发就是本地目录。

### 2.2 后端：venv + 依赖
```bash
cd backend
python3 -m venv .venv                 # 建虚拟环境（脚本/Makefile 默认找 .venv）
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
```
> 全程用 `.venv/bin/xxx` 绝对路径，**不用 `activate`**，避开 PEP 668 / 系统包污染。`make deps` 等价于上面最后一步。

### 2.3 配置
两层：`.env`（基础值）+ Admin 面板写的 `config.override.json`（优先级最高，运行时热合并）。

最小可跑：建 `backend/.env`（嵌套用双下划线 `__`）：
```
# 数据库（也可在 Admin 配）
DB__HOST=localhost
DB__PORT=5432
DB__NAME=gugu_web
DB__USER=pm
DB__PASSWORD=pm123

# JWT 密钥（生产务必改）
SECRET_KEY=换成随机长字符串

# Redis（接 IM 才需要）
REDIS__HOST=localhost
REDIS__PORT=6379

# AI / 存储 / 飞书等：建议启动后在 Admin 面板配（写入 config.override.json）
```
> `.env` 和 `config.override.json` 都已 gitignore，不入库。AI key、飞书凭据等敏感配置**优先用 Admin 面板**填。

### 2.4 数据库
建库 + 用户（与上面 `.env` 对应）：
```bash
sudo -u postgres psql -c "CREATE USER pm WITH PASSWORD 'pm123';"
sudo -u postgres psql -c "CREATE DATABASE gugu_web OWNER pm;"
```
表结构：后端启动时自动 `create_all` 建表 + 跑内置 schema 迁移；也可手动 `make migrate`（`alembic upgrade head`）。

### 2.5 启动后端
```bash
# 开发用前台 + 热重载（改代码自动重启）
make fg            # = ./start.sh foreground，带 --reload

# 或后台跑
make start         # 后台 uvicorn :8000，日志 logs/gugu.log
make status        # 状态 + 健康检查
make logs          # 实时日志
```
健康检查：`curl http://127.0.0.1:8000/health` → `{"status":"ok"}`。

### 2.6 前端
```bash
cd frontend
npm install
npm run dev        # Vite :5173，已设 host:true 可局域网访问
```
浏览器开 `http://localhost:5173`。

### 2.7 IM 频道进程（接飞书才需要）
确保 Redis 在跑，然后两个进程（各开一个终端，或后台）：
```bash
cd backend
.venv/bin/python -m agent.adapters.supervisor   # 频道管家
.venv/bin/python -m worker                        # 队列消费 worker
```
频道在 **Admin → Agent 配置 → 频道** 里加（详见 [`feishu接入指南.md`](feishu接入指南.md)）。

> ⚠️ **改了 `agent/` 大脑代码（runner / skills / core / 上下文 / 记忆等）后，worker 必须重启**——咕咕的大脑跑在 **worker** 进程里，不是 web（uvicorn）、也不是 supervisor。
> - `supervisor` + 各平台网关（qq/feishu）只负责**收消息入队**；改它们（adapters）才需重启 supervisor。
> - `make restart` 只重启 web（uvicorn），**不动 worker/supervisor**。
> - 只重启 supervisor 而漏了 worker，会出现「网页/IM 行为没按新代码变」的诡异现象（如实时事件不发、新字段不写）——见 `devlog.md` 2026-06-23「漏重启 worker」。

### 2.8 Admin 初始化
- Admin 后台：`http://localhost:5173/admin/login`
- 默认账号 **admin / admin123**（⚠️ 上线前必改）
- 登录后在「系统配置 / Agent 配置」里设 DB / Redis / AI provider / 存储 / 频道。

---

## 3. 生产环境部署

生产 = 前端静态托管 + 后端常驻服务 + nginx 反代 + HTTPS。

### 3.1 系统依赖 + venv + 依赖
同 §1、§2.2（装系统包、建 `.venv`、`make deps`）。

### 3.2 配置（生产）
- `backend/.env`：填 DB / Redis / `SECRET_KEY`（**务必换随机值**）。
- 其余（AI key、OSS、飞书凭据）登录 Admin 面板配，落到 `config.override.json`。
- **存储**：默认本地 `uploads/`；多机/对象存储用 Admin 切到阿里云 OSS。

### 3.3 数据库迁移
```bash
cd backend && make migrate     # alembic upgrade head
```

### 3.4 前端构建 → nginx 托管
```bash
cd frontend
npm install
npm run build                  # 产物在 frontend/dist/
```

nginx 配置（`/etc/nginx/sites-available/gugu`）：
```nginx
server {
    listen 80;
    server_name gugugu.site;

    # 前端静态（主站 + 后台是两个独立 SPA，共用 dist/ 根）
    root /path/to/Gugu-web/frontend/dist;
    index index.html;

    # 后台 SPA：深链/刷新回退到 admin 自己的 index.html（必须在 location / 之前/之外单列）
    location /admin {
        try_files $uri $uri/ /admin/index.html;
    }

    # 主站 SPA
    location / {
        try_files $uri $uri/ /index.html;     # SPA 路由回退
    }

    # 后端 API（主站 + 后台共用这一套反代）
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE（咕咕聊天流式）：关缓冲
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    client_max_body_size 100m;   # 文件上传
}
```
```bash
sudo ln -s /etc/nginx/sites-available/gugu /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
> HTTPS：用 `certbot --nginx -d gugugu.site` 自动配 Let's Encrypt。

### 3.5 后端 web 服务（systemd）
项目自带：
```bash
cd backend && make install      # 按当前目录自动生成 gugu-backend.service（自启 + 自重启）
sudo systemctl status gugu-backend
```

`make install` 会：
- 按**当前 backend 目录**(`APP_DIR`)填好单元里的 `WorkingDirectory`/`ExecStart`/`ReadWritePaths`（模板里是 `__APP_DIR__` 占位符，不写死路径——换部署目录也不用手改）；
- 先建出 `uploads/`、`logs/`、`config.override.json` 并 `chown` 给运行用户（`ReadWritePaths` 要求这些路径**真实存在**，否则 systemd 报 `226/NAMESPACE`）；
- 运行用户默认 `www-data`，可覆盖：`RUN_USER=youruser make install`（该用户须已存在，且能读 `.venv` 与项目目录）。

> 1Panel 部署：backend 一般在 `/opt/1panel/www/sites/<域名>/backend`，直接在该目录 `make install` 即可，路径自动对上。

### 3.6 worker + supervisor 服务（systemd · 需手动加）

> `make install` 只装 web。IM 的 worker / supervisor 需各加一个单元。**关键**：supervisor 会拉子进程，停它时要整组清理 → `KillMode=control-group`。

`/etc/systemd/system/gugu-worker.service`：
```ini
[Unit]
Description=Gugu IM worker
After=network.target redis-server.service

[Service]
WorkingDirectory=/path/to/Gugu-web/backend
ExecStart=/path/to/Gugu-web/backend/.venv/bin/python -m worker
Restart=always
RestartSec=3
User=youruser

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/gugu-supervisor.service`：
```ini
[Unit]
Description=Gugu IM channel supervisor
After=network.target redis-server.service

[Service]
WorkingDirectory=/path/to/Gugu-web/backend
ExecStart=/path/to/Gugu-web/backend/.venv/bin/python -m agent.adapters.supervisor
Restart=always
RestartSec=3
KillMode=control-group
User=youruser

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gugu-worker gugu-supervisor
sudo systemctl status gugu-worker gugu-supervisor
```
> worker 想扩吞吐可起多个（多个 service 实例，共享 Redis 消费组自动负载均衡）；supervisor 一台机一个即可。

### 3.7 Admin 安全
- 改默认密码 admin/admin123。
- `SECRET_KEY` 用强随机值。
- CORS：`main.py` 默认只开 localhost:5173，生产改成实际域名。

---

## 4. IM 频道（飞书）

飞书 bot 创建、权限、长连接事件订阅、凭据填写、频道面板原理，**完整步骤见 [`feishu接入指南.md`](feishu接入指南.md)**。生产上确保 `gugu-supervisor` + `gugu-worker` 两个服务在跑，频道在 Admin 面板增删启停即时生效。

---

## 5. 日常运维

```bash
cd backend
make status              # web 状态 + 健康检查
make logs                # web 实时日志
sudo systemctl status gugu-worker gugu-supervisor    # IM 进程
sudo journalctl -u gugu-supervisor -f                # 看频道起停日志
```

## 6. 更新部署
```bash
# scp/rsync 传新代码后：
cd backend
make update              # = deps + migrate（装依赖 + 跑迁移）
make restart             # 重启 web
sudo systemctl restart gugu-worker gugu-supervisor   # 重启 IM（若改了 agent 代码）
cd ../frontend && npm install && npm run build        # 前端重新构建
# 或一键：make deploy（备份 + 依赖 + 迁移 + 前端 build + 重启）
```

> ⚠️ **务必 `make migrate`，别只 restart**：启动时的 `create_all` **只建缺失的表、不会给已有表加新列**。所以凡是新增了模型列（如 `conversation_messages.files` 文件卡片、`conversation_sessions.source` 会话来源），只重启不跑迁移 → 相关写入会因「列不存在」报错。`make update` / `make deploy` 已含 migrate；手动更新记得补 `make migrate`。

## 7. 备份
```bash
cd backend && make backup     # 备份数据库 + uploads + config.override.json
```
> `uploads/` 含用户文件 + 咕咕 `.agent/` 记忆；`config.override.json` 含所有 Admin 配置（含明文凭据）。两者都要备。

---

## 8. 常见问题

| 现象 | 解法 |
|------|------|
| 后端 500 / 启动失败 | 必须从 `backend/` 目录起（否则 `.env` 不加载）；查 `logs/gugu.log` |
| 生成 Word/PDF/Excel 失败 | 没装 **LibreOffice**（`apt install libreoffice`） |
| 聊天流式（SSE）被截断 | nginx 要 `proxy_buffering off` + 拉长 `proxy_read_timeout` |
| IM 收不到/回不出 | Redis 没起；或 supervisor/worker 没跑；详见 feishu接入指南排错表 |
| worker `Timeout reading from ...:6379` | 已修：`app/core/redis.py` `socket_timeout=None`（旧版本需更新代码） |
| Admin 频道保存「消失」 | 后端加了 `/admin/agent/bots` 接口后要 `make restart` |
| `pip install` 报 externally-managed | 用 `.venv/bin/pip`（绝对路径），别用系统 pip |

---

## 附：关键路径

| 路径 | 内容 |
|------|------|
| `backend/.venv/` | Python 虚拟环境 |
| `backend/.env` | 基础配置（gitignore） |
| `backend/config.override.json` | Admin 写入的配置，含频道/AI 凭据（gitignore） |
| `backend/logs/gugu.log` | web 日志 |
| `uploads/` | 用户文件 + 咕咕 `.agent/` 记忆（gitignore） |
| `frontend/dist/` | 前端构建产物（nginx 托管） |
