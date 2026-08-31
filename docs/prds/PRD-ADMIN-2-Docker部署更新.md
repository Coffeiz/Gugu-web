# PRD-ADMIN-2：Docker 部署更新与版本分发

> 状态：Phase 1 已实现，首次 GitHub tag 发布与远端镜像验证待执行
> 创建：2026-08-31
> 最近更新：2026-08-31
> 关联模块：`docker-compose.prod.yml`、`.github/workflows/`、`docs/ops/DEPLOY.md`、`frontend/src/views/Admin/`、`backend/app/api/v1/`
> 背景参考：`PRD-ADMIN-1-Admin咕咕球管理助手.md`、`docs/ops/DEPLOY.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 生产 Compose 消费预构建镜像 | 已有 | ✅ 已完成 | `docker-compose.prod.yml` 使用 `GUGU_BACKEND_IMAGE` 和 `GUGU_FRONTEND_IMAGE`。 |
| GHCR 镜像命名约定 | 已有文档约定 | 🟡 部分完成 | 当前文档已使用 `ghcr.io/coffeiz/gugu-web-backend` 和 `gugu-web-frontend`，正式镜像发布仍待首次 tag 验证。 |
| GitHub Release 更新清单 | Schema 和生成逻辑已实现 | 🟡 部分完成 | 已增加固定格式 Schema，正式 manifest 在版本 tag 发布时生成并上传。 |
| Docker 发布 CI | Workflow 已实现 | 🟡 部分完成 | PR/main 做 Compose 与镜像构建校验；版本 tag 推送 GHCR、扫描、签名并创建 Release。 |
| Compose 安全更新入口 | 脚本已实现 | 🟡 部分完成 | 已支持签名校验、配置/数据库备份、业务镜像拉取和服务重建；真实 Docker 更新待远端验证。 |
| Admin 检查和执行更新 | 尚未实现 | 🔲 待评估 | Admin 只负责发起、确认、展示状态。 |
| 更新服务与回滚 | 尚未实现 | 🔲 待评估 | 需要独立的受限更新执行器，不能给业务容器任意 Docker 权限。 |

## 1. 背景与目标

咕咕的普通用户不应该下载 Git 源码、安装前端/后端依赖或在本机重新构建镜像。对于 Docker Compose 部署，更新应当直接获取经过 CI 构建和验证的业务镜像，以降低安装门槛、减少本地磁盘消耗，并保证所有用户使用一致的构建产物。

本 PRD 定义咕咕 Docker 部署的标准更新链路：GitHub 负责代码、Release 和更新说明，GHCR 负责 Docker 镜像，Admin 负责展示和确认，独立更新服务负责在服务器执行 Compose 更新。

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

### FR-UPD-002：GitHub Release 与 GHCR 分工

每次正式版本发布必须生成一份 GitHub Release，包含用户可读的更新说明、兼容要求、数据库迁移说明、已知问题和回滚提示。

Release 同时关联一份 `update-manifest.json`，其中记录：

```json
{
  "schema_version": 1,
  "version": "0.4.0",
  "channel": "stable",
  "minimum_version": "0.3.0",
  "backend_image": "ghcr.io/coffeiz/gugu-web-backend@sha256:...",
  "frontend_image": "ghcr.io/coffeiz/gugu-web-frontend@sha256:...",
  "architectures": ["linux/amd64", "linux/arm64"],
  "database_migration": true,
  "release_notes_url": "https://github.com/Coffeiz/Gugu-web/releases/tag/v0.4.0",
  "rollback_supported": true
}
```

GitHub Release 是版本和说明来源；GHCR 是业务 Docker 镜像来源。更新器只接受 manifest 中的镜像地址和 digest，不接受聊天消息或前端输入的任意镜像地址。

### FR-UPD-003：更新预检

执行更新前必须完成预检，并展示结果：

- 当前部署由 Compose 管理，且 Compose 文件版本兼容。
- Docker daemon 可用，磁盘空间足够保存新旧镜像和临时层。
- PostgreSQL、Redis、backend、worker、gateway 和 frontend 当前状态可读取。
- 配置文件和持久化卷存在且可读写。
- 当前数据库迁移状态正常，没有未完成或冲突迁移。
- 目标镜像架构与宿主机匹配，digest 和签名校验通过。
- 当前没有正在执行的更新任务。

预检失败时只能查看原因和修复建议，不能继续执行覆盖更新。

### FR-UPD-004：备份与更新执行

管理员明确确认后，更新器按以下顺序执行：

1. 锁定更新任务，防止并发执行。
2. 备份必要的配置和数据库元信息；业务文件卷只做存在性和容量校验，不复制整份大文件卷。
3. 拉取 manifest 指定的 backend/frontend 镜像 digest。
4. 保留当前版本的 Compose 变量和用户配置，只替换业务镜像引用。
5. 启动迁移任务并等待成功。
6. 按依赖顺序重新创建 backend、worker、gateway 和 frontend 容器。
7. 等待健康检查、API、SSE、Worker 和 Gateway 状态恢复。
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

版本至少包含语义版本和 Git SHA 两种标识：语义版本用于用户理解和更新排序，Git SHA 用于构建追踪、审计和回滚定位。

### FR-UPD-008：可选组件边界

默认更新只拉取 backend/frontend 业务镜像。PostgreSQL、Redis、SearXNG 和其他基础服务只有在它们的版本被明确纳入一次发布且经过兼容性验证时才更新。

Shell sandbox 是可选 profile。普通更新不因为用户未开启 sandbox 而拉取 Debian 或 sandbox 运行镜像；只有管理员明确开启或更新 sandbox profile 时，才执行对应的镜像预检和拉取。

## 3. 技术方案

### 3.1 发布流水线

新增 GitHub Actions 发布流水线，触发条件为受保护的版本 tag，例如 `v0.4.0`：

```text
版本 tag
  → backend/frontend 构建
  → 单元测试、类型检查和镜像安全扫描
  → 推送 GHCR
  → 获取镜像 digest
  → 生成并签名 update-manifest.json
  → 创建 GitHub Release
