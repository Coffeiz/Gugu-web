# gugu-webui Linux/NAS 部署版

`gugu-webui` 是 2.0 的独立 Node HTTP Host。它不启动 Python Web 进程；PostgreSQL 由外部服务提供。

当前实现范围包括启动配置、PostgreSQL schema readiness、健康检查、主站/Admin Vue 静态资源、公开站点配置、认证与部分项目/文件/日历/客户/通知 API，以及 Admin 配置读取、保存和 PostgreSQL/Redis 连接测试。Admin 配置继续写入 `config.override.json` 格式，原子替换并保留其他配置段；数据库连接异常时 Host 仍提供仅 Admin 配置入口，健康检查保持未就绪，保存连接信息后重启生效。Redis 地址由 `GUGU_WEBUI_REDIS_URL` 提供，密码可单独放在 `GUGU_WEBUI_REDIS_PASSWORD`；独立密码变量优先于 URL 密码和配置文件密码。静态资源来自 `frontend/dist`，未迁移的业务 API/SSE、Worker 和 Python 行为仍在迁移中，因此当前构建用于开发验收，不作为完整 Web 替代版。

Admin 登录的认证版本和限流由单个 Node Host 进程内维护；登录认证不依赖 Redis 或 PostgreSQL 查询，审计写入失败也不会阻断登录。Host 重启会使旧 Admin token 失效，因此当前自托管部署按单实例运行。业务 API 需要 PostgreSQL；数据库不可用时只开放 Admin 配置界面和连接测试。未配置 Redis 时，注册的 fail-closed 限流和验证码能力不可用。

## Docker Compose

在仓库根目录执行：

```sh
cp gugu-webui/.env.example gugu-webui/.env
```

编辑 `gugu-webui/.env`，设置与现有 Gugu JWT 一致的 `SECRET_KEY` 和 Admin 登录密码。PostgreSQL 连接地址可通过 `GUGU_WEBUI_DATABASE_URL` 提供，也可在 Admin 配置页首次录入。不要提交 `.env`。数据库应先通过仓库维护的 PostgreSQL schema bootstrap/migration 准备；readiness 会检查用户认证和业务 API 所需的表和列。配置页变更写入 Compose 持久卷中的 `config.override.json`，更新数据库或 Redis 后重启容器生效；Redis 密码建议单独设置 `GUGU_WEBUI_REDIS_PASSWORD`。

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

本地运行必须设置 `SECRET_KEY` 和 Admin 登录密码。数据库连接可先设置 `GUGU_WEBUI_DATABASE_URL`，也可在 Admin 配置页首次录入；连接串支持 PostgreSQL URI 和 Python 现有的 `postgresql+asyncpg://` 形式。

## 回归测试

Node 单元/HTTP 回归不读用户 `.env` 或真实数据库。要额外运行 PostgreSQL 集成回归，设置 `GUGU_WEBUI_TEST_DATABASE_URL` 指向可创建临时 schema 的测试数据库；测试仅使用随机 schema 和合成用户，并在结束时删除自己创建的 schema。
