# PRD-DEPLOY-2：一体化镜像内置沙箱管理

> 状态：提案；当前一体化镜像不自带沙箱管理，默认 Compose 通过独立 `sandboxd` 服务提供 Shell
> 创建：2026-09-27
> 最近更新：2026-09-27
> 关联模块：`Dockerfile`、`backend/docker-entrypoint.sh`、`backend/agent/sandbox/`、`docker-compose.yml`、`docker-compose.prod.yml`、`.github/workflows/docker-release.yml`
> 背景参考：`docs/prds/【已完成】PRD-DEPLOY-1-一体化镜像一键部署.md`、`docs/prds/【已完成】PRD-SHELL-1-工作区Shell沙盒.md`、`docs/superpowers/specs/2026-09-22-offline-sandbox-bundle-design.md`

## 0. 当前代码基线（改造前，不是目标态）

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 单容器部署提供 Shell 沙箱 | 🔲 待实施 | **当前行为**：直接运行一个 `gugu-web` 容器时，`Dockerfile` 默认关闭 Sandbox，入口也不启动 `sandboxd`，因此单容器部署暂时不能使用 Shell。当前需要通过 Compose 额外启动独立 `sandboxd`；本 PRD 的目标正是取消这个依赖。 |
| 默认一键 Compose 的 Shell 沙箱 | ✅ 已有能力 | `docker-compose.yml` 启动独立 `sandboxd` 与 `egress-proxy`；`sandboxd` 从 Docker Hub 拉取并验签独立 `gugu-sandbox` 镜像。 |
| 分体业务部署的严格沙箱边界 | ✅ 已有能力 | `docker-compose.prod.yml` 以 `sandbox` profile 启动独立 `sandboxd`；backend/worker 通过 Unix Socket 请求，不挂 Docker Socket；配置要求 Rootless Docker。 |
| 离线分发 | 🟡 部分完成 | 离线发布包包含 app、`gugu-sandbox`、egress 代理和搜索镜像；镜像包与 Gugu-web 镜像是两次独立导入。 |

## 1. 背景与目标

### 1.1 背景

当前代码已经把执行器和管理协议拆开：Agent Shell 经 `SandboxdClient` 调用窄接口，`sandboxd` 使用 `DockerSandboxExecutor` 创建每次命令对应的临时执行容器。但一体化镜像没有托管 `sandboxd`，用户还需要启动一个长期 `sandboxd` 服务，并单独拉取 `gugu-sandbox` 执行镜像；这与“部署一个 Gugu-web 容器即可使用 Shell”的体验不符。

2026-09-22 的一体化部署调整有意删除了应用镜像内的 Sandbox bundle，并把 Docker Socket 从 app 移到 `sandboxd`。因此本方案不能把 Shell 改成在 Web 进程内直接执行，也不能悄悄恢复到“任意 app 进程直接操作 Docker”的旧拓扑而不标注其信任边界。

### 1.2 目标

- 用户只启动一个 `gugu-web` 容器即可使用 Shell：沙箱管理进程、执行镜像和受控 egress 代理镜像均由 Gugu-web 镜像携带并在运行时管理，不需要单独部署沙箱服务、egress 服务或手动拉取 Sandbox 相关镜像。Docker Compose 不是 Shell 的前置条件，只用于同时编排 SearXNG 等可选附加服务。
- 命令仍在独立、短生命周期的 `gugu-sandbox` 容器中运行，复用现有权限判定、确认门、配额、路径校验、网络策略、输出限制、超时和清理逻辑。
- 一体化模式面向个人用户自部署，默认采用宿主 Rootful Docker 是已接受的易用性取舍；必须明确 Docker Socket 的高权限边界，不把它作为多租户或业务服务器的安全方案。
- 业务分体部署继续使用独立 `sandboxd` 和 Rootless Docker；backend、worker、gateway 不得获得 Docker Socket，且不得在沙箱服务故障时回退到本地执行。
- CI 继续并行构建 app 与沙箱运行镜像；通过轻量制品组装步骤把已扫描的沙箱镜像嵌入 app，不让耗时的 app 构建等待 Sandbox 构建。

### 1.3 明确不做

