# PRD-ADMIN-2：Docker 部署更新与版本分发

> 状态：一体化 Compose、分体 Compose 与纯 Docker 单容器更新均已实现；manifest v3 为唯一支持格式，不保留 v2 兼容。Docker Hub 为更新主源，GHCR 同步发布，镜像使用 OCI 1.1 referrer 签名。默认 Compose 使用 app 内置 PostgreSQL/Redis，旧拓扑迁移必须同时保留数据库和 Redis Stream 状态。
> 创建：2026-08-31
> 最近更新：2026-09-20
> 关联模块：`docker-compose.yml`、`docker-compose.prod.yml`、`.github/workflows/`、`deploy/`、`scripts/release/`、`backend/updater/`、`frontend/src/views/Admin/Updates/`
> 背景参考：`PRD-ADMIN-1-Admin咕咕球管理助手.md`、`docs/ops/deploy.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 一体化 Compose 更新 | 已实现 | ✅ 已确认 | 默认 `docker-compose.yml` 由受限 updater RPC 更新 `app`；仅在运行中的 `sandboxd` 使用同一 app 镜像时同步更新。 |
| 镜像发布策略 | 一体化与拆分业务镜像均双发 | ✅ 已确认 | 一体化 `gugu-web`、backend/frontend、sandbox 均发布到 Docker Hub 与 GHCR；只发布语义版本号标签，不发布 Git SHA 镜像标签；稳定版维护 `latest`。 |
| GitHub Release 更新清单 | manifest v3 | ✅ 已确认 | Schema、CI 发布清单、无依赖校验器与 updater 均只接受完整镜像组；v2 不再接受。 |
| Docker 发布 CI | Workflow 已实现 | ✅ 已确认 | 版本 tag 构建并扫描四类镜像，使用 Cosign OCI 1.1 referrer 签名后发布到双仓；旧式 `.sig` 标签仅为历史遗留，不再新增。 |
| 分体 Compose 更新 | 已实现 | ✅ 已确认 | `docker-compose.prod.yml` 由独立 updater RPC 服务执行；业务容器不挂 Docker Socket。 |
| 纯 Docker 单容器更新 | 已实现 | ✅ 已确认 | 无 Compose 项目时由短期 helper 执行，要求受支持的一体化镜像、内嵌依赖和持久数据挂载。 |
| Admin 部署模式识别 | 已实现 | ✅ 已确认 | 识别 integrated/split Compose 与 standalone Docker，并说明配置关闭、RPC 不可用及拓扑无效等原因。 |
| Admin 检查和执行更新 | 已实现 | ✅ 已确认 | 检查、预检、确认、审计和任务状态覆盖受支持的三类部署。 |
| 更新服务与回滚 | 已实现 | ✅ 已确认 | Compose updater sidecar 与单容器短期 helper 按各自拓扑执行；回滚范围不包含不可逆数据库迁移。 |

## 1. 背景与目标

咕咕的普通用户不应该下载 Git 源码、安装前端/后端依赖或在本机重新构建镜像。对于 Docker Compose 部署，更新应当直接获取经过 CI 构建和验证的业务镜像，以降低安装门槛、减少本地磁盘消耗，并保证所有用户使用一致的构建产物。

本 PRD 定义咕咕普通用户 Docker 部署的标准更新链路：GitHub 负责代码、Release 和更新说明，Docker Hub 的公开一体化 `gugu-web` 是更新主来源，GHCR 镜像该应用；拆分 backend/frontend 业务镜像同步发布到 Docker Hub 与 GHCR，供业务服务器按语义版本号拉取。Admin 负责展示和确认，Compose updater 服务负责在服务器执行一体化或分体更新，单容器部署则使用短期 helper。

目标：

- 对受支持的 Docker 部署，用户只需在 Admin 中检查和确认更新；暂不支持的部署必须说明原因和手动更新路径。
- 更新使用固定版本和镜像 digest，不使用 `latest` 作为生产事实源。
- 更新前自动检查磁盘、配置、数据库状态和当前运行版本。
- 数据卷、`backend/.env`、`config.override.json`、PostgreSQL、Redis、用户文件和记忆数据不因更新被删除。
- 数据库迁移、容器健康检查和失败回滚成为标准流程。
- 支持管理员查看版本说明、更新进度、失败原因和恢复建议。

### 1.1 定位修订（2026-09-14）

一体化部署的产品定位是**个人用户自己下载、自己更新，简单易用优先**。当前实现由同镜像的受限 updater 服务持有 Docker Socket：

- 一体化与分体 Compose 均通过私有 Unix Socket RPC 调用 updater；业务 app/backend 不挂载 Docker Socket。updater 只接收固定 RPC 方法，并由服务端执行 manifest、签名、部署拓扑和预检校验。
- 默认一体化 Compose 的 PostgreSQL/Redis 在 app 镜像内运行，避免额外依赖容器。由旧默认 Compose 升级时，必须先停止旧 app，再导出 PostgreSQL 和 Redis RDB 快照；新 app 对旧卷只读探测，缺少备份时 fail-closed，绝不悄悄创建空数据库或丢弃旧 Stream 队列。
- `docker-compose.prod.yml` 分体部署与无 Compose 的纯 Docker 单容器也有各自受限执行路径；不能仅因挂载 Docker Socket 就视为受支持。单容器 helper 只在操作期间持有 Socket。
- Docker Socket 仍可控制宿主机容器，因此只授予 updater/sandboxd 等确有需要的服务；更新能力不进入 Agent 工具注册表，必须由管理员授权并通过一次性确认门。
- 保留：manifest 与 digest 白名单（仅允许官方 coffeiz/gugu-web 镜像）、预检、一键回滚、审计。发布端继续同步 Docker Hub 与 GHCR；manifest 本身不单独签名，目标镜像使用 Cosign OCI 1.1 referrer 签名，更新前由固定 Cosign verifier 校验。
- 分体部署（`docker-compose.prod.yml`）当前不受既有一体化更新入口支持；本 PRD 将其列入目标部署模式，并要求使用独立的执行边界。

本 PRD 不包含：

- 不支持普通用户从 GitHub 下载源码后自动构建。
- Docker Socket 不进入 Agent 工具注册表与模型可见能力；一体化/分体 app 容器不直接挂载 socket，受限 updater sidecar 或短期单容器 helper 按拓扑执行更新。
- 不允许更新助手执行任意 Shell、任意 Compose 文件或任意镜像地址。
- 不在首版覆盖源码开发模式、桌面安装包、Kubernetes 或非 Docker 部署。
- 不允许更新过程中删除业务数据卷或自动清理所有旧镜像。

## 2. 功能需求

### FR-UPD-001：版本检查

Admin 可以查看当前运行版本、构建提交、镜像 digest、数据库迁移版本、部署模式和运行环境，并手动检查是否有新版本。

更新检查读取固定格式的 manifest。首版可以直接读取 GitHub Release 资产或固定的公开 manifest URL；正式部署应支持通过配置指定镜像源和 manifest 镜像，避免依赖 GitHub API 限流。

无更新、存在更新、当前版本过旧、无法连接更新源和 manifest 校验失败必须分别展示，不得统一显示为“暂无更新”。

### FR-UPD-002：GitHub Release 与 Docker Hub / GHCR 分工

每次正式版本发布必须生成一份 GitHub Release，包含用户可读的更新说明、兼容要求、数据库迁移说明、已知问题和回滚提示。

Release 同时关联一份 `update-manifest.json`，其中记录：

```json
{
  "schema_version": 3,
  "version": "0.4.0",
  "channel": "stable",
  "minimum_version": "0.3.0",
  "app_image": "docker.io/coffeiz/gugu-web@sha256:...",
  "split_images": {
    "backend_image": "docker.io/coffeiz/gugu-web-backend@sha256:...",
    "frontend_image": "docker.io/coffeiz/gugu-web-frontend@sha256:..."
  },
  "architectures": ["linux/amd64", "linux/arm64"],
  "database_migration": true,
  "release_notes_url": "https://github.com/Coffeiz/Gugu-web/releases/tag/v0.4.0",
  "rollback_supported": true
}
```

GitHub Release 是版本和说明来源；Docker Hub 是公开一体化应用的更新主来源，GHCR 镜像同一个 `gugu-web`；拆分 backend/frontend 业务镜像同步发布到两个 registry。manifest v3 是唯一可接受版本，统一包含 app 与 backend/frontend digest；更新器严格校验仓库白名单与不可变 digest，并在预检阶段校验目标镜像的 Cosign OCI 1.1 签名，不接受聊天消息或前端输入的任意镜像地址。v2 manifest 明确拒绝，不提供兼容读取。

### FR-UPD-003：更新预检

执行更新前必须完成预检，并展示结果：

- 当前部署由 Compose 管理，且 Compose 文件版本兼容。
- Docker daemon 可用，磁盘空间足够保存新旧镜像和临时层。
- PostgreSQL、Redis 和一体化 app 服务当前状态可读取。
- 配置文件和持久化卷存在且可读写。
- 当前数据库迁移状态正常，没有未完成或冲突迁移。
- 目标镜像架构与宿主机匹配，digest 和 OCI 1.1 镜像签名校验通过。
- 当前没有正在执行的更新任务。

预检失败时只能查看原因和修复建议，不能继续执行覆盖更新。

### FR-UPD-004：备份与更新执行

管理员明确确认后，更新器按以下顺序执行：

1. 锁定更新任务，防止并发执行。
2. 备份必要的配置和数据库元信息；业务文件卷只做存在性和容量校验，不复制整份大文件卷。
3. 拉取 manifest 指定的 `gugu-web` 一体化镜像 digest。
4. 保留当前版本的 Compose 变量和用户配置，只替换业务镜像引用。
5. 启动迁移任务并等待成功。
6. 重新创建一体化 `app` 容器；若运行中的 `sandboxd` 也使用该一体化镜像，则同步重建。
7. 等待 app 健康检查及 API 状态恢复。
8. 记录新版本、镜像 digest、迁移结果和耗时。

PostgreSQL、Redis、`pgdata`、`gugu_data`、`gugu_config`、用户上传内容和记忆数据不得被 `down -v`、无条件 prune 或 Compose 重建删除。

### FR-UPD-005：失败恢复与回滚

迁移失败、镜像启动失败、健康检查超时或关键服务异常时，更新器必须停止继续推进并保留诊断摘要。若数据库迁移不可逆或新版本明确不支持回滚，必须在预检阶段阻止更新。

可回滚版本需要保留上一组镜像引用、Compose 变量和更新前迁移状态。回滚只能恢复应用镜像和容器编排；已经执行的数据库迁移必须由版本提供向后兼容策略或独立的回滚迁移处理，不能假设切回旧镜像就能自动恢复数据库。

### FR-UPD-006：Admin 交互

Admin 咕咕球和更新页面均可调用更新能力，但交互必须保持一致：

- 检查更新：只读，不需要确认。
- 查看变更：打开 GitHub Release 说明或内嵌摘要。
- 开始更新：展示版本、镜像、迁移、预计影响和回滚能力，必须确认。
- 更新中：显示阶段状态，不允许重复触发。
- 完成/失败：展示结果、审计编号、健康状态和下一步建议。

更新期间应提示管理员不要关闭浏览器不会影响任务继续执行；状态由服务端持久化，重新进入 Admin 后可以恢复查看。

### FR-UPD-007：渠道与版本策略

首版支持 `stable` 一个渠道。后续可增加 `beta`，但不同渠道必须使用不同 manifest 和镜像 tag/digest，不能让测试版本覆盖 stable。

对外镜像只发布语义版本号标签；Git SHA 仅保留在 manifest 和构建元数据中，用于追踪、审计和回滚定位，不再作为镜像标签发布。

### FR-UPD-008：可选组件边界

现有一体化 Compose 更新只拉取并重建 `gugu-web` app；分体 backend/frontend 镜像由 FR-UPD-010 定义独立更新策略。PostgreSQL、Redis、SearXNG 和其他基础服务默认不随业务版本更新，只有它们被明确纳入发布且经过兼容性验证时才可更新。

Shell sandbox 是可选 profile。普通更新不因为用户未开启 sandbox 而拉取 Debian 或 sandbox 运行镜像；只有管理员明确开启或更新 sandbox profile 时，才执行对应的镜像预检和拉取。

### FR-UPD-009：部署模式识别与能力说明

更新状态接口必须识别并返回当前部署模式、更新能力、不可用原因和推荐操作。至少区分 `integrated_compose`、`split_compose`、`standalone_container`、`unsupported`；能力状态至少区分 `available`、`manual_only`、`disabled`、`misconfigured`。部署识别依据必须来自经过校验的 Compose 服务集合、容器标签/运行配置和明确的部署标识，不能只根据镜像名或页面来源推测。

Admin 页面必须按状态渲染：可更新部署展示检查/预检/确认操作；暂不支持自动更新的部署展示具体原因与对应手动更新说明；显式关闭更新、受限 updater/RPC 不可用、Compose 文件缺失/无效、更新器初始化失败分别给出不同状态。不得将 `sandboxd` 未运行解释为 app 更新不可用。

页面文案必须与实际架构一致，不得把 app 内置执行器称为 sidecar。沙盒说明仅在相关部署确有可选 `sandboxd` 服务时展示，并明确它只决定是否联动更新沙盒服务，不是更新 app 的前置条件。

### FR-UPD-010：分体 Compose 更新

Admin 更新器必须支持本仓库标准 `docker-compose.prod.yml` 分体部署。更新前识别并校验 Compose 项目中的 `backend`、`frontend`、`worker`、`gateway`、`migrate`、`nginx` 及其依赖；缺少必需服务、镜像仓库不受信任、配置无法解析或项目状态不一致时阻止更新并说明原因。

一次发布 manifest 必须提供该版本完整、不可变的分体镜像集合：backend 镜像供 backend、worker、gateway、migrate 和使用同一镜像的 sandboxd 使用；frontend 镜像供 frontend 使用。nginx、PostgreSQL、Redis、SearXNG、egress proxy 等基础镜像默认不随业务版本更新。可选 sandboxd 仅在运行中且其镜像确实跟随 backend 版本时联动重建。

管理员确认后，更新器必须校验并拉取所有目标镜像，先备份数据库和必要配置，再执行迁移，按安全依赖顺序重建业务服务，并检查 API、静态页面、worker/gateway 进程以及数据库连通性。不得覆盖部署目录的 `.env`、`backend/.env`、Compose 文件或持久化数据。不得使用 `down -v`、无范围清理或擅自升级基础服务。

### FR-UPD-011：纯 Docker 单容器自主更新

Admin 更新器必须支持本仓库定义的纯 Docker 单容器部署，不要求 Compose 文件。只接受经过识别和校验的 Gugu 官方一体化容器；更新目标必须来自通过 schema、digest、签名、架构和版本兼容性校验的 manifest，不能接受用户或模型提供的任意镜像、命令、容器名或挂载路径。

更新前必须从 Docker daemon 检查运行容器身份、镜像、数据/配置挂载、端口、网络、重启策略和启动参数是否满足受支持配置。必要配置缺失、匿名数据卷、配置无法安全复现、容器不属于受支持版本/布局或 daemon 不可用时，必须拒绝自动更新并给出面板手动更新/迁移指引。

更新执行必须由独立于待替换 app 生命周期的 helper 完成交接；先完成数据库一致性检查与备份，再拉取新镜像，按原受支持配置创建替代容器并执行健康检查。只有新容器通过健康检查后才能确认成功；启动或健康检查失败时须恢复旧容器及原配置，并保留备份和诊断状态。不得删除或重建用户数据卷，不得把镜像更新误当作数据库回滚。

对于数据库布局迁移、不可逆 Alembic 变更、旧版内嵌 PostgreSQL/Redis 或当前无法证明向后兼容的版本，必须在预检阻止自动更新，要求先按迁移文档完成迁移；不得以“可以启动旧镜像”推定旧数据库可安全回滚。

### FR-UPD-012：共享更新契约与执行边界

三种更新路径共享版本检查、manifest/schema 校验、镜像签名验证、版本策略、管理员身份与一次性确认、审计、任务状态展示和版本说明；部署检测与 Docker/Compose 操作由各自 adapter 负责。一个 adapter 失败不得静默回退到另一种部署策略。

访问 Docker socket 等同授予宿主 Docker daemon 的高权限能力。只有专用更新执行边界可以访问 socket；分体部署不得为方便将 socket 加给公网 API、worker 或 gateway。执行器与 Admin API 间必须使用受限本地 IPC/等效认证通道，校验调用方、操作类型和任务确认令牌。

## 3. 技术方案

### 3.1 发布流水线

新增 GitHub Actions 发布流水线，触发条件为受保护的版本 tag，例如 `v0.4.0`：

```text
版本 tag
  → 一体化 gugu-web 与拆分 backend/frontend 构建
  → 单元测试、类型检查和镜像安全扫描
  → gugu-web 与 backend/frontend 推送 Docker Hub 与 GHCR
  → 获取 Docker Hub gugu-web digest
  → 生成 update-manifest.json，并对发布镜像生成 OCI 1.1 referrer 签名
  → 创建 GitHub Release