```

镜像建议同时推送不可变版本 tag 和 digest。`latest` 可以作为开发便利标签，但不能写入生产 manifest，也不能作为回滚依据。

发布流水线必须记录构建来源、依赖锁文件摘要、Git SHA、目标架构和镜像 digest。未经流水线验证的本地镜像不能进入 stable manifest。

### 3.2 更新源与 manifest

更新器首先读取配置中的 manifest 地址。默认地址可以指向 GitHub Release 资产；当 GitHub API 不稳定或有速率限制时，改用固定 CDN/静态站点地址，内容仍由同一发布流水线生成。

Manifest 必须通过 HTTPS 获取，并校验：JSON Schema、版本格式、镜像仓库白名单、digest 格式、最低版本、架构、签名和有效期。更新器不得跟随未经校验的重定向。

### 3.3 更新执行器

新增独立的 `gugu-updater`，可以是宿主机 systemd 服务或受限 sidecar。业务 backend 通过本地受保护的 Unix Socket 调用它，不直接挂载 Docker Socket。

更新器只开放固定动作：检查状态、拉取指定 manifest、执行预检、开始更新、查看进度、查看结果、回滚指定上一版本。它不接受任意 Docker 命令、任意 Compose 文件、任意 registry 或任意宿主机路径。

更新任务采用持久化状态机：`pending`、`prechecking`、`backing_up`、`pulling`、`migrating`、`recreating`、`health_checking`、`succeeded`、`failed`、`rollback_required`。每个阶段都写入开始时间、结束时间、结果和脱敏错误摘要。

### 3.4 权限与确认

更新接口只允许 Admin Token 访问；服务端不信任前端传来的角色、版本或镜像地址。开始更新属于 destructive 运维操作，必须经过统一确认门，并使用绑定操作者、目标版本、manifest digest 和有效期的一次性确认令牌。

所有更新、回滚、预检失败和校验失败均写入 Admin 审计日志。日志不包含密码、Token、Cookie、API Key、完整环境变量或用户聊天内容。

### 3.5 Compose 与配置保护

更新器以现有 `docker-compose.prod.yml` 为唯一生产编排模板，保留用户的 `backend/.env`、Compose 变量和持久化卷。更新前必须记录当前镜像引用和 Compose 配置摘要；更新过程禁止自动执行 `docker compose down -v`、无范围 `docker system prune` 或删除卷。

数据库迁移随新 backend 镜像执行，并在应用容器重建前完成。迁移文件必须幂等，向后兼容要求在发布 manifest 中声明。

### 3.6 相关文件与目录树

```text
Gugu-web/
├── .github/
│   └── workflows/
│       └── docker-release.yml                         # 新增：构建、扫描、推送 GHCR、生成 Release
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
│   ├── ops/DEPLOY.md                                  # 修改：补充标准镜像更新和回滚操作
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