- 不在 Gugu-web、Worker、Gateway 进程内直接运行用户 Shell 命令；不将 `LocalWorkspaceExecutor` 用作 Docker 不可用时的回退。
- 不改变 `DockerSandboxExecutor` 的逐命令容器隔离与固定安全参数；Agent/模型不能获得通用 Docker API、宿主机挂载或容器创建配置权。
- 不把内置 Socket 模式作为多租户、公网或业务分体部署的安全边界；分体业务部署的现有拓扑不放宽。
- 不把 `gugu-sandbox` 执行容器变成常驻服务。每次执行、PTY、MCP stdio 仍由现有管理器按需创建和回收临时容器。
- 不将数据库、用户文件或 Shell 持久目录迁入执行镜像，也不因升级清除宿主机 Docker 镜像、网络或用户数据。

## 2. 功能需求

### FR-DEPLOY2-001：一体化镜像内启动沙箱管理器

一体化运行模式启动时，由镜像入口托管 `python -m agent.sandbox.sandboxd`，监听现有 `GUGU_SANDBOXD_SOCKET` Unix Socket，并沿用 `SandboxdClient`、`SandboxdServer` 和 `DockerSandboxExecutor` 协议。backend/worker 调用路径不新增第二套执行 API。管理器初始化失败不得触发本机 Shell 回退；Web 站点可继续服务，并通过现有沙箱状态接口明确显示不可用原因。

### FR-DEPLOY2-002：应用镜像内含已验证的沙箱运行制品

发布版一体化 `gugu-web` 镜像必须包含固定版本的 `gugu-sandbox` 执行镜像、egress 代理镜像及可校验 manifest。运行时只在目标 Docker daemon 缺少对应镜像时导入内置归档；校验失败、导入失败或本地镜像 ID/digest 不匹配时拒绝启用 Sandbox，不访问未声明的镜像源，也不改用其他镜像。

归档内的执行镜像必须与 CI 中完成 Smoke、Trivy 检查的镜像为同一 digest/image ID。egress 代理镜像固定版本/digest并纳入供应链检查。对外正式发布的一体化镜像仍由现有发布流程签名；最终应用镜像层中的 manifest 绑定所含运行镜像的引用与摘要。

### FR-DEPLOY2-003：一体化模式创建真正隔离的命令容器

Shell、PTY 与 MCP stdio 按现有协议经 `sandboxd` 创建临时子容器，不得在 app 容器直接执行。保留只读根文件系统、非 root 容器用户、`cap_drop=ALL`、`no-new-privileges`、默认断网、受控 egress、CPU/内存/PID/临时目录配额、超时、输出上限、权限撤销清理和带标签孤儿回收。用户只能访问现有 `/data/users` 归属校验允许的工作区挂载，不能指定宿主路径或 Docker 参数。

### FR-DEPLOY2-004：明确区分一体化与业务分体模式

部署模式由受信部署配置明确指定，不由模型参数决定，也不通过探测 Socket/管理器缺失来暗中切换。官方单容器启动模板显式写入 `GUGU_SANDBOX_MANAGER_MODE=embedded`；分体部署显式写入 `external`：

| 模式 | 管理器位置 | Docker 权限 | Rootless 要求 | Shell 不可用时 |
|---|---|---|---|---|
| `embedded`（一体化） | `gugu-web` 容器内的独立 `sandboxd` 进程 | 一体化容器需要宿主 Docker Socket | Rootful 是首发验收基线；单容器 Rootless 不作为本期要求 | 返回明确未就绪状态，绝不回退本地执行 |
| `external`（分体业务） | 独立 `sandboxd` 服务/进程 | 仅 `sandboxd` 持有 Rootless Docker Socket；backend/worker/gateway 仅访问窄 Unix Socket | 强制 Rootless | 拒绝执行，不回退到 backend Docker 或本机执行器 |
| `disabled` | 不启动 | 不提供 | 不适用 | Shell 显示管理员关闭或沙箱未配置 |

`docker run` 单容器模板同时设置 `SANDBOX__ENABLED=true`；Shell 的现有管理员开关、用户授权和危险操作确认仍然生效。**不支持旧 Compose 沙箱拓扑兼容，也不提供从旧独立 `sandboxd` 到内置管理器的自动迁移或回滚。**旧部署需要按新文档重新部署；数据目录不是迁移目标，沙箱改造流程不得清理它。`docker-compose.prod.yml` 的 backend、worker 显式设置为 `external`，仅在管理员启用现有 `sandbox` profile 时运行独立 Rootless `sandboxd`，边界不变。裸镜像未配置模式时按安全默认关闭 Shell，而不是根据 Socket 是否存在自动选模式。

### FR-DEPLOY2-005：单容器一体化部署前置条件与状态

