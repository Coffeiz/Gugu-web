# gugu-webui Linux/NAS 部署版

`gugu-webui` 是 2.0 的独立 Node HTTP Host。它不启动 Python Web 进程；PostgreSQL 由外部服务提供。

当前实现范围包括启动配置、PostgreSQL schema readiness、健康检查、主站/Admin Vue 静态资源、公开站点配置、认证与部分项目/文件/日历/客户/通知 API，以及 Admin 配置读取、保存和 PostgreSQL/Redis 连接测试。Admin 配置继续写入 `config.override.json` 格式，原子替换并保留其他配置段；数据库连接异常时 Host 仍提供仅 Admin 配置入口，健康检查保持未就绪，保存连接信息后重启生效。Redis 地址由 `GUGU_WEBUI_REDIS_URL` 提供，密码可单独放在 `GUGU_WEBUI_REDIS_PASSWORD`；独立密码变量优先于 URL 密码和配置文件密码。静态资源来自 `apps/web/dist`，未迁移的业务 API/SSE、Worker 和 Python 行为仍在迁移中，因此当前构建用于开发验收，不作为完整 Web 替代版。

配置 Redis 时，Admin 认证版本和登录限流在实例间共享；Redis 认证版本不可用时返回 503。未配置 Redis 时使用单进程内存版本和限流，Host 重启会使旧 Admin token 失效，因此该模式只适用于单实例。Admin 审计写入失败不阻断登录。业务 API 需要 PostgreSQL；数据库不可用时只开放 Admin 配置界面和连接测试。未配置 Redis 时，注册的 fail-closed 限流和验证码能力不可用。

## Shell 沙盒

有咕咕 Shell 或网页终端需求的 Linux/NAS 部署使用原生 Web Host。管理员运行一次 [Bubblewrap 安装器](deploy/bubblewrap/README.md) 后，Web Host 自动探测标准运行根。默认使用断网沙盒，用户终端策略为「自动」。

## Docker Compose

Web Host 发布时包含同级的 `dist/` 和 `assets/`。对话、定时任务、管理员提示词编辑及 IM 维护共用 `assets/agent-prompts/`。运行服务账号需要对此目录有写权限，管理员保存的文本会用于后续运行。注册引导音频位于 `assets/onboarding/`。

运行配置默认位于 Web Host 包目录的 `config.override.json`，可用 `GUGU_CONFIG_OVERRIDE_FILE` 指定。Compose 使用持久卷中的文件。管理员保存需要部署预先提供合法的配置文件，首次配置可从空 JSON 对象开始。管理员日志默认从包目录的 `logs/` 读取，也可用 `GUGU_LOG_FILE` 指定 Web 日志。使用 BYOK 时，通过 `CREDENTIALS_MASTER_KEY` 或工作区外的 `CREDENTIALS_MASTER_KEY_FILE` 提供主密钥。已有加密凭据继续使用对应的原密钥。

在仓库根目录执行：

```sh
cp apps/web-host/.env.example apps/web-host/.env
```

编辑 `apps/web-host/.env`，设置与现有 Gugu JWT 一致的 `SECRET_KEY` 和 Admin 登录密码。PostgreSQL 连接地址可通过 `GUGU_WEBUI_DATABASE_URL` 提供，也可在 Admin 配置页首次录入。不要提交 `.env`。数据库应先通过仓库维护的 PostgreSQL schema bootstrap/migration 准备；readiness 会检查用户认证和业务 API 所需的表和列。配置页变更写入 Compose 持久卷中的 `config.override.json`，更新数据库或 Redis 后重启容器生效；Redis 密码建议单独设置 `GUGU_WEBUI_REDIS_PASSWORD`。

启动和检查：

```sh
docker compose --env-file apps/web-host/.env -f apps/web-host/deploy/compose.yaml up --build -d
docker compose --env-file apps/web-host/.env -f apps/web-host/deploy/compose.yaml ps
curl -fsS http://127.0.0.1:9595/health
curl -fsS http://127.0.0.1:9595/health/ready
```