- 从 GitHub Release 获取 manifest，并能根据其中的 digest 从 GHCR 拉取正确镜像。
- 使用旧版本 Compose 配置更新到新版本，用户配置、数据库、文件和记忆数据保持不变。
- backend/frontend 更新后，API、页面、SSE、worker、gateway 和 Admin 均恢复正常。
- 预检能拦截磁盘不足、架构不匹配、manifest 无效、digest 不匹配、迁移异常和并发更新。
- 未开启 sandbox 的部署不会拉取或启动 sandbox profile 镜像。
- 更新失败可以保留现场并给出可执行恢复建议；支持回滚的版本能恢复上一组业务镜像。
- 普通用户无法访问更新接口；Admin 更新操作可在审计日志中完整追踪。

发布前使用临时 Compose 项目验证新旧版本升级、空数据库初始化、已有数据库迁移、迁移失败、容器启动失败、磁盘不足和回滚场景。先在 dev/staging 验证，再向 stable 用户开放。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| GitHub 或 GHCR 不可达 | 无法检查或拉取更新 | 支持固定 manifest 镜像/CDN、超时和明确离线状态；不自动切换未知镜像源。 |
| 镜像 tag 被覆盖 | 回滚到错误构建 | 生产只消费 digest，tag 仅用于展示和检索。 |
| 数据库迁移不可逆 | 新镜像回滚后数据不兼容 | 发布前检查迁移策略，manifest 标注回滚能力，必要时阻止回滚。 |
| 更新器拥有过高 Docker 权限 | 服务器被聊天入口间接控制 | Unix Socket、命令白名单、镜像白名单、路径白名单和独立 Admin 权限。 |
| 新旧镜像同时占用磁盘 | 更新中途空间不足 | 预检估算空间，成功后只清理明确确认的旧业务镜像，不清理数据卷。 |
| sandbox 可选依赖被误拉取 | 用户磁盘和下载时间增加 | sandbox 使用独立 Compose profile，普通更新不处理。 |

待确认事项：

- GHCR 镜像是否公开；如果私有，用户服务器凭据如何安全配置和轮换。
- 是否首版只支持 `linux/amd64`，还是同时构建 `linux/arm64`。
- 更新 manifest 是直接托管在 GitHub Release，还是发布后同步到独立 CDN。
- 失败后是否首版自动回滚，还是先停在 `rollback_required` 由管理员确认。
- Admin 更新是否允许跨环境操作，还是每个部署实例只能更新自身环境。

## 6. 唯一实施 TODO

### Phase 1：发布物与手动更新基础

- [x] `UPD2-001` 固定版本、镜像命名、架构和 manifest Schema；验收：manifest Schema 与无依赖校验器已实现，能表达版本、最低版本、镜像 digest、迁移和回滚字段，并通过本地校验。
- [ ] `UPD2-002` 🟡 建立 GitHub Actions Docker 发布流水线；验收：Workflow 已实现版本 tag 构建 backend/frontend、推送 GHCR、生成 digest 和 GitHub Release；待首次 GitHub tag 远端运行验证，构建失败不会发布 stable manifest。
- [x] `UPD2-003` 增加 manifest 签名、镜像白名单和 digest 校验；验收：发布 Workflow 生成 Cosign 签名，Compose 更新脚本校验 manifest bundle、发布者身份、镜像仓库和 digest。
- [x] `UPD2-004` 补齐 Docker Compose 升级、迁移和配置保护脚本；验收：更新脚本备份配置和数据库，保留 PostgreSQL、Redis、用户文件、记忆、工作区和 Admin 配置卷，并明确禁止 `down -v` 和无范围清理。

### Phase 2：Admin 检查与受限执行

- [ ] `UPD2-005` 实现独立 `gugu-updater` 状态 API 和持久化任务状态机；验收：预检、拉取、迁移、重建、健康检查和失败状态可查询，重复任务被拒绝。
- [ ] `UPD2-006` 接入 Admin 版本检查、Release 说明和更新确认流程；验收：Admin 能查看当前/目标版本，开始更新前展示影响并要求一次性确认令牌。
- [ ] `UPD2-007` 实现更新后健康检查和失败恢复；验收：API、frontend、worker、gateway 和数据库迁移全部通过才标记成功，失败时保留可定位日志和上一版本引用。
- [ ] `UPD2-008` 完成 dev/staging 灰度和审计验收；验收：普通用户无权更新，Admin 操作可审计，未开启 sandbox 的部署不会拉取 sandbox 镜像。

### Phase 3：可靠性增强

- [ ] `UPD2-009` 增加离线/CDN manifest、架构多平台构建和可选自动回滚；验收：更新源短暂不可用时显示明确状态，多架构镜像按宿主机选择，回滚策略经过失败迁移场景验证。