官方 `docker run` 单容器部署只要求提供 Gugu-web 镜像、端口、持久 `/data`（及用户选择的配置挂载）和宿主 Docker Socket；启动模板负责设置 `GUGU_SANDBOX_MANAGER_MODE=embedded`、`SANDBOX__ENABLED=true` 和 `DOCKER_HOST`，用户不需要编写额外 Compose 文件。启动后无需另行部署或拉取 sandboxd、egress 服务或 Sandbox runtime 镜像即可使用 Shell。需要 SearXNG 等附加服务时，Compose 只负责这些可选服务的编排/打包；Shell 在没有 Compose 或所有附加服务关闭时也必须可用。Rootful Docker 是单容器模式的首发支持基线，明确承担 Docker Socket 的高权限风险；单容器 Rootless 不作为本期验收要求。缺少 Socket、daemon 不可达、bundle 校验失败、网络初始化失败或镜像未加载时，站点及数据库不因此被破坏；Admin 沙箱状态必须区分运行模式、daemon 状态、执行镜像加载状态和可操作失败原因。

`network=none` 不依赖外置服务。`network=egress` 继续走现有隔离网络与受控代理，不因容器部署位置改变而直接连接默认 bridge；代理或网络未就绪时拒绝 egress，不能静默放通网络。

### FR-DEPLOY2-006：Compose、离线包和升级一并支持内置模式

Compose 只用于可选的 SearXNG 等附加服务，不再承担 Shell 沙箱编排，也不声明 `sandboxd` 或 `egress-proxy`，不单独 pull `gugu-sandbox`/egress 镜像；app 容器内管理器自行初始化需要的 Docker 网络、按需执行容器，并在用户启用受控 egress 时按需创建代理 helper 容器。该 helper 是管理器管理的运行时依赖，不是用户要部署、配置或升级的 Compose 服务。Compose 关闭或不存在时，单容器模式仍可提供 Shell。附加服务若需与 Gugu-web 通信，部署说明提供加入同一用户定义网络的方式；它们不能成为 Shell readiness 的依赖。离线发布包中也不重复附带已经内嵌于 app 镜像的沙箱/代理镜像。

旧版 Compose 的 `sandboxd` / `egress-proxy` 拓扑不纳入兼容范围：新部署文档只描述新的单容器核心应用和可选附加服务 Compose，不做旧服务自动接管、自动清理或跨拓扑回滚。发布说明必须提示现有部署者自行规划切换；本功能不得删除或改写 `/data`、用户文件、非 Gugu 管理的镜像和网络。新拓扑发布后的常规镜像更新不属于旧拓扑兼容。

## 3. 技术方案

### 3.1 目标运行拓扑

```text
单容器一体化（可信单管理员、自管 Docker；无需 Compose）
宿主 Docker daemon
├── gugu-web 容器
│   ├── Web / Worker / Gateway / 内置 PostgreSQL / Redis
│   └── sandboxd（镜像内启动，持有 Docker Socket）
├── egress-proxy helper（sandboxd 按需创建；不由用户单独部署）
└── gugu-sandbox-*（按需创建、每次执行后清理）

可选附加服务（Compose，仅在用户需要时；通过用户定义网络连接 app）
└── SearXNG 等可选集成（不参与 Shell 创建/egress）

业务分体（多服务/更严格边界）
宿主 Rootless Docker daemon
├── backend / worker / gateway（没有 Docker Socket）
├── 独立 sandboxd（持 Rootless Socket，仅提供窄 Unix API）
├── egress-proxy（由 sandbox profile 提供）
└── gugu-sandbox-*（按需创建、每次执行后清理）
```

这里的“一体化”是**一个 Gugu-web 容器内置管理器和运行镜像**，不是把命令塞进 app 进程，也不意味着运行时不会创建执行容器。核心应用由单个 `gugu-web` 容器启动；若用户需要 SearXNG 等附加能力，再单独用 Compose 编排这些服务并按文档接入网络。应用可访问的宿主 Docker daemon 是创建临时沙箱的底层依赖，但 `sandboxd` 与 egress proxy 都由 app 内置管理器负责，不是 Compose 服务。

### 3.2 复用现有执行链，不新建执行器

Shell 工具继续通过 `SandboxdClient` 发起 `execute`、`pty_open`、`stdio_open`、`cancel` 请求；`SandboxdServer` 继续负责请求校验、并发槽、活动任务和状态探测；`DockerSandboxExecutor` 继续负责 argv 构造、路径映射、资源限制、容器生命周期和异常清理。主要改造是将管理器进程按 `embedded` / `external` 两种部署拓扑启动，并将其使用的运行制品随一体化镜像分发。

