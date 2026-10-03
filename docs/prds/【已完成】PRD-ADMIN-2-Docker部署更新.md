# PRD-ADMIN-2：Docker 部署更新与版本分发

> 状态：更新策略已修订。单容器 Admin 只更新签名应用包；Compose Admin 不执行自更新，由 Docker/Compose 管理器更新整套镜像，不再部署 updater sidecar。应用包运行时与发布链正在 Phase 7 验收；NAS/真实容器端到端验收未完成。
> 创建：2026-08-31
> 最近更新：2026-09-29
> 关联模块：`docker-compose.yml`、`docker-compose.prod.yml`、`.github/workflows/`、`deploy/`、`scripts/release/`、`backend/updater/`、`frontend/src/views/Admin/Updates/`
> 背景参考：`PRD-ADMIN-1-Admin咕咕球管理助手.md`、`docs/ops/deploy.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 一体化 Compose 更新 | 手动镜像管理 | ✅ 策略已确认 | Docker/Compose 管理器负责更新整套镜像；Admin 不更新镜像，不部署 updater sidecar。 |
| 镜像发布策略 | 一体化与拆分业务镜像均双发 | ✅ 已确认 | 一体化 `gugu-web`、backend/frontend、sandbox 均发布到 Docker Hub 与 GHCR；只发布语义版本号标签，不发布 Git SHA 镜像标签；稳定版维护 `latest`。 |
| GitHub Release 更新清单 | manifest v3 | ✅ 已确认 | Schema、CI 发布清单、无依赖校验器与 updater 均只接受完整镜像组；v2 不再接受。 |
| Docker 发布 CI | Workflow 已实现 | ✅ 已确认 | 版本 tag 构建并扫描四类镜像，使用 Cosign OCI 1.1 referrer 签名后发布到双仓；旧式 `.sig` 标签仅为历史遗留，不再新增。 |
| 分体 Compose 更新 | 手动镜像管理 | ✅ 策略已确认 | Docker/Compose 管理器负责更新 backend/frontend 等整套镜像；Admin 不更新镜像，不部署 updater sidecar。 |
| 单容器整镜像更新 | 手动镜像管理 | ✅ 策略已确认 | fnOS、群晖等 Docker 管理器负责拉取镜像并重建容器；Gugu 不挂载宿主 Docker Socket。 |
| 单容器签名应用包更新 | 实现中 | 🟡 Phase 7 | Admin 更新 `/data` 中的应用包并重启容器内进程；不替换 Docker 镜像或基础运行时。Release/API/UI/容器集成仍需验收。 |
| NAS 管理器镜像更新 | 设计确认 | ✅ 已确认 | fnOS、群晖等部署由其 Docker 管理界面拉取新镜像并重建容器，沿用用户持久化挂载。 |
| Admin 部署模式识别 | 实现中 | 🟡 Phase 7 | 区分单容器应用包更新与 Compose 手动镜像更新；不依赖宿主 Docker Socket/RPC。 |
| Admin 检查和执行更新 | 实现中 | 🟡 Phase 7 | 仅单容器提供签名应用包检查、预检、确认、审计和任务状态；Compose 显示 Docker/Compose 手动更新指引。 |
| 更新服务与回滚 | 实现中 | 🟡 Phase 7 | 单容器应用包运行于 app 进程内并支持代码回滚；Compose 镜像更新/恢复由部署管理器负责。 |

## 1. 背景与目标

咕咕的普通用户不应该下载 Git 源码、安装前端/后端依赖或在本机重新构建镜像。对于 Docker Compose 部署，更新应当直接获取经过 CI 构建和验证的业务镜像，以降低安装门槛、减少本地磁盘消耗，并保证所有用户使用一致的构建产物。

本 PRD 定义咕咕普通用户 Docker 部署的标准更新链路：GitHub 负责代码、Release 和更新说明，Docker Hub 与 GHCR 发布一体化及拆分业务镜像。单容器 Admin 可在线更新经签名的 Gugu 应用包；单容器基础镜像/运行时及 Compose 的整套镜像统一交给 Docker/Compose 或 NAS Docker 管理器。Compose Admin 不提供镜像自更新，也不部署独立 updater sidecar。

目标：

- 单容器在 Admin 中检查并确认签名应用包更新；Compose 部署在 Admin 明确显示由 Docker/Compose 管理器更新整套镜像，不显示镜像检查、预检、开始更新或回滚操作。
- 更新使用固定版本和镜像 digest，不使用 `latest` 作为生产事实源。
- 更新前自动检查磁盘、配置、数据库状态和当前运行版本。
- 数据卷、`backend/.env`、`config.override.json`、PostgreSQL、Redis、用户文件和记忆数据不因更新被删除。
- 数据库迁移、容器健康检查和失败回滚成为标准流程。
- 支持管理员查看版本说明、更新进度、失败原因和恢复建议。

### 1.1 定位修订（2026-09-14）

一体化部署的产品定位是**个人用户自己下载、自己更新，简单易用优先**。更新策略按部署边界区分：

- 单容器应用包更新在 Admin API 所在的 Gugu 进程内执行，不需要 Docker Socket 或额外 updater 容器。Compose 镜像更新由用户的 Docker/Compose 管理器执行，Admin 不提供对应的一键入口。
- 默认一体化 Compose 的 PostgreSQL/Redis 在 app 镜像内运行，避免额外依赖容器。由旧默认 Compose 升级时，必须先停止旧 app，再导出 PostgreSQL 和 Redis RDB 快照；新 app 对旧卷只读探测，缺少备份时 fail-closed，绝不悄悄创建空数据库或丢弃旧 Stream 队列。
- `docker-compose.prod.yml` 分体部署没有 Admin 镜像自更新；用户通过 Compose 管理工具拉取并重建整套服务。
- Gugu 的镜像更新能力不持有、调用或透传宿主 Docker Socket；更新应用包只限单容器且必须通过发布身份签名、摘要验证、运行时兼容和管理员一次性确认。
- 保留：manifest 与 digest 白名单（仅允许官方 coffeiz/gugu-web 镜像）、预检、一键回滚、审计。发布端继续同步 Docker Hub 与 GHCR；manifest 本身不单独签名，目标镜像使用 Cosign OCI 1.1 referrer 签名，更新前由固定 Cosign verifier 校验。
- 分体部署（`docker-compose.prod.yml`）当前不受既有一体化更新入口支持；本 PRD 将其列入目标部署模式，并要求使用独立的执行边界。
- 纯 Docker 单容器面向 fnOS、群晖等普通用户：不要求 Compose、宿主 Docker Socket 或平台专属 API。Admin 在线更新只替换持久化目录中的 Gugu 应用代码/静态资源并重启容器内服务；Docker 镜像、操作系统、Python/Node 运行时与系统库由部署平台更新。
- 单容器应用包必须声明 runtime contract。当前容器不满足应用包兼容要求时，拒绝应用包更新并提示先由 NAS Docker 管理器更新整镜像。应用包回滚只恢复代码，不自动回滚数据库迁移。

本 PRD 不包含：

- 不支持普通用户从 GitHub 下载源码后自动构建。
- Docker Socket 不进入 Gugu 更新链路，也不进入 Agent 工具注册表与模型可见能力；Compose 部署不运行 updater sidecar。
- 不允许更新助手执行任意 Shell、任意 Compose 文件或任意镜像地址。
- 不在首版覆盖源码开发模式、桌面安装包、Kubernetes 或非 Docker 部署。
- 不允许更新过程中删除业务数据卷或自动清理所有旧镜像。

## 2. 功能需求

### FR-UPD-001：版本检查

单容器 Admin 可以查看当前应用版本、构建提交、数据库迁移版本、部署模式和运行环境，并手动检查签名应用包是否有新版本。Compose Admin 只显示当前版本与 Docker/Compose 管理器更新指引，不请求更新 manifest、不检查镜像更新。

更新检查读取固定格式的 manifest。首版可以直接读取 GitHub Release 资产或固定的公开 manifest URL；正式部署应支持通过配置指定镜像源和 manifest 镜像，避免依赖 GitHub API 限流。

无更新、存在更新、当前版本过旧、无法连接更新源和 manifest 校验失败必须分别展示，不得统一显示为“暂无更新”。

### FR-UPD-002：GitHub Release 与 Docker Hub / GHCR 分工

每次正式版本发布必须生成一份 GitHub Release，包含用户可读的更新说明、兼容要求、数据库迁移说明、已知问题和回滚提示。

Release 关联 `update-manifest.json`：单容器 Admin 只消费其中签名应用包元数据；镜像 digest 供 Docker/Compose/NAS 管理器发布与人工升级参考，Admin 不拉取或切换镜像。manifest 记录：

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

### FR-UPD-003：单容器应用包更新预检

单容器执行应用包更新前必须完成预检，并展示结果：

- 当前部署为受支持的无 Compose 单容器应用包模式。
- `/data` 空间足够保存新旧应用包和暂存文件。
- 内置 PostgreSQL、Redis 和 app 服务当前状态可读取。
- 配置文件和持久化卷存在且可读写。
- 当前数据库迁移状态正常，没有未完成或冲突迁移。
- 应用包 runtime contract 与当前基础镜像兼容，包摘要及 Cosign blob 签名校验通过。
- 当前没有正在执行的更新任务。

预检失败时只能查看原因和修复建议，不能继续执行覆盖更新。

### FR-UPD-004：单容器应用包执行

管理员明确确认后，进程内应用包更新器按以下顺序执行：

1. 锁定更新任务，防止并发执行。
2. 备份必要的配置和数据库元信息；业务文件卷只做存在性和容量校验，不复制整份大文件卷。
3. 下载 Release 中与当前版本匹配的签名应用包并校验签名、摘要和 runtime contract。
4. 将包解压至 `/data/app-updates` 下的暂存目录，不触碰基础镜像、运行时或用户数据。
5. 执行应用迁移并等待成功，再原子切换活动代码版本。
6. 由容器内 PID 1 监督器重启 Web、Worker、Gateway 等应用进程。
7. 等待应用健康检查；失败时恢复上一代码目录并重启进程。
8. 记录应用版本、迁移结果和耗时。

Compose/整镜像更新不走上述执行器，由 Docker/Compose/NAS 管理器更新和重建；Admin 不执行预检、更新或回滚。

PostgreSQL、Redis、`pgdata`、`gugu_data`、`gugu_config`、用户上传内容和记忆数据不得被 `down -v`、无条件 prune 或 Compose 重建删除。

### FR-UPD-005：失败恢复与回滚

应用包迁移失败、进程重启失败、健康检查超时或关键服务异常时，应用包更新器必须停止继续推进并保留诊断摘要。若数据库迁移不可逆或新版本明确不支持代码回滚，必须在预检阶段阻止更新。

单容器应用包只允许用于未包含数据库迁移且声明支持安全代码回滚的 Release；迁移 Release 必须改用完整镜像更新。应用包失败时仅可在数据库 schema 未变化时恢复上一代码版本；不能假设切回旧代码就能自动恢复数据库。Compose/整镜像的失败恢复由部署管理器/用户执行，Admin 不承诺自动回滚。

### FR-UPD-006：Admin 交互

单容器 Admin 咕咕球和更新页面可调用应用包更新能力；Compose 只显示管理器更新说明。单容器交互必须保持一致：

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

Docker/Compose 管理器更新 Compose 项目中的应用镜像；默认不更新 PostgreSQL、Redis、SearXNG 和其他基础服务，除非它们被明确纳入发布且经过兼容性验证。Admin 只呈现手动更新说明，不对 Compose 镜像执行检查或变更。

Shell sandbox 是可选 profile。普通更新不因为用户未开启 sandbox 而拉取 Debian 或 sandbox 运行镜像；只有管理员明确开启或更新 sandbox profile 时，才执行对应的镜像预检和拉取。

### FR-UPD-009：部署模式识别与能力说明

更新状态接口必须识别并返回当前部署模式、更新能力、不可用原因和推荐操作。至少区分 `integrated_compose`、`split_compose`、`standalone_container`、`unsupported`；能力状态至少区分 `available`、`manual_only`、`disabled`、`misconfigured`。部署识别依据必须来自经过校验的 Compose 服务集合、容器标签/运行配置和明确的部署标识，不能只根据镜像名或页面来源推测。

Admin 页面必须按部署模式渲染：受支持的单容器显示应用包检查/预检/确认；一体化或分体 Compose 显示由 Docker/Compose 管理器更新整套镜像的说明，并隐藏 Admin 镜像更新操作。单容器应用包目录未初始化、显式关闭更新和更新器初始化失败分别给出明确状态；Compose 状态判定不依赖容器内可访问 Compose 文件。不得将沙盒未运行解释为应用包更新不可用。

页面文案必须与实际架构一致，不得把 app 内置执行器称为 sidecar。沙盒说明仅在相关部署确有可选 `sandboxd` 服务时展示，并明确它只决定是否联动更新沙盒服务，不是更新 app 的前置条件。

### FR-UPD-010：Compose 镜像由部署管理器更新

一体化 `docker-compose.yml` 与分体 `docker-compose.prod.yml` 都不提供 Admin 一键镜像更新；Compose 文件不得启动 updater sidecar、挂载宿主 Docker Socket 或创建 updater RPC socket volume。Admin 必须返回 `manual_image_update` 能力状态，不提供检查、预检、执行和回滚 Compose 镜像的 API 操作。

用户通过 Docker/Compose 管理器更新整套服务镜像，并按发布说明遵守数据库迁移、数据备份和配置保留要求。管理器未提供 Gugu 专属事务时，文档需明确：更新前备份由用户/平台负责，失败恢复由用户通过平台恢复先前镜像；不能承诺 Admin 自动备份、迁移预检或容器级回滚。更新期间持久化目录/卷必须保持原映射。

### FR-UPD-011：纯 Docker 单容器自主更新

单容器部署不允许 Admin 通过宿主 Docker Socket 替换外层镜像。Admin 仅更新受支持的签名应用包；Docker 镜像、内置依赖、Rootless 沙盒和系统运行时均由 fnOS、群晖等平台管理。即使用户额外挂载了 Docker Socket，也不得改变此更新策略。

### FR-UPD-013：单容器应用包在线更新

当检测到受支持的一体化单容器时，Admin 更新入口必须提供 Gugu 应用包更新，而非把该部署显示为“无法更新”。即使容器额外挂载宿主 Docker Socket，更新策略也不得改为镜像替换。应用包仅包含 Gugu 后端代码、迁移、前端静态产物及运行所需应用资源；不包含或替换基础 OS、Python/Node 运行时、系统库、Docker daemon、内置 PostgreSQL/Redis 或 Rootless 沙盒运行时。

发布流水线为应用包生成版本化资产、文件摘要和由受信任 GitHub Actions 身份签发的 Cosign blob 签名。客户端只允许从官方 Release 获取资产，必须验证签名身份、版本、runtime contract、文件摘要、归档大小与路径安全；任何校验失败均拒绝安装。manifest 中的 runtime contract 与当前镜像不兼容时，明确要求先通过 NAS Docker 管理器更新整镜像。

应用包安装在 `/data` 的版本化目录，使用原子切换选择活动版本；保留上一版本供代码级回滚。切换后通过容器内 PID 1 监督入口重启 Web、Worker、Gateway、RAG sidecar 等应用子进程，不重启或替换外层容器，不触碰宿主 Docker。任务状态、确认令牌与历史持久化，更新后执行应用健康检查；失败时恢复上一应用包并重新启动服务。数据库迁移不得被假定可逆，预检和确认文案必须明确应用代码回滚不还原数据库。

应用包不得覆盖用户运行配置、用户文件、数据库/Redis 数据、沙盒用户目录或用户自定义内容；归档解压需防止路径穿越、符号链接逃逸、重复文件、超限文件和非预期文件类型。并发更新必须互斥；取消或进程重启后须能识别暂存包、活动版本和未完成任务，不得留下混合版本运行态。

管理页分别呈现“应用更新”和“整镜像更新”职责：单容器应用包检查/预检/确认只影响 Gugu 应用代码；单容器和 Compose 的整镜像更新说明由 Docker/Compose 或 NAS 管理器执行，并提醒保留持久化挂载。Compose 不运行 Admin 镜像更新流程。

### FR-UPD-012：共享更新契约与执行边界

单容器应用包路径共享版本检查、manifest/schema 校验、Cosign 签名与摘要校验、runtime contract、管理员一次性确认、审计和任务状态。Compose 仅识别部署模式并返回手动镜像更新指引，不进行 Docker 操作。

Gugu 更新功能不得访问宿主 Docker Socket；Compose 文件不部署更新 sidecar。这样会放弃 Admin 提供的 Compose 镜像备份、迁移编排和自动回滚，由部署管理器/用户承担整套镜像更新事务。

## 3. 技术方案

### 3.1 发布流水线

新增 GitHub Actions 发布流水线，触发条件为受保护的版本 tag，例如 `v0.4.0`：

```text
版本 tag
  → 一体化 gugu-web 与拆分 backend/frontend 构建
  → 单元测试、类型检查和镜像安全扫描
  → gugu-web 与 backend/frontend 推送 Docker Hub 与 GHCR
  → 从扫描通过的 app 镜像导出 /app 应用包
  → 用 Cosign keyless 签署应用包，计算 SHA-256
  → 获取 Docker Hub gugu-web digest
  → 生成 update-manifest.json（镜像 digest + 可选应用包元数据），并对发布镜像生成 OCI 1.1 referrer 签名
  → 创建 GitHub Release
