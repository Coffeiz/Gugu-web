# gugu-webui Linux/NAS 部署版

`gugu-webui` 是 2.0 的独立 Node HTTP Host。它不启动 Python Web 进程；PostgreSQL 由外部服务提供。

当前实现范围包括启动配置、PostgreSQL schema readiness、健康检查、主站/Admin Vue 静态资源、公开站点配置、认证与部分项目/文件/日历/客户/通知 API，以及 Admin 配置读取、保存和 PostgreSQL/Redis 连接测试。Admin 配置继续写入 `config.override.json` 格式，原子替换并保留其他配置段；数据库连接异常时 Host 仍提供仅 Admin 配置入口，健康检查保持未就绪，保存连接信息后重启生效。Redis 地址由 `GUGU_WEBUI_REDIS_URL` 提供，密码可单独放在 `GUGU_WEBUI_REDIS_PASSWORD`；独立密码变量优先于 URL 密码和配置文件密码。静态资源来自 `apps/ui/dist`，未迁移的业务 API/SSE、Worker 和 Python 行为仍在迁移中，因此当前构建用于开发验收，不作为完整 Web 替代版。

配置 Redis 时，Admin 认证版本和登录限流在实例间共享；Redis 认证版本不可用时返回 503。未配置 Redis 时使用单进程内存版本和限流，Host 重启会使旧 Admin token 失效，因此该模式只适用于单实例。Admin 审计写入失败不阻断登录。业务 API 需要 PostgreSQL；数据库不可用时只开放 Admin 配置界面和连接测试。未配置 Redis 时，注册的 fail-closed 限流和验证码能力不可用。

## Worker 默认值

每个 Web Host 进程只执行一个 Web 或 IM 对话 Run，交互确认恢复共用同一个席位。任务排队时由持久队列保管，轮到执行时再认领租约。IM 入站消费和历史维护分别以并发 1 运行。HTTP 请求、SSE 连接及各自串行的定时任务、索引和清理 Worker 继续独立运行。

## 浏览器后台提醒

Web 和日历提醒仍会进入站内通知中心。要让关闭网页的用户也能收到通知，请通过 HTTPS 提供 Web 站点，应用数据库迁移，并为同一部署的所有实例配置同一组 VAPID 密钥。用 `corepack pnpm --filter @gugu/webui exec web-push generate-vapid-keys` 生成一次密钥，然后通过部署的密钥管理配置：

- `GUGU_WEB_PUSH_PUBLIC_KEY` 和 `GUGU_WEB_PUSH_PRIVATE_KEY` 使用生成的公私钥。更换密钥后，浏览器需要重新订阅。
- `GUGU_WEB_PUSH_SUBJECT` 使用运维联系邮箱（`mailto:`）或 HTTPS 联系地址。

Web Host 需要能访问浏览器提供的公网推送服务。iOS 和 iPadOS 用户先将站点添加到主屏幕，再从主屏幕打开并启用推送。通知横幅只显示通用提示，正文需登录后在通知中心查看。浏览器或系统禁用通知时，可继续在站内查看提醒。

## Shell 沙盒

桌面与 WebUI 的授权职责和审批策略见 [Agent 权限与审批设计](../../docs/architecture/permissions.md)。

有咕咕 Shell 或网页终端需求的 Linux/NAS 部署使用原生 Web Host。管理员运行一次 [Bubblewrap 安装器](deploy/bubblewrap/README.md) 后，Web Host 自动探测标准运行根。默认使用断网沙盒，用户终端策略为「自动」。

咕咕聊天和命令式终端执行单条 `rm` 时，使用现有危险命令权限和一次性确认，将授权路径移入磁盘回收站。支持字面量文件路径、`--` 与短选项 `-r`、`-R`、`-f`，回收项可恢复并沿用 30 天保留期。请用文件库回收站执行永久删除。

咕咕可用 `delete_file(path)` 按沙盒映射路径回收文件。工具成功后返回回收项路径。使用 `list_trash` 查看磁盘回收站，再将返回的 `/trash/<回收项 UUID>` 路径传给 `restore_file`、`restore_folder` 或 `permanent_delete(path)`。永久删除也支持 `paths`（最多 50 项）和 `all=true`（清空）。确认期间回收项变化时，需要重新确认。写操作均需逐次确认，删除和恢复受会话挂载权限约束。文件记录无需在旧数据库登记。

脚本、解释器和无法识别为普通写入的组合命令使用只读挂载。可识别的普通写入（如 `mkdir`、`touch` 和工作目录内的重定向）仍可写入授权目录。交互式终端中的受管目录为只读。

系统 Shell 由 Web Host 管理，管理员与用户均开启后，模型可用 `scope=system` 申请以 Web Host 服务账号执行。普通模式首次确认后，同一会话在 30 分钟内可直接执行。自动模式与系统 Shell 同时开启时跳过逐条确认，管理员和用户的命令权限继续生效。临时授权保存在当前进程，重启后需要重新确认。

## Docker Compose