当前 `SandboxSettings` 已有 `enabled`、`rootless_required`、`image`、`image_digest`、`egress_*` 和 `sandboxd_socket` 配置；新增模式字段时必须只有一个配置事实源，并在 `/admin/.../sandbox` 状态中回报有效模式。不得用 `sandboxd_socket` 是否存在隐式推断部署模式。

### 3.3 内置运行镜像与启动导入

发布构建从同一轮已完成测试和扫描的 `gugu-sandbox` 镜像生成压缩归档及 manifest；egress 代理使用固定引用的镜像并纳入同一 manifest。manifest 至少记录 schema、镜像引用、RepoDigest、docker-save 后的 image ID 和归档摘要。`backend/agent/sandbox/offline_bundle.py` 的 schema/digest/image-ID 校验逻辑作为基础复用；现有离线发布包的“预先 docker load”行为不能直接当作容器内导入已经完成。

一体化入口在 `embedded` 模式下调用幂等初始化：确认 `/data/users` 与 Socket 可用；检查目标 daemon 中的精确镜像 ID；缺失时通过受限管理进程从只读镜像归档执行 `docker load`；再次 inspect 并匹配 manifest；仅在有效镜像存在后报告 Shell ready。不得使用浮动 `latest` 作为执行参数，命令仍按已验证 digest/image ID 固定运行。

egress 继续复用 `backend/scripts/runtime/sandbox_rootless_init.sh` 已有的隔离网络与 Squid 初始化逻辑，但将“一体化内置 bundle”作为独立的受信输入源；不可直接复用其当前在线 pull/验签路径而跳过 digest 校验。Rootless 目标 daemon 与 Socket 路径映射仍按显式配置处理。

### 3.4 进程生命周期与 Socket 信任边界

一体化 `docker-entrypoint.sh` 需要托管内部 `sandboxd` 生命周期，并将它纳入沙箱就绪状态与退出清理。沙箱管理器初始化失败不能导致 Web/数据库反复重启；Web 可用而 Shell 不可用时，应返回结构化原因。容器停止或升级时撤销活动请求并清理带 `com.gugu.sandbox=true` 标签的执行容器；不得以全局 `docker prune` 清理。

内嵌模式必须挂载 Docker Socket。当前根目录 `Dockerfile` 未声明非 root `USER`，容器进程默认以 root 运行；若沿用此进程模型，容器内的 Web/Worker/Gateway 进程也能访问挂入的 Socket。对 Rootful Docker，该 Socket 等价于宿主机高权限控制面；同一 app 容器中的代码漏洞可能进一步取得宿主 Docker 控制权。该风险是此便捷模式的明确代价，不得声称窄 `sandboxd` API 能消除容器内 Docker Socket 的权限。模式限定为可信单管理员自托管；多用户、公网及业务服务器继续使用独立 Rootless `sandboxd`。Socket 只进入一体化 app 服务，绝不挂入 `gugu-sandbox` 执行容器、业务分体 app 或 Agent 可写入的工作区。

### 3.5 发布流水线与镜像体积

昂贵的 app 构建与 `sandbox-build` 保持并行。沙箱构建继续执行 Smoke 与 Trivy；成功后导出准确的 OCI/Docker image archive 和 manifest artifact。轻量组装阶段将归档和 manifest 作为 OCI 文件系统层追加到已构建 app 镜像，必须验证原 app 的 config、入口、平台和现有层不变；最终 `gugu-web` 的版本 tag、签名、updater manifest 和 Docker Hub/GHCR digest 一律引用**带内置 bundle 的最终镜像**。执行镜像和代理镜像仍可独立发布，但一体化用户不再需要单独 pull。

独立 Trivy 扫描覆盖 app 基础镜像、沙箱执行镜像和代理镜像；bundle manifest 校验三者关系。组装层不执行不可信脚本。CI 增加对最终 app manifest/config、压缩包摘要和被嵌入镜像 ID 的检查。记录最终压缩下载体积与相对当前 app 镜像的增量，供发布说明和维护评估；**体积增长是已接受的取舍，不设“接近当前镜像体积”的发布门槛**，仍应避免无意义的重复打包。

### 3.6 文件范围与职责

