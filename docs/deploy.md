# 咕咕 部署文档

## 目录

1. [环境要求](#环境要求)
2. [首次部署](#首次部署)
3. [启动服务](#启动服务)
4. [Admin 初始化](#admin-初始化)
5. [数据库迁移](#数据库迁移)
6. [日常运维](#日常运维)
7. [部署更新](#部署更新)
8. [数据备份](#数据备份)
9. [systemd 部署（可选）](#systemd-部署可选)
10. [常见问题与注意事项](#常见问题与注意事项)

---

## 环境要求

- Python 3.11+
- Node.js 18+
- PostgreSQL 15+
- Redis 7+

---

## 首次部署

> ✅ **本项目部署不需要 git**。推荐用 `scp` / `rsync` 直接传文件到服务器，后端脚本会自动同步依赖、迁移、重启。

### 1. 把代码传到服务器

**本地（Windows PowerShell）：**

```powershell
# 用 scp 传整个项目（首次部署）
scp -r D:\path\to\Gugu-web\* root@your-server:/opt/1panel/www/sites/test.gugugu.site/
```

或者**在服务器上**直接拉 zip 包：

```bash
# 本地先打包
# tar -czf gugu.tar.gz --exclude=node_modules --exclude=.venv --exclude=__pycache__ Gugu-web/

# 服务器上
mkdir -p /opt/1panel/www/sites/test.gugugu.site
cd /opt/1panel/www/sites/test.gugugu.site
# scp / rsync / wget 都行
```

### 2. 创建虚拟环境 + 装依赖

```bash
cd /opt/1panel/www/sites/test.gugugu.site/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

> ⚠️ **不要用 `--break-system-packages`**。它会污染系统 Python，与未来的 apt 装包冲突。
>
> **不要手动 `source .venv/bin/activate`**，下面所有命令都用绝对路径（`.venv/bin/xxx`），不会踩 PEP 668 或系统包冲突。

### 3. 配置环境变量（可选）

后端支持通过 `.env` 文件或 Admin 后台（热更新）配置。若环境变量与 `config.override.json` 同时存在，override 文件优先级更高。

```bash
# backend/.env（可选，不提交到仓库）
SECRET_KEY=your-secret-key-here
```

### 4. 启动后端 + 初始化数据库

```bash
# 4.1 先启动后端（即使 DB 还没配也能起，详见常见问题）
./start.sh start

# 4.2 浏览器登录 Admin，填好 DB / Redis / AI 配置并保存
# 详见后文「Admin 初始化」

# 4.3 DB 配通后再跑迁移
make migrate
```

### 5. 装前端依赖 + 构建

```bash
cd /opt/1panel/www/sites/test.gugugu.site/frontend
npm install
npm run build
# 产物在 dist/，交给 nginx 托管
```

### 6. 配 Nginx 反向代理 + SPA 伪静态

详见后文「Nginx 配置」章节。

---

## 启动服务

> ⚠️ **必须在 `backend/` 目录下启动**，否则相对路径（`config.override.json`、`./uploads`）会指向错误位置，导致配置读写失败。

推荐使用仓库自带的 [`start.sh`](../backend/start.sh) 管理脚本——它会处理 PID 文件、日志、端口检测、僵尸进程清理等坑，避免手动 `nohup` 留下隐患。

### 后端（推荐）

```bash
cd /path/to/Gugu-web/backend
chmod +x start.sh          # 首次需要加执行权限

./start.sh start           # 后台启动
./start.sh status          # 看 PID + 健康检查
./start.sh logs            # 实时跟踪日志（Ctrl+C 退出）
./start.sh stop            # 优雅停止（10s 后强杀）
./start.sh restart         # 重启
./start.sh foreground      # 前台 + --reload，调试用
```

**或用 Makefile（命令更短）：**

```bash
make status                # 等价 ./start.sh status
make restart               # 等价 ./start.sh restart
make logs                  # 等价 ./start.sh logs
make help                  # 查看全部命令
```

**常用环境变量：**

```bash
PORT=8080 ./start.sh start              # 改端口
WORKERS=4 ./start.sh start              # 多 worker
DB_STARTUP_TIMEOUT=10 ./start.sh start  # DB 启动等待时间（默认 5s）
```

**手动方式（不推荐，新手容易踩坑）：**

```bash
# 开发（前台 + 热重载）
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 生产（后台）—— 仅在 start.sh 不可用时使用
nohup ./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 >> logs/gugu.log 2>&1 &
disown
```

验证启动成功：

```bash
curl http://localhost:8000/health
# {"status":"ok","app":"PM Studio"}
```

### 前端（开发）

```bash
cd frontend
npm run dev
```

### 前端（生产）

```bash
cd frontend
npm ci
npm run build
# 产物在 dist/，交给 nginx 托管
```

---

## Admin 初始化

首次部署后，用默认账号登录 Admin 后台并完成配置：

- 地址：`http://<your-host>/admin`
- 默认账号：`admin`
- 默认密码：`admin123`

> ✅ **2026.06+ 版本：数据库连不上也能登录 Admin**。后端启动加了 5s 超时 + 后台重试循环，远端 DB 没配好时也能进入后台，再通过「系统配置 → 数据库」填远端 DB 信息即可。详见[常见问题](#-数据库连不上也能启动v202606)。

**登录后立即完成以下操作：**

1. **系统配置 → 数据库**：填写 PostgreSQL 连接信息，点「测试连接」验证后保存
2. **系统配置 → Redis**：填写 Redis 连接信息，测试后保存
3. **系统配置 → AI 配置**：填写 API Key 和模型

> Admin 后台使用 JWT（`secret_key`）签发 token。如果修改了 `secret_key`，所有已登录的 Admin token 立即失效，需要重新登录。

---

## 数据库迁移

更新代码后（无论传文件还是其他方式），跑迁移：

```bash
cd /opt/1panel/www/sites/test.gugugu.site/backend
make migrate          # 推荐（自动用 venv 绝对路径，不踩坑）
# 或
.venv/bin/alembic upgrade head
```

查看当前迁移状态：

```bash
make migrate          # 末尾会自动打印 alembic current
# 或
.venv/bin/alembic current
.venv/bin/alembic history --verbose
```

---

## 日常运维

### 查看状态

```bash
./start.sh status
# [2026-06-17 14:08:00] 运行中 (PID 164692)
# [2026-06-17 14:08:00] 端口 8000 监听情况：
# LISTEN 0  2048  0.0.0.0:8000 ...
# [2026-06-17 14:08:00] 健康检查：
# {"status":"ok","app":"PM Studio"}
```

### 查看日志

```bash
./start.sh logs              # 持续跟踪
tail -n 200 logs/gugu.log    # 看最近 200 行
grep "ERROR" logs/gugu.log   # 只看错误
```

### 修改 secret_key 后

`secret_key` 一改，所有已签发的 JWT 立即失效（前端 `admin_token` 和 `user_token` 都需要重新登录）。重启服务使新 key 生效：

```bash
./start.sh restart
```

### 清缓存

```bash
make clean    # 清 __pycache__ 和 .gugu.pid（保留 venv / uploads / override）
```

---

## 部署更新

**推荐工作流：本地修改 → 传文件 → 服务器跑脚本。**

```powershell
# 本地（PowerShell）：只传 backend 和 frontend 两个目录
scp -r D:\path\to\Gugu-web\backend\*   root@server:/opt/1panel/www/sites/test.gugugu.site/backend/
scp -r D:\path\to\Gugu-web\frontend\* root@server:/opt/1panel/www/sites/test.gugugu.site/frontend/
```

```bash
# 服务器：一键部署
cd /opt/1panel/www/sites/test.gugugu.site/backend
make deploy                  # 或 ./deploy.sh
```

执行流程：备份 → 装依赖 → 跑迁移 → 前端 `build` → 重启 → 健康检查。

**常用参数：**

```bash
./deploy.sh --no-build       # 不重建前端（只更后端）
DB_STARTUP_TIMEOUT=10 ./deploy.sh   # 临时改 DB 超时
```

**只想装依赖 + 迁移、不重启：**

```bash
make update      # = deps + migrate（不重启服务）
```

> `deploy.sh` 在改任何东西前会自动备份 `config.override.json` 和 `uploads/`，保留最近 10 份到 `.deploy-backups/`。

---

## 数据备份

```bash
make backup      # 或 ./backup.sh [目标目录]
# 默认存到 .deploy-backups/gugu-backup-YYYYMMDD-HHMMSS.tar.gz
# 包含 config.override.json + uploads/ + alembic 版本
```

**手动恢复：**

```bash
tar -xzf .deploy-backups/gugu-backup-xxx.tar.gz -C /tmp/restore
cp /tmp/restore/config/config.override.json /opt/.../backend/
cp -a /tmp/restore/data/uploads /opt/.../backend/
```

**建议加 cron 每天自动备份：**

```bash
crontab -e
# 加一行（每天 3:00 备份，保留 30 天）
0 3 * * * cd /opt/.../backend && ./backup.sh /var/backups/gugu
```

---

## systemd 部署（可选）

适合需要**开机自启 + 进程挂了自动拉起 + 集中日志管理**的场景。

> ⚠️ 装上 systemd 后**不要再用 `./start.sh` 操作**（会冲突）。统一走 `systemctl`。

```bash
# 1) 编辑 gugu-backend.service，把 User/Group 改成实际运行的用户
#    默认 User=www-data 没有写权限，建议先用 root 跑通，再换成专用用户
sed -i 's/User=www-data/User=root/' gugu-backend.service
sed -i 's/Group=www-data/Group=root/' gugu-backend.service

# 2) 装成系统服务（自动 enable + start + status）
make install

# 3) 之后用 systemctl 管
systemctl status gugu-backend
journalctl -u gugu-backend -f          # 实时日志
systemctl restart gugu-backend         # 重启

# 4) 不用了卸掉
make uninstall
```

---

## 常见问题与注意事项

### ❌ 保存配置返回 500

**根本原因：后端从错误目录启动。**

`config.override.json` 的路径是相对于进程工作目录（`cwd`）解析的。如果 uvicorn 从其他目录启动，读写的就是那个目录下的文件，甚至可能读不到配置而报错。

**诊断方法：**

```bash
# 查看后端进程的启动目录
ls -la /proc/$(pgrep -f "uvicorn app.main")/cwd
```

**解决方法：** 停止进程，`cd backend/` 后重新启动。

---

### ❌ 刷新页面后 Admin 配置恢复默认

**原因：** 后端启动目录不对，读取的是另一个目录（或默认值），而不是 `config.override.json`。

与上一条同因，确保从 `backend/` 目录启动即可。

---

### ❌ OSS 连接测试只显示 × 没有错误文字

**原因：** UI 布局问题，错误信息被 flex 布局挤压到零宽度，文字不可见。

如果升级后仍然出现，检查 `Admin/Config/index.vue` 中 `oss-test-result` 的 div 是否独立于 `oss-footer-top` 之外（分两行显示，而不是同一行内联）。

---

### ❌ PATCH /admin/config 返回 500 但原因不明

保存配置时 500 错误会在响应 body 的 `detail` 字段携带完整的 Python traceback，直接在浏览器 DevTools → Network 面板查看响应内容即可定位根因。

---

### ⚠️ 密码字段处理规则

- 后端返回密码类字段时一律脱敏为 `****`
- 前端收到 `****` 后清空（视为"未修改"）
- 保存时，密码字段为空 → 跳过，不覆盖已保存的值
- 保存时，密码字段有新内容 → 正常写入

涉及的字段：`password`、`api_key`、`oss_access_key_id`、`oss_access_key_secret`

---

### ⚠️ 换目录/重命名项目后记得迁移 config.override.json

`config.override.json` 不在 git 中（`.gitignore`），换机器或重命名目录时需要手动复制。

---

### ❌ OSS 测试 / 保存报 `No module named 'oss2'`

阿里云 OSS SDK 需要单独安装，`requirements.txt` 已包含但某些环境下需要手动确认：

```bash
pip install oss2 --break-system-packages
```

安装后重启后端即可。

---

### ⚠️ 修改 config.override.json 后无需重启

Admin 后台保存配置会自动调用热更新（`lru_cache` 清除 + 重建连接池），数据库连接会重建，无需重启 uvicorn。

但如果**手动编辑** `config.override.json` 文件，则需要重启服务才能生效。

---

### ❌ `pip install` 报 `externally-managed-environment`（PEP 668）

**原因：** 跑的是系统 pip，没用 venv。Debian/Ubuntu 23+ 默认锁死系统 Python。

**解决：**

```bash
# 用 venv 的 pip（推荐）
.venv/bin/pip install -r requirements.txt

# 或激活 venv（不推荐，输错就可能丢状态）
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

**不要用 `--break-system-packages`**。它会污染系统 Python，未来 apt 装包会冲突。

**预防：** 本项目的所有 Makefile / deploy.sh / start.sh 都用绝对路径调 venv 工具，**不需要 activate venv 也不会踩坑**。

---

### ❌ `alembic` 报 SQLAlchemy 不兼容 / `cannot import name 'DeclarativeBase'`

**原因：** 跑的是系统 alembic（`/usr/bin/alembic`，带 SQLAlchemy 1.x），而不是 venv 里的（SQLAlchemy 2.0+）。`DeclarativeBase` 是 2.0 才有的。

**解决：**

```bash
# 用 venv 的 alembic
.venv/bin/alembic upgrade head

# 或用脚本（推荐，永远不会踩）
make migrate
```

**预防：** 别手动 `deactivate` 然后还跑 `alembic` / `pip` / `uvicorn`。本项目脚本都用绝对路径，不依赖 venv 激活状态。

---

### ✅ 数据库连不上也能启动（v2026.06+）

后端 `lifespan` 现在加了 **DB 启动超时（默认 5s）+ 后台重试循环**，远端 DB 暂时不通时 Admin 后台也能正常登录：

- 启动 5 秒后无论 DB 通不通都绑端口，uvicorn 不再被卡死
- 启动后每 30 秒后台自动重试，连上就建表
- 在 Admin 后台「系统配置 → 数据库」填好远端 DB 保存后，无需重启即生效

**调整超时：** 通过环境变量 `DB_STARTUP_TIMEOUT`

```bash
DB_STARTUP_TIMEOUT=10 ./start.sh start
DB_STARTUP_TIMEOUT=3 ./deploy.sh
```

**典型启动日志（DB 暂不可达）：**

```
[警告] 数据库 5s 内未连通，已跳过建表（Admin 仍可用）
[DB重试] 尚未连通：OperationalError: ...
... 30 秒后 ...
[OK] 数据库后台重连成功，表已建
```

---

### ⚠️ 启动报 "Address already in use"

8000 端口被别的进程占了。`start.sh start` 会自动检测并提示：

```bash
./start.sh start
# [ERROR] 端口 8000 已被其他进程占用：
# 请先释放：fuser -k 8000/tcp 或 ./start.sh stop
```

**手动排查：**

```bash
# 找占用的进程
lsof -i:8000
ss -tlnp | grep :8000

# 杀掉（确认是要替换的旧 uvicorn 后再杀）
kill <PID>      # 优雅
kill -9 <PID>   # 强杀

# 然后再启动
./start.sh start
```

---

### ⚠️ 后台 uvicorn 退出了但端口还被占

最常见原因：之前的 `nohup uvicorn ... &` 没正确 `disown`，SSH 断连后进程死了又重启。一律改用 `./start.sh start`：

```bash
pkill -9 -f "uvicorn app.main"   # 杀干净
./start.sh start                 # 用脚本启（自动写 PID、自动检测端口）
```

---

### ⚠️ 用 `./start.sh` 还是 `systemctl`？

两者**只能选一个**，混用会两个进程抢同一个端口。

| 场景 | 推荐 |
|---|---|
| 开发服务器 / 临时调试 | `./start.sh start` 或 `./start.sh foreground` |
| 生产服务器，需要开机自启 | `./start.sh install`（装成 systemd） |

---

### ⚠️ Nginx 配置（反向代理 + SPA 伪静态）

1Panel / OpenResty 默认站点只处理静态文件，导致两类问题：

| 现象 | 原因 |
|---|---|
| `POST /api/...` 返回 **405** | 没有 `location /api/` 反代，请求落到默认 PHP/静态 handler |
| 刷新 `/admin` 或 `/dashboard` 返回 **404** | Vue Router 用 history 模式，需要 `try_files` 兜底到 `index.html` |

完整配置需要 **反向代理** + **SPA 伪静态** 两部分，缺一不可。

---

#### 方案 A：1Panel GUI（推荐）

**① 反向代理：**

1. 左侧菜单 → **网站** → 站点列表
2. 找到 `test.gugugu.site`，点行尾"设置"图标（或"..."→设置）
3. 左侧切到 **「反向代理」** 标签
4. 点 **「创建反向代理」**，填写：

   | 字段 | 填什么 |
   |---|---|
   | 代理名称 | `gugu-backend` |
   | 代理前缀 | `/api/` |
   | 目标 URL | `http://127.0.0.1:8000` |
   | 发送域名 | `$host` |
   | 启用 WebSocket | ❌ 关 |
   | 替换文本 | 留空 |

5. 点提交，1Panel 自动写入 OpenResty 配置并 reload

**② SPA 伪静态：**

1. 同站点设置 → 左侧 **「伪静态」** 标签（或"重定向/重写"）
2. 在输入框填入：

   ```nginx
   location / {
       try_files $uri $uri/ /index.html;
   }
   ```

3. 保存

**③ 补两行（GUI 不会自动加）：**

文件上传 / 长请求需要手动补，路径：**网站 → 站点设置 → 配置文件**，在 GUI 生成的 `location /api/` 块里加：

```nginx
    client_max_body_size 200m;     # 文件上传（默认 1m 不够）
    proxy_read_timeout  300s;      # AI/慢请求超时
```

保存 → 1Panel 自动 reload。

---

#### 方案 B：手动改配置文件

```bash
# 找配置
CONF=$(grep -rl "test.gugugu.site" /www/server/openresty/conf/ /www/server/panel/vhost/ /etc/nginx/ 2>/dev/null | head -1)
echo "配置路径：$CONF"

# 备份
cp "$CONF" "${CONF}.bak.$(date +%s)"
```

完整 `server { }` 块参考：

```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name test.gugugu.site;

    # SSL（1Panel 自动续签，路径通常在 conf/cert/<域名>/）
    ssl_certificate     /www/server/openresty/conf/cert/test.gugugu.site/fullchain.pem;
    ssl_certificate_key /www/server/openresty/conf/cert/test.gugugu.site/privkey.pem;

    # 前端 build 产物路径
    root /opt/1panel/www/sites/test.gugugu.site/frontend/dist;
    index index.html;

    # ──── 1. 反向代理：API → 后端 :8000 ────
    location /api/ {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 200m;       # 文件上传
        proxy_read_timeout  300s;        # AI/慢请求超时
    }

    # ──── 2. SPA 伪静态：刷新页面不 404 ────
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存（可选，但推荐）
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 7d;
        access_log off;
        add_header Cache-Control "public";
    }
}
```

改完重载：

```bash
# OpenResty（1Panel 默认）
openresty -t && openresty -s reload

# 原生 Nginx
nginx -t && nginx -s reload
```

---

#### 验证

```bash
# 1) API 反代通
curl -i -X POST https://test.gugugu.site/api/v1/admin/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"admin123"}' -k
# 期望：HTTP/2 200 + {"access_token":"eyJ...",...}

# 2) SPA 伪静态通（直接访问深层路由，不应 404）
curl -I https://test.gugugu.site/admin/login -k
curl -I https://test.gugugu.site/dashboard -k
# 期望：HTTP/2 200 + content-type: text/html

# 3) 看 OpenResty 实际日志
tail -10 /www/server/openresty/logs/access.log
# 应该看到 POST /api/v1/admin/auth/login → 200
```

---

#### 为什么用同源反代？

加完 `/api/` 反代后，前端（`test.gugugu.site`）和 API（`test.gugugu.site/api/...`）**同源**，浏览器根本不发 CORS 预检，[main.py](../backend/app/main.py) 里的 `allow_origins` 写什么都不影响，最省心。

如果反着用"前端静态站 + API 跨域"，反而要同时配 CORS 白名单、OPTIONS 预检响应、Cookie 域等一堆东西，不推荐。
