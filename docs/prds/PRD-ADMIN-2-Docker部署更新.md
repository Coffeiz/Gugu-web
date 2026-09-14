# PRD-ADMIN-2：Docker 部署更新与版本分发

> 状态：Phase 2 的 updater、Admin 更新页和手动回滚能力已实现并通过本地验证；dev/staging 灰度仍待执行。Phase 1 的新 tag 发布验证与 Compose 端到端升级验收也仍待执行。
> 创建：2026-08-31
> 最近更新：2026-09-13
> 关联模块：`docker-compose.prod.yml`、`.github/workflows/`、`docs/ops/deploy.md`、`frontend/src/views/Admin/`、`backend/app/api/v1/`
> 背景参考：`PRD-ADMIN-1-Admin咕咕球管理助手.md`、`docs/ops/deploy.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 普通用户 Compose 更新目标 | 已有一体化 Compose | ✅ 已确认 | 默认 `docker-compose.yml` 使用公开 `gugu-web` 镜像；拆分 backend/frontend 属业务部署路径。 |
| 镜像发布策略 | 一体化镜像双发，拆分业务镜像走 GHCR | 🟡 新规则待发布验证 | `gugu-web` 发布到 Docker Hub 并镜像到 GHCR；backend/frontend 继续发布到 GHCR，供业务部署更新。 |
| GitHub Release 更新清单 | manifest v2 已实现 | 🟡 待新 tag 验证 | 新 manifest 只记录 Docker Hub 的 `gugu-web` 固定 digest，并附签名 bundle；v1.2.1 的旧拆分 manifest 不作为一体化更新输入。 |
| Docker 发布 CI | Workflow 已实现 | 🟡 新策略待 tag 验证 | 后续版本继续签名发布一体化镜像到双仓，并发布 GHCR backend/frontend 业务镜像。 |
| Compose 安全更新入口 | 一体化脚本已调整 | 🟡 端到端验收待执行 | 默认更新 `docker-compose.yml` 的 `app` 服务；拆分 `docker-compose.prod.yml` 不走该入口。 |
| Admin 检查和执行更新 | 已实现 | 🟡 待灰度 | Admin 更新页可检查版本、展示 Release、执行预检并通过一次性确认发起更新；API 受 Admin 权限保护。 |
| 更新服务与回滚 | 已实现 | 🟡 待灰度 | 受限 updater sidecar 持久化任务状态，只执行固定 Compose 更新/回滚动作；Docker Socket 不挂给 app。 |

## 1. 背景与目标

咕咕的普通用户不应该下载 Git 源码、安装前端/后端依赖或在本机重新构建镜像。对于 Docker Compose 部署，更新应当直接获取经过 CI 构建和验证的业务镜像，以降低安装门槛、减少本地磁盘消耗，并保证所有用户使用一致的构建产物。

本 PRD 定义咕咕普通用户 Docker 部署的标准更新链路：GitHub 负责代码、Release 和更新说明，Docker Hub 的公开一体化 `gugu-web` 是更新主来源，GHCR 镜像该应用并继续承载 backend/frontend 业务镜像；Admin 负责展示和确认，独立更新服务负责在服务器执行默认一体化 Compose 更新。

目标：

- 用户只需在 Admin 中检查和确认更新，不需要理解 Git、Node、Python 或 Docker build。
- 更新使用固定版本和镜像 digest，不使用 `latest` 作为生产事实源。
- 更新前自动检查磁盘、配置、数据库状态和当前运行版本。
- 数据卷、`backend/.env`、`config.override.json`、PostgreSQL、Redis、用户文件和记忆数据不因更新被删除。
- 数据库迁移、容器健康检查和失败回滚成为标准流程。
- 支持管理员查看版本说明、更新进度、失败原因和恢复建议。

本 PRD 不包含：

- 不支持普通用户从 GitHub 下载源码后自动构建。
- 不把 Docker Socket 暴露给 backend、worker、gateway 或普通 Agent。
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
  "schema_version": 2,
  "version": "0.4.0",
  "channel": "stable",
  "minimum_version": "0.3.0",
  "app_image": "docker.io/coffeiz/gugu-web@sha256:...",
  "architectures": ["linux/amd64", "linux/arm64"],
  "database_migration": true,
  "release_notes_url": "https://github.com/Coffeiz/Gugu-web/releases/tag/v0.4.0",
  "rollback_supported": true
}
```