```text
Dockerfile                                               【修改】内置 bundle 文件层和运行时默认模式
Dockerfile.sandbox-bundle                                【新增】从既有 app 镜像追加只读 runtime bundle 层
backend/docker-entrypoint.sh                             【修改】embedded sandboxd 启动、监控与降级状态
backend/app/core/config.py                               【修改】部署模式单一事实源及模式校验
backend/agent/sandbox/sandboxd.py                        【条件】仅在发现生命周期/启动边界缺口时修改
backend/agent/sandbox/docker_runtime.py                  【修改】bundle 镜像验证与模式感知就绪状态
backend/agent/sandbox/offline_bundle.py                  【修改】复用/扩展 manifest 校验，避免重复解析逻辑
backend/scripts/runtime/sandbox_rootless_init.sh         【修改】支持内置镜像导入和现有 egress 初始化
docker-compose.yml                                       【修改】将默认 Compose 收敛为可选附加服务栈；app 的 Shell 不依赖其中任何服务
docker-compose.offline.yml                               【修改】只覆盖可选附加服务，不再重复携带内嵌 runtime 镜像
docker-compose.prod.yml                                  【修改】显式 external 模式；继续使用独立 Rootless sandboxd 和 sandbox profile
.github/workflows/docker-release.yml                     【修改】并行构建后组装、校验、发布含 bundle 的最终 app
.github/actions/package-embedded-sandbox-bundle/action.yml 【新增】从已扫描 digest 生成并上传短期 runtime artifact
.github/actions/assemble-embedded-app-candidate/action.yml 【新增】从已有 app 基础镜像组装并验证候选 app
scripts/release/build-offline-sandbox-bundle.sh          【修改】离线发布包不重复存储 app 已内嵌的 Sandbox/代理镜像
scripts/release/build_embedded_sandbox_bundle.py         【新增】从已验证的本地镜像生成内置 runtime bundle 和 manifest
scripts/release/verify_embedded_app_image.py             【新增】验证候选 app 保留配置/平台并只追加 bundle 层
backend/tests/test_unified_image_sandbox_boundary.py     【修改】清理过时的“app 不内置 Sandbox”发布断言
backend/tests/test_docker_runtime.py                     【修改】覆盖 embedded/external 模式、镜像完整性和 fail-closed
backend/tests/test_offline_bundle.py                     【修改】覆盖内置包缺失、摘要错误、镜像 ID 错误和幂等导入
scripts/release/test_build_embedded_sandbox_bundle.py    【新增】验证 runtime bundle 镜像/摘要绑定与损坏输入拒绝
scripts/release/test_verify_embedded_app_image.py        【新增】验证候选镜像配置、层和离线 bundle smoke 的 fail-closed 行为
scripts/release/embedded-sandbox-image.test.mjs          【新增】验证候选组装定义、镜像验证和 CI runtime artifact 交接
scripts/release/docker-release-tags.test.mjs              【修改】验证最终带 bundle 镜像签名、tag 和 manifest
scripts/release/offline-bundle.test.mjs                   【修改】验证离线包不重复附带 Sandbox/代理镜像
README.md / README_en.md                                 【修改】说明单容器 Shell 前置条件、docker run 模板和 Rootful 风险
docs/quick-deploy.md / docs/quick-deploy_en.md            【修改】单容器安装、可选附加服务 Compose、Socket、离线和升级回滚说明
docs/prds/【已完成】PRD-DEPLOY-1-一体化镜像一键部署.md   【修改】同步一体化沙箱拓扑的现状与引用
```

责任边界：Agent 工具仍只依赖 Sandbox client/protocol；runtime manifest 负责不可变镜像身份；Dockerfile/release workflow 负责携带经过扫描的制品；`docker-entrypoint.sh` 负责一体化进程生命周期；Compose 只声明可选附加服务，不拥有沙箱和 egress 生命周期。不要新建第二个 Docker executor，也不要把 updater RPC、updater Docker Socket 权限和 Sandbox RPC 混为一个通用代理。

## 4. 验证与上线