```

镜像发布语义版本号标签并记录不可变 digest；稳定版继续维护 `latest` 别名以兼容默认 Compose 部署，但生产 manifest 和回滚依据必须使用 digest。不得发布 Git SHA 镜像标签。

发布流水线必须记录构建来源、依赖锁文件摘要、Git SHA、目标架构和镜像 digest。未经流水线验证的本地镜像不能进入 stable manifest。

### 3.2 更新源与 manifest

更新器首先读取配置中的 manifest 地址。默认地址可以指向 GitHub Release 资产；当 GitHub API 不稳定或有速率限制时，改用固定 CDN/静态站点地址，内容仍由同一发布流水线生成。

单容器更新器通过 HTTPS 获取 Release manifest，并校验 JSON Schema、版本格式、应用包元数据、最低版本、runtime contract 与有效期；只校验应用包签名和摘要，不拉取或校验目标容器镜像。manifest 中镜像 digest 的发布签名由发布流水线生成，供外部 Docker 管理器使用。更新器不得跟随未经校验的重定向。

### 3.3 更新执行器

`backend/updater/` 只为无 Compose 单容器提供 Admin 应用包检查、验证、暂存、原子激活、进程重启和代码回滚。Compose 部署识别为 `manual_image_update` 后立即返回状态，不实例化更新执行器、不访问 Docker Socket、不创建 RPC，也不运行 Compose 命令。Docker/Compose/NAS 管理器负责镜像拉取、容器重建和整镜像恢复。

单容器应用包更新器只开放固定动作：检查状态、拉取并验证官方应用包、执行预检、开始更新、查看进度、查看结果、回滚指定上一代码版本。它不接受任意 Docker 命令、任意 registry 或任意宿主机路径。

更新任务采用持久化状态机：`pending`、`prechecking`、`backing_up`、`pulling`、`migrating`、`recreating`、`health_checking`、`succeeded`、`failed`、`rollback_required`。每个阶段都写入开始时间、结束时间、结果和脱敏错误摘要。

### 3.4 权限与确认

更新接口只允许 Admin Token 访问；服务端不信任前端传来的角色、版本或镜像地址。开始更新属于 destructive 运维操作，必须经过统一确认门，并使用绑定操作者、目标版本、manifest digest 和有效期的一次性确认令牌。

所有更新、回滚、预检失败和校验失败均写入 Admin 审计日志。日志不包含密码、Token、Cookie、API Key、完整环境变量或用户聊天内容。

### 3.5 配置与数据保护

应用包更新不写入 `.env`、`backend/.env`、Compose 文件、容器环境配置或业务持久化卷之外的用户数据。应用包预检拒绝带数据库迁移或未声明安全代码回滚的 Release；manifest 的迁移标记由发布流水线比较最近的稳定 tag 与本次提交中的 Alembic migration 文件生成，缺少稳定比较基线时按包含迁移处理。Compose 镜像更新由平台/用户执行，须保留原有 `.env`、Compose 文件和卷映射；Gugu 不执行 `docker compose down -v`、无范围 `docker system prune` 或 Docker API 操作。

Compose 数据库备份和迁移须在业务容器重建前完成；standalone 数据库备份须在停止旧 app 前完成且验证备份可读。迁移文件必须幂等，回滚兼容要求在发布元数据和说明中明确；任何数据库恢复都必须是显式、可审计的操作，不以切换镜像隐式还原数据库。

### 3.6 多部署模式更新边界

更新模块只在单容器模式启用应用包 adapter。Compose 模式仅校验 Compose 服务拓扑以给出清晰的手动更新状态，不读取 Docker Socket、不创建 RPC、不执行 Compose 命令。

单容器 app-bundle adapter 固定下载 GitHub Release 应用包，验证官方 Cosign workflow 身份和 SHA-256，安全解压至 `/data/app-updates/releases/<version>`，写入 pending/previous 状态后原子切换 `/app` 软链接；PID 1 监督器响应 HUP、重启 Web/Worker/Gateway/RAG sidecar 并健康检查。健康失败时由镜像内固定、不可随应用包替换的 runtime helper 恢复上一应用目录；不重启外层容器，不接触宿主 Docker。整 Docker 镜像、基础系统、Rootless Docker 与执行沙盒由 fnOS/群晖等部署平台更新。

### 3.7 Manifest 兼容与镜像集合

仅接受 v3 manifest，表达 unified app digest、split backend/frontend digest、支持架构、最低版本、数据库迁移兼容声明、发布说明和回滚能力；`app_bundle` 为可选字段，旧 v3 清单仍可用于镜像更新，但无 Socket 应用更新要求该字段存在。应用包描述版本绑定的归档名、签名 bundle、SHA-256、runtime contract 和字节大小；Cosign keyless 签名身份限定官方 tag workflow。v2 不保留兼容。镜像更新仍校验官方仓库白名单、不可变 digest、OCI 1.1 镜像签名和目标架构；应用包更新必须校验签名、摘要、包内版本/runtime contract 与 manifest 一致，并限制归档路径、文件类型、文件数量和解压大小。

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

> **历史记录说明：**Phase 1–6 记录的是曾实现并验收过的 Admin 镜像自动更新架构（包括 Compose updater/RPC 和单容器 helper），该架构已由 2026-09-29 的 Phase 7 策略修订取代。下列勾选仅表示历史上曾完成，不代表这些执行路径仍存在或受支持。当前要求和验收以本节 Phase 7 及上方 FR 为准。

### Phase 1：发布物与手动更新基础（历史方案）

- [x] `UPD2-001` 固定版本、镜像命名、架构和 manifest Schema；验收：manifest Schema 与无依赖校验器已实现，能表达版本、最低版本、镜像 digest、迁移和回滚字段，并通过本地校验。
- [x] `UPD2-002` 建立 GitHub Actions Docker 发布流水线；验收：Workflow 版本 tag 构建一体化 app、backend/frontend 和 sandbox 镜像，全部推送 Docker Hub 和 GHCR，不发布 Git SHA 镜像 tag，镜像使用 OCI 1.1 referrer 签名（不额外生成 `.sig` 普通 tag），生成 Docker Hub app digest 和 GitHub Release。
- [x] `UPD2-003` 增加镜像签名、manifest 白名单和 digest 校验；验收：发布 Workflow 对镜像生成 Cosign OCI 1.1 referrer 签名，更新器校验 manifest v3、镜像 digest、发布者身份和完整镜像组；不接受 v2 或非白名单镜像。
- [x] `UPD2-004` 补齐 Docker Compose 升级、迁移和配置保护脚本；验收：更新脚本备份配置和数据库，保留 PostgreSQL、Redis、用户文件、记忆、工作区和 Admin 配置卷，并明确禁止 `down -v` 和无范围清理。

### Phase 2：Admin 检查与受限执行（历史方案）

- [x] `UPD2-005` 实现 app 内置 updater 状态 API 和持久化任务状态机；验收：进程内 client、原子状态文件、任务互斥、重启中断恢复；预检覆盖服务、数据库迁移 head、数据/配置卷、镜像架构、磁盘、最低版本和镜像签名；本地 updater 状态测试通过。
- [x] `UPD2-006` 接入 Admin 版本检查、Release 说明和更新确认流程；验收：Admin 更新页展示当前/目标版本、说明、预检和任务状态；更新/回滚使用操作者与目标绑定、十分钟有效的一次性确认；类型检查、i18n 测试和生产构建通过。
- [x] `UPD2-007` 实现更新后健康检查和失败恢复；验收：Compose 更新成功后再次检查 app API 与 PostgreSQL，失败进入 `rollback_required` 并保留上一版本镜像引用；回滚需管理员再次确认，且明确提示不会逆转数据库迁移。
- [x] `UPD2-008` 完成 dev/staging 灰度和审计验收；验收：普通用户无权更新，Admin 操作可审计，未运行 sandbox 的部署不会拉取或重建 sandbox 服务；已用旧版本 Compose 在 devserver 完成升级验证。

> Phase 1/2 验证完成：updater 单元测试、manifest/Compose 更新脚本测试、前端类型检查、i18n 测试、生产构建，以及 devserver 旧版本 Compose 升级、权限、审计和 sandbox 边界验证均已通过。Docker Hub/GHCR 发布镜像的 OCI 1.1 referrer 签名已在 v1.2.3 发布中核验；历史 `.sig` 普通 tag 不再作为新发布产物。

### Phase 3：可靠性增强（历史方案，暂缓）

- 暂不实施 `UPD2-009`：离线/CDN manifest、多平台构建与可选自动回滚单独排期，不阻塞 Phase 4–7。本期架构范围以当前发布产物和 CI 实测为准。

### Phase 4：部署识别与状态纠正（历史方案）

- [x] `UPD2-010` 建立部署模式识别与结构化更新能力状态；验收：标准一体化 Compose、分体 Compose、纯 Docker 单容器、缺 socket、更新关闭、Compose 缺失/损坏均返回唯一且可测试的 mode/capability/reason，不再把初始化异常统一伪装为“未启用”。
- [x] `UPD2-011` 修正 Admin 更新页面与部署文档；验收：页面按部署能力显示操作或明确手动路径，删除过时 sidecar 描述，`sandboxd` 说明仅在相关场景显示且明确不是更新 app 的依赖。

### Phase 5：分体 Compose 更新（历史方案，已由 Phase 7 移除）

- [x] `UPD2-012` 扩展签名 manifest 与发布产物组；验收：新 manifest 同时携带 unified app 和 split backend/frontend 不可变 digest；v2 manifest 被拒绝；缺失/不匹配任一目标镜像时拒绝更新。
- [x] `UPD2-013` 实现分体 Compose 专用 updater adapter 与受限执行边界；验收：备份、迁移、拉取全量目标镜像、按依赖重建 backend/frontend/worker/gateway 及符合条件的 sandboxd、健康检查、状态恢复全链路通过临时 Compose 集成测试；业务容器不挂 Docker socket，用户配置与数据卷不被改写。

### Phase 6：纯 Docker 单容器更新（历史方案，已由 Phase 7 的应用包更新取代）

- [x] `UPD2-014` 实现 standalone Docker helper 更新与容器恢复；验收：helper 在 app 停止后继续运行，能复现白名单容器配置并保留绑定数据卷；备份、数据库兼容预检、替换、健康检查失败恢复、helper 异常恢复均通过临时 Docker daemon 测试；匿名卷/不受支持配置/不兼容迁移一律在替换前拒绝。
- [x] `UPD2-015` 完成三种部署模式灰度验收与运维文档；验收：在独立测试项目分别完成 integrated、split、standalone 升级及故障演练，核实审计、socket 权限边界、数据库/文件/BYOK 数据保持和人工恢复指引；发布说明明确支持矩阵。

> 历史验收记录：当时 devserver 独立 Docker 项目曾实测分体 Compose 成功更新、健康检查失败恢复、一体化 Compose 更新、standalone 容器替换/失败恢复及短期 helper 接管。该实现已被 Phase 7 删除/取代，不应作为当前部署能力或验收承诺。

### Phase 7：单容器应用包更新与 Compose 管理器更新

- [x] `UPD2-016` 固化按部署方式区分的更新策略；验收：单容器 Admin 只更新签名应用包；单容器整镜像及 Compose 整套镜像均由 Docker/Compose/NAS 管理器负责。
- [x] `UPD2-017` 移除 Compose updater sidecar、Docker Socket/RPC 接线与 Admin 镜像更新入口；验收：一体化/分体 Compose 不声明 updater 服务、socket/RPC volume 或宿主 Compose 路径；Admin 返回 `manual_image_update`，旧 `standalone_docker` 配置不再执行容器替换。
- [x] `UPD2-018` 实现应用包发布资产与签名；验收：tag workflow 从通过镜像扫描的候选 app 镜像导出 `/app`，打包版本化 tar.gz，读取包内 runtime contract，生成 SHA-256 与 Cosign blob bundle 并上传 Release。代码和本地校验通过；tag workflow 实际运行仍待发布时验收。
- [x] `UPD2-019` 实现应用包安全验证、暂存、原子激活与代码版本保护；验收：签名身份、SHA-256、包内版本/runtime contract 校验；路径穿越、链接/特殊文件、重复项、数量/体积超限均 fail-closed；应用包只写入 `/data/app-updates`，不覆盖用户数据和配置；聚焦测试通过。
- [x] `UPD2-020` 实现容器内应用进程受控重启与健康检查恢复；验收：PID 1 HUP 监督、固定 runtime helper、90 秒健康检查、失败回滚及重启后任务恢复已接入；单元测试通过。真实容器中 Web/Worker/Gateway/RAG 全链路更新与故障注入仍待容器集成验收。
- [x] `UPD2-021` 将应用包检查/预检/确认/执行和回滚接入 Admin API/UI；验收：管理员一次性 challenge、任务状态、回滚预检、Compose 手动更新提示及中/英/日文案已接入；前端类型/i18n 和后端部署/应用包测试通过。API/UI 浏览器回归与 NAS 真实部署仍待验证。

> Phase 7 当前状态：实现及本地聚焦验证完成；Release tag workflow、真实容器故障注入、Admin 浏览器回归和 fnOS/群晖验收仍未执行，因此整体发布验收不得标记为完成。未触发 GitHub CI。