GitHub Release 是版本和说明来源；Docker Hub 是公开一体化应用的更新主来源，GHCR 镜像同一个 `gugu-web` 并继续接收拆分 backend/frontend 业务镜像。manifest v2 只包含一体化 app digest；更新器严格校验仓库白名单与不可变 digest，不接受聊天消息或前端输入的任意镜像地址。旧版 v1 拆分镜像 manifest 不会被当作一体化更新目标。

### FR-UPD-003：更新预检

执行更新前必须完成预检，并展示结果：

- 当前部署由 Compose 管理，且 Compose 文件版本兼容。
- Docker daemon 可用，磁盘空间足够保存新旧镜像和临时层。
- PostgreSQL、Redis 和一体化 app 服务当前状态可读取。
- 配置文件和持久化卷存在且可读写。
- 当前数据库迁移状态正常，没有未完成或冲突迁移。
- 目标镜像架构与宿主机匹配，digest 和签名校验通过。
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

默认更新只拉取并重建一体化 `gugu-web` app；拆分 backend/frontend 镜像只用于业务部署，不属于普通用户更新目标。PostgreSQL、Redis、SearXNG 和其他基础服务只有在它们的版本被明确纳入一次发布且经过兼容性验证时才更新。

Shell sandbox 是可选 profile。普通更新不因为用户未开启 sandbox 而拉取 Debian 或 sandbox 运行镜像；只有管理员明确开启或更新 sandbox profile 时，才执行对应的镜像预检和拉取。

## 3. 技术方案

### 3.1 发布流水线

新增 GitHub Actions 发布流水线，触发条件为受保护的版本 tag，例如 `v0.4.0`：

```text
版本 tag
  → 一体化 gugu-web 与拆分 backend/frontend 构建
  → 单元测试、类型检查和镜像安全扫描
  → gugu-web 推送 Docker Hub 与 GHCR；backend/frontend 发布到 GHCR
  → 获取 Docker Hub gugu-web digest
  → 生成并签名 update-manifest.json
  → 创建 GitHub Release
```

镜像发布语义版本号标签并记录不可变 digest；稳定版继续维护 `latest` 别名以兼容默认 Compose 部署，但生产 manifest 和回滚依据必须使用 digest。不得发布 Git SHA 镜像标签。

发布流水线必须记录构建来源、依赖锁文件摘要、Git SHA、目标架构和镜像 digest。未经流水线验证的本地镜像不能进入 stable manifest。

### 3.2 更新源与 manifest

更新器首先读取配置中的 manifest 地址。默认地址可以指向 GitHub Release 资产；当 GitHub API 不稳定或有速率限制时，改用固定 CDN/静态站点地址，内容仍由同一发布流水线生成。

Manifest 必须通过 HTTPS 获取，并校验：JSON Schema、版本格式、镜像仓库白名单、digest 格式、最低版本、架构、签名和有效期。manifest v2 只允许 `docker.io/coffeiz/gugu-web`（GHCR 一体化镜像引用只作为受控镜像源）；backend/frontend 不在普通更新白名单中。更新器不得跟随未经校验的重定向。

### 3.3 更新执行器

新增独立的 `gugu-updater`，可以是宿主机 systemd 服务或受限 sidecar。业务 backend 通过本地受保护的 Unix Socket 调用它，不直接挂载 Docker Socket。

更新器只开放固定动作：检查状态、拉取指定 manifest、执行预检、开始更新、查看进度、查看结果、回滚指定上一版本。它不接受任意 Docker 命令、任意 Compose 文件、任意 registry 或任意宿主机路径。

更新任务采用持久化状态机：`pending`、`prechecking`、`backing_up`、`pulling`、`migrating`、`recreating`、`health_checking`、`succeeded`、`failed`、`rollback_required`。每个阶段都写入开始时间、结束时间、结果和脱敏错误摘要。

### 3.4 权限与确认

更新接口只允许 Admin Token 访问；服务端不信任前端传来的角色、版本或镜像地址。开始更新属于 destructive 运维操作，必须经过统一确认门，并使用绑定操作者、目标版本、manifest digest 和有效期的一次性确认令牌。

所有更新、回滚、预检失败和校验失败均写入 Admin 审计日志。日志不包含密码、Token、Cookie、API Key、完整环境变量或用户聊天内容。

### 3.5 Compose 与配置保护

更新器以默认一体化 `docker-compose.yml` 为普通用户更新模板，保留用户的 `backend/.env`、根目录 Compose `.env` 和持久化卷。拆分 `docker-compose.prod.yml` 是业务部署路径，不由该更新入口操作。更新前必须记录当前镜像引用；更新过程禁止自动执行 `docker compose down -v`、无范围 `docker system prune` 或删除卷。