`GUGU_WEBUI_PUBLISHED_PORT` 可改变宿主机端口，容器内服务固定监听 9595。数据库必须允许容器网络连接。 这份 Compose 模板运行 Web Host 应用，Shell 沙盒还取决于容器环境是否实际提供独立运行根、用户命名空间和 systemd 用户 scope。

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

本地运行必须设置 `SECRET_KEY` 和 Admin 登录密码。数据库连接可先设置 `GUGU_WEBUI_DATABASE_URL`，也可在 Admin 配置页首次录入；连接串使用标准 `postgresql://` 或 `postgres://` URI。

### 开发监听

日常开发执行 `corepack pnpm --filter @gugu/webui dev`。该命令监听 Web Host 源码，以及 Core、FS、Sandbox 的增量编译产物，并在变化后重启 Host；重启会中断正在执行的请求。首次缺少依赖制品时按命令提示初始化。启动时沿用进程已有环境变量，运行配置由开发者通过既有安全方式提供，不会改写配置文件。

共享包编译失败时先修复错误，旧制品不代表新代码；内置技能 Markdown 资源修改后需运行 Core 的资源构建脚本。部署和生产验收仍使用完整构建。

### Node Web Host 数据库迁移

使用 PostgreSQL 15 或更新版本。构建 Web Host 后，将 `GUGU_WEBUI_DATABASE_URL` 设为目标 schema 的标准 PostgreSQL URI，并按顺序初始化账号与偏好、会话与消息、待发送队列、交互提示、附件元数据、用量、RAG 重建队列，项目、日历、Mind、定时任务、工作区、文件与配额等 Web 就绪表，以及九张运行调度表和 RAG 派生索引。启动 Host 时使用相同的 schema。

```sh
corepack pnpm --filter @gugu/webui migrate:agent-base:apply
corepack pnpm --filter @gugu/webui migrate:web-domain:apply
corepack pnpm --filter @gugu/webui migrate:filesystem-authorization:apply
corepack pnpm --filter @gugu/webui migrate:security-events:apply
corepack pnpm --filter @gugu/webui migrate:terminal-sessions:apply
corepack pnpm --filter @gugu/webui migrate:agent-run:apply
corepack pnpm --filter @gugu/webui migrate:rag-index:apply
```

各组均提供 `check` 命令。检查只读，待迁移时输出 `pending` 并退出 2，结构损坏或出现未登记的同名表时退出 1。迁移在事务内完成，重复执行返回 `unchanged`。旧版业务数据在备份后通过显式导入进入 Node schema，RAG 派生索引由 Node 从授权来源重建。Web 业务迁移覆盖 `/health/ready`、首个账号注册与引导，以及当前 RAG 八类来源所需的 PostgreSQL 表。整站各可选功能的存储和部署另行验收。

默认启用的会话沙箱授权依赖授权表、安全审计表和完整终端会话表。已有 Node schema 可分别应用 `migrate:filesystem-authorization:apply`、`migrate:security-events:apply` 与 `migrate:terminal-sessions:apply`，无需重新初始化基础迁移。终端迁移要求账号、会话和工作区表已就绪；三组结构均按对应旧 Python Alembic 表定义创建，不导入旧数据。

Agent 附件快照使用独立 Node 迁移。构建 Host 后，可用 `migrate:agent-snapshot:check` 检查，再以 `migrate:agent-snapshot:apply` 显式应用。当前已有隔离数据库结构验证，快照业务读写、密钥轮换和部署恢复需单独验收。

## 回归测试

Node 单元/HTTP 回归不读用户 `.env` 或真实数据库。要额外运行 PostgreSQL 集成回归，设置 `GUGU_WEBUI_TEST_DATABASE_URL` 指向可创建临时 schema 的测试数据库；测试仅使用随机 schema 和合成用户，并在结束时删除自己创建的 schema。
