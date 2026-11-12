# gugu-webui Linux/NAS 部署版

`gugu-webui` 是 2.0 的独立 Node HTTP Host。它不启动 Python Web 进程；PostgreSQL 由外部服务提供。

当前实现范围是启动配置、PostgreSQL schema readiness、健康检查、主站/Admin Vue 静态资源及 history fallback、公开站点配置 `GET /api/v1/site-config`、bcrypt 密码登录与用户令牌校验、`GET /api/v1/auth/me`、基于 `gugu-core` 的项目活动/回收站列表与详情读取、项目文件计数读取、日历事件列表/详情、客户列表/创建/删除、站内通知列表/气泡/标已读/个人隐藏，以及 `POST /api/v1/track` 前端行为埋点。登录支持用户名或邮箱、与 Python 兼容的 bcrypt/JWT、Bearer 或 HttpOnly/CSRF Cookie、成功登录事件和单进程固定窗口限流；Redis 共享限流仍待迁移。静态资源来自 `frontend/dist`，API 和 health 未命中仍返回 JSON 404。站点配置仅公开备案信息和 SMTP 能力布尔值，不返回邮件账号或密钥；备案信息从 `GUGU_SITE_ICP_NUMBER` / `GUGU_SITE_ICP_URL` 读取，SMTP 能力使用 `SMTP__*` 环境变量计算。项目回收站列表按 30 天保留期过滤；通知读写保留注册时间可见边界、持久态、已读和仅对当前用户生效的隐藏状态。注册、登出、找回、资料/API 头像、其他业务 API/SSE、Worker 和剩余 Python 行为仍在迁移中，因此当前构建用于开发验收，不作为完整 Web 替代版。

## Docker Compose

在仓库根目录执行：

```sh
cp gugu-webui/.env.example gugu-webui/.env
```

编辑 `gugu-webui/.env`，填写专用 PostgreSQL 连接地址及与现有 Gugu JWT 一致的 `SECRET_KEY`。不要提交 `.env`。数据库应先通过仓库维护的 PostgreSQL schema bootstrap/migration 准备；readiness 会检查用户认证、Core 项目读取、日历读取、客户读写、通知持久态读写、前端埋点和项目文件计数投影依赖的表和列。

启动和检查：

```sh
docker compose --env-file gugu-webui/.env -f gugu-webui/deploy/compose.yaml up --build -d
docker compose --env-file gugu-webui/.env -f gugu-webui/deploy/compose.yaml ps
curl -fsS http://127.0.0.1:9595/health
curl -fsS http://127.0.0.1:9595/health/ready
```

`GUGU_WEBUI_PUBLISHED_PORT` 可改变宿主机端口，容器内服务固定监听 9595。数据库必须允许容器网络连接。

## 本地运行

仓库要求 Node 26.13.x 与 pnpm 10.15：

```sh
corepack pnpm install --filter @gugu/webui --frozen-lockfile
corepack pnpm --filter @gugu/core build
corepack pnpm --filter gugu-web build
corepack pnpm --filter @gugu/webui typecheck
corepack pnpm --filter @gugu/webui test
corepack pnpm --filter @gugu/webui build
corepack pnpm --filter @gugu/webui start
```

本地运行至少设置 `GUGU_WEBUI_DATABASE_URL` 和 `SECRET_KEY`。连接串支持 PostgreSQL URI，也接受 Python 现有的 `postgresql+asyncpg://` 形式。

## 回归测试

Node 单元/HTTP 回归不读用户 `.env` 或真实数据库。要额外运行 PostgreSQL 集成回归，设置 `GUGU_WEBUI_TEST_DATABASE_URL` 指向可创建临时 schema 的测试数据库；测试仅使用随机 schema 和合成用户，并在结束时删除自己创建的 schema。