默认 Agent 提示词由 `@gugu/core` 的 `resources/prompts/` 随包发布。Web 对话、定时任务和 IM 维护优先读取文件存储根目录下的 `.agent-prompts/`，只有缺少覆盖文件时才读取 Core 默认值。管理员保存时只写覆盖目录。首次升级时，如果旧部署的 `assets/agent-prompts/` 仍可访问，会导入与默认值不同的内容，已有覆盖优先。容器替换前，可将自定义旧模板复制到持久化的 `.agent-prompts/` 并保持原文件名和子目录。

运行配置默认位于 Web Host 包目录的 `config.override.json`，可用 `GUGU_CONFIG_OVERRIDE_FILE` 指定。Compose 使用持久卷中的文件。管理员保存需要部署预先提供合法的配置文件，首次配置可从空 JSON 对象开始。Web Host 默认追加写入包目录的 `logs/gugu.log`，部署可用 `GUGU_LOG_FILE` 指定固定路径。Compose 将日志放在持久卷的 `/data/logs/`。常规日志与同目录下仅供服务器运维查看的 `gugu-diag.log` 各按 10 MiB 轮转并保留最近 10 份归档。Debug 页可以分页和搜索常规归档。Agent Run 与 Desktop 共用 `@gugu/log` 的 JSONL 事件、字段白名单和诊断格式。Run 失败时，常规和诊断记录通过同一 Run 指纹关联。 Node Gateway 的常规事件写入 `gugu-gateway.log`，Sandbox 和宿主生命周期事件写入 `gugu.log`。同一运行故障的常规记录与私有诊断通过 `incident` 关联。迁移时可将旧日志复制到同目录，以 `gugu.log.history-<13 位毫秒时间戳>-<64 位十六进制唯一标识>` 命名，自动轮转会保留这些迁移归档。BYOK 优先使用显式主密钥或工作区外的 `CREDENTIALS_MASTER_KEY_FILE`。Linux Web Host 默认读取 `GUGU_DATA_DIR/.byok-master-key`，未配置数据目录时使用 `$XDG_STATE_HOME/gugu/.byok-master-key`，再默认到 `~/.local/state/gugu/.byok-master-key`。首次保存凭据时自动创建，迁移已有凭据时须把原主密钥放入默认路径或显式指定原文件。

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

### 服务端目录

- `src/main.ts` 处理进程启动和退出信号，`src/startup/server.ts` 负责服务启动、就绪检查与资源关闭顺序。
- `src/app.ts` 创建 Fastify 应用并注册公共 HTTP 能力。用户路由由 `src/http/routes.ts` 装配，附件、会话、文件和管理端分别在所属模块注册。
- `src/modules/agent/` 按职责组织。会话在 `sessions/`，消息和队列在 `chat/`，运行与恢复在 `run/`，交互在 `interactions/`。附件、LLM、上下文、记忆、检索和工具各有目录。
- `src/modules/auth/` 按会话、注册、账号管理和用量拆为 `session/`、`registration/`、`account/`、`quota/`。路由和存储实现随业务归位。
- `src/startup/` 组合进程级依赖，包括登录、Agent 运行时、Mind 服务和后台任务。共享业务规则位于 Core。

### 开发监听

日常开发执行 `corepack pnpm --filter @gugu/webui dev`。该命令监听 Web Host 源码，以及 Core、Database、FS、Sandbox 的增量编译产物，并在变化后重启 Host；重启会中断正在执行的请求。首次缺少依赖制品时按命令提示初始化。启动时沿用进程已有环境变量，运行配置由开发者通过既有安全方式提供，不会改写配置文件。

共享包编译失败时先修复错误，旧制品不代表新代码；内置技能 Markdown 资源修改后需运行 Core 的资源构建脚本。部署和生产验收仍使用完整构建。

### Node Web Host 数据库迁移

使用 PostgreSQL 15 或更新版本。构建 Web Host 后，将 `GUGU_WEBUI_DATABASE_URL` 指向新数据库或新 schema。启动 Host 时使用同一个目标库和 schema。

```sh
corepack pnpm --filter @gugu/webui migrate apply
corepack pnpm --filter @gugu/webui migrate check
```

`check` 只读，待迁移时输出 `pending` 并退出 2。`apply` 按编号在同一事务执行，重复执行返回 `unchanged`。缺少登记的业务表、迁移记录异常或结构漂移会报错。已有开发库需要保留时，给 2.0 使用新的数据库或 schema。完整目录和扩展约定见 [数据库迁移](../../packages/database/README.md)。

## 回归测试

Node 单元/HTTP 回归不读用户 `.env` 或真实数据库。要额外运行 PostgreSQL 集成回归，设置 `GUGU_WEBUI_TEST_DATABASE_URL` 指向可创建临时 schema 的测试数据库；测试仅使用随机 schema 和合成用户，并在结束时删除自己创建的 schema。

用户记忆正文位于用户存储目录下的 `.agent/memories/`，IM 记忆按平台及会话范围存于其 `im/` 子目录。开发版直接使用新路径。