数据迁移任务使用新 `gugu-web` 镜像执行，并在 app 容器重建前完成。数据库迁移随应用启动执行；迁移文件必须幂等，向后兼容要求在发布说明中声明。

### 3.6 相关文件与目录树

```text
Gugu-web/
├── .github/
│   └── workflows/
│       └── docker-release.yml                         # 新增：构建、扫描、双仓库推送，manifest 默认 Docker Hub
├── backend/
│   ├── app/
│   │   ├── api/v1/
│   │   │   └── admin_update.py                         # 新增：Admin 更新检查、预检、任务状态 API
│   │   └── services/
│   │       └── update_manifest.py                     # 新增：manifest 获取、Schema/签名/digest 校验
│   └── updater/                                       # 新增：独立更新执行器
│       ├── __init__.py
│       ├── api.py                                     # 本地 Unix Socket API
│       ├── compose.py                                 # 白名单 Compose 操作
│       ├── health.py                                  # 更新后健康检查
│       ├── preflight.py                               # 磁盘、架构、服务和迁移预检
│       ├── state.py                                   # 更新状态机和任务持久化
│       ├── backup.py                                  # 配置/数据库元信息备份
│       └── rollback.py                                # 上一版本引用恢复
├── docker/
│   └── updater/
│       ├── Dockerfile                                 # 新增：更新器镜像（若采用 sidecar）
│       └── gugu-updater.service                       # 新增：宿主机 systemd 运行方式（二选一）
├── docker-compose.prod.yml                            # 修改：更新器连接、健康检查和最小权限配置
├── deploy/
│   └── update-manifest.schema.json                    # 新增：manifest JSON Schema
├── frontend/src/
│   ├── services/
│   │   └── adminUpdate.ts                             # 新增：Admin 更新 API 封装
│   ├── components/admin-update/
│   │   ├── AdminUpdatePanel.vue                       # 新增：版本、变更和更新状态面板
│   │   ├── UpdatePreflightCard.vue                    # 新增：更新预检结果
│   │   ├── UpdateConfirmDialog.vue                    # 新增：影响说明和确认门
│   │   └── UpdateProgressCard.vue                     # 新增：阶段进度、成功和失败状态
│   └── views/Admin/
│       └── Updates/
│           └── index.vue                              # 新增：Admin 更新页面编排
├── backend/Dockerfile.prod                            # 现有：backend 生产镜像构建入口
├── frontend/Dockerfile.prod                           # 现有：frontend 生产镜像构建入口
├── docs/
│   ├── ops/deploy.md                                  # 修改：补充标准镜像更新和回滚操作
│   └── prds/
│       ├── PRD-ADMIN-1-Admin咕咕球管理助手.md          # 关联：Admin 助手工具边界
│       └── PRD-ADMIN-2-Docker部署更新.md              # 本文档
└── release/
    └── update-manifest.json                           # 发布产物：由 CI 生成并上传到 Release
```

文件职责边界：GitHub Actions 只负责构建和发布；`update_manifest.py` 只负责读取和验证版本信息；`backend/app/api/v1/admin_update.py` 只负责 Admin 鉴权、调度和状态展示；`backend/updater/` 才拥有执行 Compose 更新的能力。`docker-compose.prod.yml`、生产配置和持久化卷仍由部署环境持有，更新器不得自行覆盖用户配置。

`docker/updater/gugu-updater.service` 与 `docker/updater/Dockerfile` 是两种部署形态的候选位置，最终只选择宿主机 systemd 或受限 sidecar 其中一种，不能同时启用两个更新器。

## 4. 验证与上线

验收重点：

- 从 GitHub Release 获取 manifest v2，并能匿名按 digest 从 Docker Hub 拉取 `gugu-web` 一体化镜像；该镜像的 GHCR 镜像也通过 Cosign 验签。
- 使用旧版本 Compose 配置更新到新版本，用户配置、数据库、文件和记忆数据保持不变。
- 一体化 app 更新后，API、页面、SSE、worker、gateway 和 Admin 均恢复正常。
- 预检能拦截磁盘不足、架构不匹配、manifest 无效、digest 不匹配、迁移异常和并发更新。
- 未开启 sandbox 的部署不会拉取或启动 sandbox profile 镜像。
- 更新失败可以保留现场并给出可执行恢复建议；支持回滚的版本能恢复上一组业务镜像。
- 普通用户无法访问更新接口；Admin 更新操作可在审计日志中完整追踪。