```

镜像发布语义版本号标签并记录不可变 digest；稳定版继续维护 `latest` 别名以兼容默认 Compose 部署，但生产 manifest 和回滚依据必须使用 digest。不得发布 Git SHA 镜像标签。

发布流水线必须记录构建来源、依赖锁文件摘要、Git SHA、目标架构和镜像 digest。未经流水线验证的本地镜像不能进入 stable manifest。

### 3.2 更新源与 manifest

更新器首先读取配置中的 manifest 地址。默认地址可以指向 GitHub Release 资产；当 GitHub API 不稳定或有速率限制时，改用固定 CDN/静态站点地址，内容仍由同一发布流水线生成。

Manifest 必须通过 HTTPS 获取，并校验：JSON Schema、版本格式、镜像仓库白名单、digest 格式、最低版本、架构和有效期。仅接受 v3，必须包含 app 与 backend/frontend 完整镜像组；v2 明确拒绝。目标镜像签名由固定 digest 的 Cosign verifier 单独校验；旧式 `sha256-<digest>.sig` 普通 tag 不属于当前发布格式。更新器不得跟随未经校验的重定向。

### 3.3 更新执行器

共享更新核心位于 `backend/updater/`，继续由 Admin API 通过受限 client 调用；部署专属 adapter 负责实际执行。一体化与分体 Compose 均使用仅 updater 可访问 Docker socket 的受限执行服务，app/backend 通过受限 Unix socket RPC 调用；纯 Docker 单容器通过短生命周期 helper 在 app 生命周期之外完成替换。

更新器只开放固定动作：检查状态、拉取已校验 manifest、执行预检、开始更新、查看进度、查看结果、回滚指定上一版本。它不接受任意 Docker 命令、任意 registry 或任意宿主机路径。每种 adapter 只能操作其白名单部署对象与服务集合。

更新任务采用持久化状态机：`pending`、`prechecking`、`backing_up`、`pulling`、`migrating`、`recreating`、`health_checking`、`succeeded`、`failed`、`rollback_required`。每个阶段都写入开始时间、结束时间、结果和脱敏错误摘要。

### 3.4 权限与确认

更新接口只允许 Admin Token 访问；服务端不信任前端传来的角色、版本或镜像地址。开始更新属于 destructive 运维操作，必须经过统一确认门，并使用绑定操作者、目标版本、manifest digest 和有效期的一次性确认令牌。

所有更新、回滚、预检失败和校验失败均写入 Admin 审计日志。日志不包含密码、Token、Cookie、API Key、完整环境变量或用户聊天内容。

### 3.5 配置与数据保护

更新器只读解析部署配置，保留用户的 `.env`、`backend/.env`、Compose 文件、容器环境配置和持久化卷。不得将目标镜像写回用户配置；通过进程级受限覆盖值将通过验签的 digest 交给执行器。更新过程禁止自动执行 `docker compose down -v`、无范围 `docker system prune` 或删除卷。

Compose 数据库备份和迁移须在业务容器重建前完成；standalone 数据库备份须在停止旧 app 前完成且验证备份可读。迁移文件必须幂等，回滚兼容要求在发布元数据和说明中明确；任何数据库恢复都必须是显式、可审计的操作，不以切换镜像隐式还原数据库。

### 3.6 多部署模式更新边界

更新核心负责发布元数据/manifest 校验、签名验证、版本策略、确认令牌、审计和任务状态；按部署模式分派到专用 adapter。`integrated_compose` adapter 按 app 内嵌依赖或外置依赖拓扑执行预检，并从配置的 Compose 文件名读取项目；不得假定所有一体化部署都存在 `postgres`、`redis` 服务。

分体 Compose 使用受限 updater 执行边界管理 `docker-compose.prod.yml` 项目；Docker socket 只挂载给该边界，backend API 通过带认证的内部 IPC 提交固定类型任务。部署目录、Compose 文件和 env 文件由用户持有且只读检查；镜像 digest 通过临时进程环境或受限覆盖配置传入，不原地改写用户 `.env`。

纯 Docker 单容器由 app 在确认后启动短生命周期 helper；helper 必须先持久化任务交接状态，再替换旧 app，不能依赖旧容器内进程完成自身重建。helper 仅获得完成更新所需的 Docker socket、受保护的状态/备份目录和被明确识别的数据挂载；不得挂载整个宿主根目录或将原始容器环境变量写入可见日志。敏感启动配置按最小暴露原则传递，并在任务结束后清除临时副本。

### 3.7 Manifest 兼容与镜像集合

仅接受 v3 manifest，至少表达 unified app digest、split backend/frontend digest、支持架构、最低版本、数据库迁移兼容声明、发布说明和回滚能力。v2 不保留兼容。每个可执行镜像均须独立校验官方仓库白名单、不可变 digest、发布工作流身份签名和目标架构。缺少当前部署所需任一镜像时，不得部分更新。

纯 Docker 单容器使用 unified app 镜像产物，但其运行方式、数据库布局和升级兼容性由 standalone adapter 判定；相同镜像不代表相同迁移或回滚策略。

### 3.8 相关文件与目录树

```text
Gugu-web/
├── .github/
│   └── workflows/
│       └── docker-release.yml                         # 【修改】发布 unified/split 镜像 digest 并生成新 manifest
├── backend/
│   ├── app/
│   │   ├── api/v1/
│   │   │   └── admin_update.py                        # 【修改】返回部署能力与明确原因，统一 Admin 更新入口
│   └── updater/
│       ├── daemon.py                                  # 【修改】共享状态机与 adapter 调度
│       ├── client.py                                  # 【修改】按部署形态连接受限执行边界
│       ├── deployment.py                              # 【新增】识别、校验部署形态
│       ├── manifest.py                                # 【新增】多镜像 manifest 校验与目标选择
│       └── adapters/
│           ├── integrated_compose.py                  # 【新增】从现有流程抽取一体化 Compose adapter
│           ├── split_compose.py                       # 【新增】分体 Compose 更新和恢复
│           └── standalone_docker.py                  # 【新增】单容器快照、handoff 与回滚
├── backend/tests/
│   ├── test_updater_deployment.py                    # 【新增】部署识别与能力状态
│   ├── test_updater_split_compose.py                 # 【新增】分体更新失败边界与配置保护
│   └── test_updater_standalone.py                    # 【新增】容器重建、挂载保留和回滚
├── docker-compose.prod.yml                            # 【修改】新增受限 updater 与内部 IPC，不给业务容器 Docker socket
├── docker-compose.yml                                 # 【条件】仅在 adapter 抽取要求调整接线时修改，保持兼容
├── deploy/
│   └── update-manifest.schema.json                    # 【修改】仅接受 v3 并校验多部署镜像组
├── scripts/release/
│   ├── compose-update.sh                              # 【修改】保持旧入口兼容或委托 adapter
│   ├── standalone-update.sh                            # 【新增】helper 内固定单容器替换流程
│   └── validate-update-manifest.mjs                   # 【修改】校验多镜像集合及各 digest
├── frontend/src/
│   ├── services/adminUpdate.ts                        # 【修改】部署能力状态类型与 API
│   └── views/Admin/Updates/                           # 【修改】按 mode/capability 显示操作与指引
└── docs/ops/deploy.md                                 # 【修改】记录三种部署模式的更新、限制和恢复
```

文件职责边界：CI 负责构建、签名、发布镜像组和 manifest；共享 updater 负责版本/任务/权限契约，各 adapter 只操作已识别的部署对象；Admin API 负责鉴权、调度和状态。部署文件与用户配置由部署环境持有，更新器不得反向覆盖。文件树是实施边界，不要求为满足树形结构而新增可由既有模块承担的文件。

## 4. 验证与上线

验收重点：

- 从 GitHub Release 获取 manifest v3；v2 必须被拒绝，v3 的每个部署镜像组均能按 digest 拉取并通过 Cosign 验签。
- 使用旧版本 Compose 配置更新到新版本，用户配置、数据库、文件和记忆数据保持不变。
- 一体化 app 更新后，API、页面、SSE、worker、gateway 和 Admin 均恢复正常。
- 预检能拦截磁盘不足、架构不匹配、manifest 无效、digest 不匹配、迁移异常和并发更新。
- 未开启 sandbox 的部署不会拉取或启动 sandbox profile 镜像。
- 三种部署模式均被正确识别；不支持或配置错误时展示具体原因，不把 `sandboxd` 状态当作 app 更新能力。
- 分体更新验证全部目标镜像签名和 digest；迁移失败时不重建业务服务，且不修改用户 Compose/env 文件。
- 单容器更新验证 Docker socket 缺失、匿名卷、非官方容器、配置无法复现、备份失败、helper 中断、新容器启动失败和健康检查失败；失败路径恢复旧容器且保留数据卷。
- 不支持的数据库迁移/版本组合在任何镜像替换前被预检拦截。
- 更新失败可以保留现场并给出可执行恢复建议；支持回滚的版本能恢复上一组业务镜像。
- 普通用户无法访问更新接口；Admin 更新操作可在审计日志中完整追踪。

发布前使用临时 Compose 项目验证新旧版本升级、空数据库初始化、已有数据库迁移、迁移失败、容器启动失败、磁盘不足和回滚场景。先在 dev/staging 验证，再向 stable 用户开放。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| Docker Hub 不可达 | 无法检查或拉取标准更新 | 明确提示更新源不可用；GHCR 的同 digest 一体化镜像可作为显式受控来源，不在校验失败时自动改写 registry。 |
| 镜像 tag 被覆盖 | 回滚到错误构建 | 生产只消费 digest，tag 仅用于展示和检索。 |
| 数据库迁移不可逆 | 新镜像回滚后数据不兼容 | 发布前检查迁移策略，manifest 标注回滚能力，必要时阻止回滚。 |
| app 拥有 Docker Socket 权限 | app 被 RCE 后可能控制宿主机容器 | 默认仅一体化 app 挂载；可用 `GUGU_SELF_UPDATE=off` 关闭；更新能力不进入 Agent 工具注册表，并使用 Admin 权限、一次性确认、命令/镜像/路径白名单。 |
| 部署类型识别错误 | 使用错误镜像集合或 Compose 服务范围，可能造成停机或数据风险 | 以明确部署标识和完整运行拓扑交叉验证；存在歧义时只读展示，不允许更新。 |
| 分体更新组件获得 Docker Socket | backend/API 漏洞可能扩展为宿主容器控制 | socket 只进入受限 updater 执行边界；通过内部认证 IPC 调用，不挂载给 backend、worker、gateway。 |
| standalone 更新时 handoff 失败 | 更新中断或新旧容器争抢端口 | 先持久化 handoff 和受支持配置快照；helper 独立运行；验证状态机恢复及旧容器恢复路径。 |
| 单容器数据库迁移不可逆或布局不兼容 | 回滚镜像后数据结构无法被旧版读取 | 发布兼容矩阵；不满足兼容承诺时预检拒绝自动升级，要求先完成文档化迁移。 |
| 新旧镜像同时占用磁盘 | 更新中途空间不足 | 预检估算空间，成功后只清理明确确认的旧业务镜像，不清理数据卷。 |
| sandbox 可选依赖被误拉取 | 用户磁盘和下载时间增加 | sandbox 使用独立 Compose profile，普通更新不处理。 |

待确认事项：

- Docker Hub 匿名拉取限额及镜像可用性监控策略。
- 是否首版只支持 `linux/amd64`，还是同时构建 `linux/arm64`。
- 更新 manifest 后续是否同步到独立 CDN。
- 失败后是否首版自动回滚，还是先停在 `rollback_required` 由管理员确认。
- Admin 更新是否允许跨环境操作，还是每个部署实例只能更新自身环境。
- standalone helper 的最小镜像构成、Docker API 最低版本及可复现容器配置白名单。
- 分体服务更新的停机策略：默认滚动/分批重建是否可行，或首版接受短暂停机并明确窗口。
- 当前单容器版本中内嵌 PostgreSQL/Redis 的可自动升级范围，以及不兼容旧版的明确切断版本。

## 6. 唯一实施 TODO

### Phase 1：发布物与手动更新基础

- [x] `UPD2-001` 固定版本、镜像命名、架构和 manifest Schema；验收：manifest Schema 与无依赖校验器已实现，能表达版本、最低版本、镜像 digest、迁移和回滚字段，并通过本地校验。
- [x] `UPD2-002` 建立 GitHub Actions Docker 发布流水线；验收：Workflow 版本 tag 构建一体化 app、backend/frontend 和 sandbox 镜像，全部推送 Docker Hub 和 GHCR，不发布 Git SHA 镜像 tag，镜像使用 OCI 1.1 referrer 签名（不额外生成 `.sig` 普通 tag），生成 Docker Hub app digest 和 GitHub Release。
- [x] `UPD2-003` 增加镜像签名、manifest 白名单和 digest 校验；验收：发布 Workflow 对镜像生成 Cosign OCI 1.1 referrer 签名，更新器校验 manifest v3、镜像 digest、发布者身份和完整镜像组；不接受 v2 或非白名单镜像。
- [x] `UPD2-004` 补齐 Docker Compose 升级、迁移和配置保护脚本；验收：更新脚本备份配置和数据库，保留 PostgreSQL、Redis、用户文件、记忆、工作区和 Admin 配置卷，并明确禁止 `down -v` 和无范围清理。

### Phase 2：Admin 检查与受限执行

- [x] `UPD2-005` 实现 app 内置 updater 状态 API 和持久化任务状态机；验收：进程内 client、原子状态文件、任务互斥、重启中断恢复；预检覆盖服务、数据库迁移 head、数据/配置卷、镜像架构、磁盘、最低版本和镜像签名；本地 updater 状态测试通过。
- [x] `UPD2-006` 接入 Admin 版本检查、Release 说明和更新确认流程；验收：Admin 更新页展示当前/目标版本、说明、预检和任务状态；更新/回滚使用操作者与目标绑定、十分钟有效的一次性确认；类型检查、i18n 测试和生产构建通过。
- [x] `UPD2-007` 实现更新后健康检查和失败恢复；验收：Compose 更新成功后再次检查 app API 与 PostgreSQL，失败进入 `rollback_required` 并保留上一版本镜像引用；回滚需管理员再次确认，且明确提示不会逆转数据库迁移。
- [x] `UPD2-008` 完成 dev/staging 灰度和审计验收；验收：普通用户无权更新，Admin 操作可审计，未运行 sandbox 的部署不会拉取或重建 sandbox 服务；已用旧版本 Compose 在 devserver 完成升级验证。

> Phase 1/2 验证完成：updater 单元测试、manifest/Compose 更新脚本测试、前端类型检查、i18n 测试、生产构建，以及 devserver 旧版本 Compose 升级、权限、审计和 sandbox 边界验证均已通过。Docker Hub/GHCR 发布镜像的 OCI 1.1 referrer 签名已在 v1.2.3 发布中核验；历史 `.sig` 普通 tag 不再作为新发布产物。

### Phase 3：可靠性增强（暂缓）

- 暂不实施 `UPD2-009`：离线/CDN manifest、多平台构建与可选自动回滚单独排期，不阻塞 Phase 4–6。本期架构范围以当前发布产物和 CI 实测为准。

### Phase 4：部署识别与状态纠正

- [x] `UPD2-010` 建立部署模式识别与结构化更新能力状态；验收：标准一体化 Compose、分体 Compose、纯 Docker 单容器、缺 socket、更新关闭、Compose 缺失/损坏均返回唯一且可测试的 mode/capability/reason，不再把初始化异常统一伪装为“未启用”。
- [x] `UPD2-011` 修正 Admin 更新页面与部署文档；验收：页面按部署能力显示操作或明确手动路径，删除过时 sidecar 描述，`sandboxd` 说明仅在相关场景显示且明确不是更新 app 的依赖。

### Phase 5：分体 Compose 更新

- [x] `UPD2-012` 扩展签名 manifest 与发布产物组；验收：新 manifest 同时携带 unified app 和 split backend/frontend 不可变 digest；v2 manifest 被拒绝；缺失/不匹配任一目标镜像时拒绝更新。
- [x] `UPD2-013` 实现分体 Compose 专用 updater adapter 与受限执行边界；验收：备份、迁移、拉取全量目标镜像、按依赖重建 backend/frontend/worker/gateway 及符合条件的 sandboxd、健康检查、状态恢复全链路通过临时 Compose 集成测试；业务容器不挂 Docker socket，用户配置与数据卷不被改写。

### Phase 6：纯 Docker 单容器更新

- [x] `UPD2-014` 实现 standalone Docker helper 更新与容器恢复；验收：helper 在 app 停止后继续运行，能复现白名单容器配置并保留绑定数据卷；备份、数据库兼容预检、替换、健康检查失败恢复、helper 异常恢复均通过临时 Docker daemon 测试；匿名卷/不受支持配置/不兼容迁移一律在替换前拒绝。
- [x] `UPD2-015` 完成三种部署模式灰度验收与运维文档；验收：在独立测试项目分别完成 integrated、split、standalone 升级及故障演练，核实审计、socket 权限边界、数据库/文件/BYOK 数据保持和人工恢复指引；发布说明明确支持矩阵。

> Phase 5/6 验收完成：devserver 独立 Docker 项目实测分体 Compose 成功更新、健康检查失败自动恢复、一体化 Compose 更新、standalone 容器替换/失败恢复及短期 helper 接管；5 项 Docker 集成测试通过。updater 后端聚焦测试 42 项、完整 backend 测试 3400 项、发布更新 Node 测试 18 项通过；前端类型检查、生产构建及 CSS/确认弹窗回归检查通过。生产灰度仍需按部署文档另行执行；本次未触发 GitHub CI。