- Python 定向测试：`cd backend && PYTHONPATH=. .venv/bin/pytest -q tests/test_unified_image_sandbox_boundary.py tests/test_docker_runtime.py tests/test_offline_bundle.py tests/test_terminal_streaming.py tests/test_mcp_stdio.py`。
- 内置 runtime bundle 生成器测试：`backend/.venv/bin/pytest -q scripts/release/test_build_embedded_sandbox_bundle.py`。
- 候选 app 镜像验证器测试：`backend/.venv/bin/pytest -q scripts/release/test_verify_embedded_app_image.py`。
- 发布脚本测试：`node --test scripts/release/docker-release-tags.test.mjs scripts/release/offline-bundle.test.mjs scripts/release/compose-update.test.mjs`。
- 配置校验：分别执行 `docker compose -f docker-compose.yml config --quiet`、`docker compose -f docker-compose.yml -f docker-compose.offline.yml config --quiet`、`docker compose -f docker-compose.prod.yml config --quiet`。
- fnOS 实测：用尚未正式发布的候选 `gugu-web` 镜像，在 fnOS 的单容器入口只部署 Gugu-web，挂载持久 `/data` 和 Rootful Docker Socket，不启动 Compose；Admin 显示 `embedded` 与 Rootful 状态；Shell 命令、PTY、MCP stdio 能创建临时 Sandbox 子容器；受控 egress 按需拉起镜像内置代理；重启后无需用户另行 pull runtime 镜像或部署 sandboxd/egress 服务。
- 故障与安全实测：分别移除 Socket、损坏/替换 bundle、停止 daemon、阻断 egress 网络，确认应用健康、Shell 明确未就绪、没有本机回退、没有创建超出 Gugu 沙箱标签范围的容器；检查 Sandbox 执行容器内不可访问 Docker Socket。
- 网络隔离实测：`none` 无外网；`egress` 仅经 Squid 代理出网，访问 loopback、LAN、metadata、数据库、Redis 和 Docker API 均失败。
- 分体业务回归：开启 `sandbox` profile 后 Rootless 正常运行；把 daemon 改为 Rootful 必须被拒绝；backend/worker/gateway 容器中不存在宿主 Docker Socket；暂停 `sandboxd` 时 Agent Shell 不发生本地回退。
- 部署边界：新单容器安装不启动 Compose 也能使用 Shell；Compose 仅提供可选附加服务。旧 Compose 拓扑不做自动迁移/回滚；文档清楚提示需切换到新部署方式，且相关流程不触碰 `/data` 和用户文件。
- 发布验证：最慢的 app Docker build 与 Sandbox build 并行；轻量组装不重建 app；最终发布 tag 的 config/入口/架构正确，沙箱与代理 manifest 对应 CI 已扫描 artifact，最终 app 被签名，更新清单中的 app digest 与发布 digest 一致。CI 未经用户明确授权不得手动触发。
- 版本回退：只保证仍支持 `embedded` 的版本之间按常规镜像回退；回退到不含内置管理器的旧拓扑不在兼容承诺内。任何版本回退都不得自动清理宿主 Sandbox 镜像/网络或 `/data`。

## 5. 风险与决策边界

| 风险 | 影响 | 对策 |
|---|---|---|
| 一体化 app 必须挂 Docker Socket | Rootful Socket 接近宿主 root 权限；app 容器被攻破可能控制宿主 Docker | 仅面向可信单管理员自托管；界面和部署文档明确警告；业务分体继续隔离 Socket 并强制 Rootless |
| App 镜像包含完整沙箱/代理归档 | 下载体积和 Docker 存储增加，镜像更新会重新分发对应层 | 体积增长已接受；仍测量并记录实际增量，避免重复打包，并维持镜像扫描与摘要校验 |
| 内置管理器按需创建 egress helper | helper 的网络、标签、重启和残留生命周期由 app 管理器负责 | 复用现有隔离网络与代理探测；只管理带 Gugu 标签的对象；不删未标记资源；缺少配置时 egress fail-closed |
| 旧 Compose 拓扑不兼容 | 现有使用者不能依赖自动接管旧 sandboxd 或自动回滚 | 不实现兼容层；新部署文档明确新拓扑及人工切换边界，不触碰持久用户数据 |
| 仅运行时镜像归档摘要正确但来源链不清 | 恶意/过期镜像随 app 发布 | 同轮 CI 扫描后导出；manifest 固定 RepoDigest 与 image ID；最终 app 签名覆盖 bundle 层；发布和离线包均验证摘要 |

### 已定决策

- 一体化模式面向个人用户自部署，采用 Rootful Docker 是可接受的易用性取舍；Docker Socket 相当于宿主 Docker 高权限，文档仍须醒目披露。
- 单容器首发以 Rootful Docker 为验收基线；分体业务部署仍强制 Rootless，单容器 Rootless 不阻塞本期交付。
- App 镜像体积增加可接受；记录增量但不作为发布阻断条件。
- 新一体化拓扑由容器内管理器管理 sandbox 与 egress helper；Compose 只打包 SearXNG 等可选附加服务。
- 不考虑旧 Compose 沙箱拓扑兼容，不实现自动迁移、旧服务接管或跨拓扑回滚。