发布前使用临时 Compose 项目验证新旧版本升级、空数据库初始化、已有数据库迁移、迁移失败、容器启动失败、磁盘不足和回滚场景。先在 dev/staging 验证，再向 stable 用户开放。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| Docker Hub 不可达 | 无法检查或拉取标准更新 | 明确提示更新源不可用；GHCR 的同 digest 一体化镜像可作为显式受控来源，不在校验失败时自动改写 registry。 |
| 镜像 tag 被覆盖 | 回滚到错误构建 | 生产只消费 digest，tag 仅用于展示和检索。 |
| 数据库迁移不可逆 | 新镜像回滚后数据不兼容 | 发布前检查迁移策略，manifest 标注回滚能力，必要时阻止回滚。 |
| 更新器拥有过高 Docker 权限 | 服务器被聊天入口间接控制 | Unix Socket、命令白名单、镜像白名单、路径白名单和独立 Admin 权限。 |
| 新旧镜像同时占用磁盘 | 更新中途空间不足 | 预检估算空间，成功后只清理明确确认的旧业务镜像，不清理数据卷。 |
| sandbox 可选依赖被误拉取 | 用户磁盘和下载时间增加 | sandbox 使用独立 Compose profile，普通更新不处理。 |

待确认事项：

- Docker Hub 匿名拉取限额及镜像可用性监控策略。
- 是否首版只支持 `linux/amd64`，还是同时构建 `linux/arm64`。
- 更新 manifest 是直接托管在 GitHub Release，还是发布后同步到独立 CDN。
- 失败后是否首版自动回滚，还是先停在 `rollback_required` 由管理员确认。
- Admin 更新是否允许跨环境操作，还是每个部署实例只能更新自身环境。

## 6. 唯一实施 TODO

### Phase 1：发布物与手动更新基础

- [x] `UPD2-001` 固定版本、镜像命名、架构和 manifest Schema；验收：manifest Schema 与无依赖校验器已实现，能表达版本、最低版本、镜像 digest、迁移和回滚字段，并通过本地校验。
- [ ] `UPD2-002` 🟡 建立 GitHub Actions Docker 发布流水线；验收：Workflow 版本 tag 构建一体化 app 与 backend/frontend 业务镜像，app 推送 Docker Hub 和 GHCR、拆分镜像持续发布 GHCR，生成 Docker Hub app digest 和 GitHub Release。
- [x] `UPD2-003` 增加 manifest 签名、镜像白名单和 digest 校验；验收：发布 Workflow 生成 Cosign 签名，Compose 更新脚本校验 manifest v2、bundle、发布者身份和一体化镜像白名单，不接受拆分 backend/frontend 镜像。
- [x] `UPD2-004` 补齐 Docker Compose 升级、迁移和配置保护脚本；验收：更新脚本备份配置和数据库，保留 PostgreSQL、Redis、用户文件、记忆、工作区和 Admin 配置卷，并明确禁止 `down -v` 和无范围清理。

### Phase 2：Admin 检查与受限执行

- [x] `UPD2-005` 实现独立 `gugu-updater` 状态 API 和持久化任务状态机；验收：Unix Socket RPC、原子状态文件、任务互斥、重启中断恢复；预检覆盖服务、数据库迁移 head、数据/配置卷、镜像架构、磁盘和最低版本；本地 updater 状态测试通过。
- [x] `UPD2-006` 接入 Admin 版本检查、Release 说明和更新确认流程；验收：Admin 更新页展示当前/目标版本、说明、预检和任务状态；更新/回滚使用操作者与目标绑定、十分钟有效的一次性确认；类型检查、i18n 测试和生产构建通过。
- [x] `UPD2-007` 实现更新后健康检查和失败恢复；验收：Compose 更新成功后再次检查 app API 与 PostgreSQL，失败进入 `rollback_required` 并保留上一版本镜像引用；回滚需管理员再次确认，且明确提示不会逆转数据库迁移。
- [ ] `UPD2-008` 完成 dev/staging 灰度和审计验收；验收：普通用户无权更新，Admin 操作可审计，未开启 sandbox 的部署不会拉取 sandbox 镜像。

> Phase 2 本地验证：updater 单元测试 6 项、manifest/Compose 更新脚本测试 14 项、前端类型检查、i18n 测试和生产构建通过。`UPD2-008` 保持未完成：当前未在 dev/staging 部署此分支进行真实镜像升级、权限与审计验收；本机 Docker Compose CLI 和 daemon 均不可用，无法代替该灰度验证。

### Phase 3：可靠性增强

- [ ] `UPD2-009` 增加离线/CDN manifest、架构多平台构建和可选自动回滚；验收：更新源短暂不可用时显示明确状态，多架构镜像按宿主机选择，回滚策略经过失败迁移场景验证。