## 6. 唯一实施 TODO

### Phase 1：完成实现与自动化验收

本阶段拆成可独立验收的里程碑。实现时每个子阶段聚焦测试通过后单独提交，作为可回退的调试点；子阶段内的任务合并为一个提交，不按每个 checkbox 再拆提交。后续子阶段以此前已通过的提交为基线。

#### Phase 1.1：部署模式与管理器生命周期

- [x] `DEPLOY2-001` 定义并实现 `GUGU_SANDBOX_MANAGER_MODE=embedded|external|disabled` 唯一部署模式字段；验收：模式只由部署环境指定，分体 Compose 显式设为 `external`，Shell、Admin 状态和 entrypoint 解释一致，未配置时默认禁用、无效值 fail-closed；单容器官方启动模板待 Phase 3 完成 fnOS 验收后同步更新，避免提前发布未验证的命令。
- [x] `DEPLOY2-002` 将现有 `sandboxd` 纳入一体化入口的独立子进程生命周期；验收：内嵌 manager 与 Web 同启停，manager 不健康不导致数据库/Web 重启，Shell 显示真实不可用原因且无本地 fallback。

#### Phase 1.2：Docker 执行链与 egress

- [x] `DEPLOY2-003` 为一体化配置宿主 Docker Socket 和工作区路径映射；验收：Rootful daemon 从当前容器 `/data` 挂载反查宿主路径，只映射授权数据目录；映射缺失或越界时 fail-closed，Socket 不挂入执行容器。
- [x] `DEPLOY2-004` 将现有隔离网络、代理初始化接入 embedded 目标 daemon；验收：Shell/PTY 的 `network=none` 与受控 egress 策略保持一致；egress 按需初始化 internal 网络和代理，只接管带 Gugu 标签且安全属性符合预期的资源，初始化/代理/network 不可用时拒绝执行。Sandbox/egress runtime 的离线内置与禁止在线替代拉取由 Phase 1.3 完成。

#### Phase 1.3：bundle 契约与运行时导入

- [x] `DEPLOY2-005` 扩展 bundle manifest 并实现 app 内的镜像导入/验证；验收：缺失镜像才导入，校验 digest/image ID，重复启动幂等；错误 bundle 使 Shell 未就绪且绝不在线拉取替代镜像。

#### Phase 1.4：runtime bundle 生成器

- [x] `DEPLOY2-006` 实现专用生成器，将调用方提供的固定引用/摘要和本地已构建 Sandbox、egress-proxy 镜像导出为 runtime bundle；验收：manifest 同时记录 RepoDigest、docker-save 后的 image ID 与归档 SHA-256；有 RepoDigest 时必须匹配输入摘要；bundle 可离线校验；生成器不 pull、不发布。下一阶段负责把它接在同轮镜像 Smoke/Trivy 之后，绑定被扫描的确切产物。

#### Phase 1.5.1：候选 app 镜像层定义

- [x] `DEPLOY2-007a` 增加轻量 app 镜像组装定义，仅从传入的既有 app 镜像追加 Phase 1.4 的只读 bundle 文件；验收：不重跑 app 依赖构建，不改动应用配置、entrypoint、labels 或工作目录。

#### Phase 1.5.2：CI runtime artifact 生成与交接

- [x] `DEPLOY2-007b` 将同轮构建且通过 Smoke/Trivy 的 Sandbox 镜像以不可变 digest 传给独立 bundle job；该 job 固定 egress-proxy digest，生成含归档 SHA-256 和镜像 ID 的 Phase 1.4 bundle 并上传短期 CI artifact。验收：app 构建继续与 Sandbox 构建并行；bundle job 仅在 Sandbox job 成功后启动；来源 digest 与被扫描镜像一致；代理扫描、bundle 生成和 artifact 上传均成功。该子阶段不组装或发布 app 镜像。

#### Phase 1.5.3：候选 app 镜像组装与验证

- [x] `DEPLOY2-007c` 实现候选 app 组装与自动验证；验收逻辑覆盖不重跑 app 依赖构建、最终镜像 config/entrypoint/labels/平台不变且只新增 bundle 层、bundle 摘要/image ID 校验、无网络 Shell smoke 和体积增量记录；正式 tag/发布动作留到 Phase 1.5.4。
- [ ] `DEPLOY2-007c-ci` 运行一次授权的候选 workflow，确认真实 artifact、候选 app 与宿主侧离线 Shell smoke 全链路通过，并记录 registry 压缩体积增量。代码和单测已完成；devserver 当前无法访问 Docker Hub 元数据，本机无 Docker daemon，尚未触发 GitHub CI。

#### Phase 1.5.4：正式发布接入已验证候选

- [x] `DEPLOY2-007d` 让 tag 发布只复制 Phase 1.5.3 已验证的 bundled app 候选；验收：正式版本、签名、updater manifest 均指向同一候选 digest；普通 main 构建不增加临时镜像推送；手动候选不触发正式发布。publish 等待候选组装并从其不可变 digest 复制 app；版本 tag 后解析的 digest 继续供签名与 updater manifest 使用。自动化回归确认普通 main 不推临时候选、手动候选不触发正式发布。

#### Phase 1.6：Compose 拓扑收敛

- [x] `DEPLOY2-008` 将默认、离线和生产 Compose 一起调整为新拓扑；默认/离线 Compose 的 app 显式使用内置 manager 并挂载宿主 Docker Socket，不再编排独立 `sandboxd`/`egress-proxy`；生产分体 Compose 保留 backend/worker 等业务服务，显式使用 external manager 与 Rootless，并只连接外部管理的 socket volume，不定义 `sandboxd`/`egress-proxy` 生命周期；离线 Compose 不重复挂载 app 镜像内已有的 bundle manifest。Shell 不依赖 Compose；不实现旧 Compose 拓扑自动迁移或回滚。三份 Compose、对应断言和开发记录作为同一提交更新，避免中间提交留下不一致的部署拓扑。Node 定向测试和 YAML 解析通过；因本机缺少 Compose 插件，完整 `docker compose config` 留待授权 CI 复核。

#### Phase 1.7：离线分发包收敛

- [x] `DEPLOY2-009` 调整离线分发包；验收：离线 Compose tar 只重复分发 app 与可选 SearXNG，不再额外携带已内嵌于 app 的 sandbox/egress runtime 或外置 manifest；app 首次启动仍通过镜像内部 manifest 校验归档摘要和 image ID，再按需导入目标 daemon。builder、发布 workflow 和回归测试同一提交收敛。

#### Phase 1.8：集成回归

##### Phase 1.8.1：模式矩阵与启动故障回归

- [ ] `DEPLOY2-010a` 补齐 embedded/external/disabled 模式矩阵、入口生命周期和 fail-closed 回归；验收：Rootful embedded、Rootless external 正常；Rootful external 拒绝；Docker/socket/bundle 不可用时无本地回退，并保持 Web/数据库健康。

##### Phase 1.8.2：执行隔离与资源清理回归

- [ ] `DEPLOY2-010b` 补齐 Sandbox 执行与 egress 安全边界回归；验收：`network=none`、受控 egress、bundle digest/image ID、临时容器清理，以及执行容器不可访问 Docker Socket 的测试通过。

### Phase 2：在 fnOS 部署测试候选一体化容器

- [ ] `DEPLOY2-011` 使用尚未正式发布的候选镜像，在 fnOS 单容器入口部署并验收；验收：只需 Gugu-web 主容器、持久 `/data` 和 Docker Socket；无需 Compose、独立 `sandboxd`、egress 服务或手动拉取 runtime；Shell 命令、PTY、MCP stdio、受控 egress、重启后恢复及 Admin 状态均按 FR-DEPLOY2-005 工作，且用户数据不丢失。记录实际问题并先修复、复测，通过后再进入文档阶段。

### Phase 3：根据 fnOS 实测结果更新文档

- [ ] `DEPLOY2-012` 更新 DEPLOY-1、Shell 部署文档、中英文快速开始及简短 changelog；验收：文档命令与 fnOS 实测一致，单容器 `docker run` 模板显式设置 `GUGU_SANDBOX_MANAGER_MODE=embedded`、`SANDBOX__ENABLED=true`、`DOCKER_HOST` 并挂载 Docker Socket；明确 Rootful 风险、无需 Compose/sandboxd/egress、可选附加服务 Compose、旧拓扑不兼容，以及分体业务部署仍要求 Rootless；changelog 只写用户可感知变化。

### Phase 4：正式发布

- [ ] `DEPLOY2-013` 执行正式 CI 与镜像/版本发布；验收：Phase 1 自动化测试、Phase 2 fnOS 验收和 Phase 3 文档均完成后才发布；发布镜像、签名、manifest 和更新清单都指向含内置 bundle 的同一最终 digest，记录正式版本与镜像摘要。
