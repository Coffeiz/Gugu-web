# PRD-SHELL-1：工作区 Shell 沙盒

## 1. 文档信息

- 状态：P0–P5 已完成代码收口；受控 egress 的 Compose 代理、隔离网络和 sandboxd 门禁已完成，P6 的生产 ACL apply、真实网络回归与逐用户验收仍进行中
- 目标：默认使用用户独立沙盒；工作区只作为默认目录，再评估 Docker/Podman 后端
- 首版平台：devserver/Linux 本机执行
- 后续平台：macOS、Windows 复用执行器接口，暂不承诺相同隔离强度

### Autopilot 授权模式

- Admin 通过 `shell_autopilot_enabled` 控制总开关；关闭时个人设置隐藏用户级 Autopilot 选项。
- 用户开启后，当前用户的 Shell 危险命令跳过确认门；仍必须经过执行范围、沙盒、配额、超时、进程清理和审计校验。
- Autopilot 不授予 root，不解除 Docker/Rootless 隔离，也不改变 system executor 的独立权限开关。
- 默认关闭；关闭 Admin 总开关或用户开关后立即失效。
- 相关能力：Agent 工具、用户设置、会话绑定、文件库工作区

## 2. 背景

咕咕需要能够在用户明确授权后执行项目构建、测试、文件整理和诊断命令。直接在宿主机执行任意 Shell 会带来路径越权、凭据泄露、后台驻留、服务破坏和跨用户访问风险。

本阶段先做“本机用户沙盒执行器”：执行进程仍运行在当前系统用户下，但所有权限、路径、命令风险、超时和输出边界都由 Gugu-web 在执行前后统一校验。Docker/Podman 作为后续更强隔离层，不阻塞本阶段落地。

## 3. 版本策略

本 PRD 按执行链路拆成六个阶段。先完成权限和执行范围基础，再落地本机执行器，最后补工具注册、确认门、审计和回归测试。每一阶段都保持可独立验证，不提前暴露尚未实现的 Shell 工具。

### 执行模式与工作区

Shell 只维护两种执行模式：

| 模式 | 执行位置 | 默认值 | 说明 |
|---|---|---|---|
| `sandbox` | 用户独立沙盒 | ✅ | 默认模式；工作区只决定默认 `cwd` 和需要挂载的目录 |
| `system` | 宿主机受控执行器 | 关闭 | 高权限模式；必须同时通过 Admin 总开关、用户权限和危险命令策略 |

工作区不再是 Shell 权限范围。它只负责提供当前会话的默认目录、可挂载目录和上下文名称：绑定工作区时，`sandbox` 默认进入该工作区；未绑定时，`sandbox` 使用用户沙盒根目录。`system` 模式也可以使用绑定工作区作为默认 `cwd`，但不因此扩大或缩小系统执行器的权限。

`shell_enabled` 是所有模式共用的总开关。Shell 模式由服务端根据权限和当前会话状态决定，模型不能传入 `scope`、`session_id` 或宿主机路径自行切换。

### 3.1 当前阶段：权限与执行器基础

- Admin 总开关默认关闭。
- 关闭时完全不注册 Shell 工具，并在 dispatch 层拒绝旧请求。
- 开启后默认提供 `sandbox`；切换到 `system` 仍需额外的 Admin/用户权限和危险命令确认门。
- “本机执行”仅指使用当前系统用户权限，不等于 root、`sudo` 或系统级权限。
- 沙盒不接受宿主机绝对路径，不允许挂载工作区以外的目录；系统范围仅在独立 Admin/用户开关均开启时可用。
- 保留执行超时、输出大小、后台进程和敏感路径等边界。
- 危险命令另设独立的 Admin 总开关和用户个人开关，两个开关默认关闭。
- 危险命令即使两个开关都开启，仍必须经过现有逐次确认门。

### 3.2 后续阶段：隔离增强

- 增加 Docker/Podman 沙盒执行器。
- 在容器内复用同一 `ShellSandbox` 接口和权限快照。
- 根据平台评估 macOS Seatbelt、Windows WSL2/AppContainer 等增强隔离。

#### Rootless Docker 部署方案

首版容器执行器优先使用宿主机上的 Rootless Docker，而不是让业务进程直接连接 root Docker socket，也不在用户容器内部运行 Docker。

```text
宿主机
└── gugu-sandbox 系统用户
    └── Rootless Docker daemon
        └── 每用户一个受限沙盒容器
```

- `sandboxd` 作为独立执行服务运行，Gugu Web/Worker 通过受限 API 调用，不直接持有 root Docker socket。
- 容器基础镜像首版使用固定 digest 的 `debian:bookworm-slim`；容器内部使用非 root 用户 `gugu`。
- 宿主机需要启用 user namespace、cgroup v2，并准备 `fuse-overlayfs`；Rootless Docker 通过 systemd lingering 保持后台运行。
- 禁止 `privileged`、host network、host PID、任意宿主机挂载、Docker-in-Docker 和未经批准的设备映射。
- 用户数据只允许挂载对应用户的数据卷和当前工作区目录；镜像根文件系统只读，临时目录单独限制大小。
- 低端口映射、部分内核能力和高级网络能力属于 Rootless Docker 的已知限制，Shell 沙盒不依赖这些能力。
- Rootless Docker 不可用时，沙盒不能开启，Shell 不得回退到本机执行器。

当前本机执行器的安全定位：

- `LocalWorkspaceExecutor` 只适用于开发环境、单用户自托管和明确可信用户。
- 它可以提供 cwd、参数路径、超时、输出和进程清理限制，但不能提供真正的文件系统或网络隔离。
- 允许执行 Python、Node、pytest、npm、make 等程序时，程序自身仍可能通过系统调用访问当前 Unix 用户有权限访问的宿主机资源。
- 普通用户、多租户和公网部署不得把 `LocalWorkspaceExecutor` 当作安全边界。
- 生产普通用户必须经过 `sandboxd -> DockerSandboxExecutor`；Docker 不可用时直接拒绝，不回退本机执行。

#### Docker 固定安全基线

以下参数由 `DockerSandboxExecutor` 固定注入，不能由用户命令、Skill 或普通 Admin 表单覆盖：

- `cap_drop=ALL`
- `no-new-privileges`
- 固定 seccomp profile 和 AppArmor profile
- 非 root UID/GID
- 只读 rootfs
- `network=none`（默认）
- pids、memory、CPU quota、tmpfs 和 ulimit 限制
- 禁止 `privileged`、host network、host PID、任意宿主机挂载、设备映射和 Docker-in-Docker

危险命令分类只用于误操作确认，不是安全边界：

```text
命令 / LLM
  -> Capability：是否允许 Shell
  -> Intent：safe / write / dangerous，是否确认
  -> Sandbox：文件系统、网络、UID、能力和 cgroup 隔离
  -> Runtime：超时、输出、进程、配额和审计
```

核心原则：危险命令识别保护用户免于误操作，Docker 沙盒保护平台免受命令本身影响。

#### 网络 profile

网络权限独立于命令风险和 Shell 权限：

- `none`：默认，容器无外网和内网访问。
- `egress`：用户明确授权后的临时外网访问，用于安装依赖或下载资源；必须阻断 loopback、RFC1918/LAN、数据库、Redis、metadata endpoint、Docker daemon 和 Gugu 内部 API。
- `internal`：首版不开放；不能让用户容器直接访问 Gugu 内部网络。
- egress 必须通过独立隔离网络和受控 HTTP(S) proxy；不能把 Docker `bridge` 或代理环境变量当作安全边界，因为容器内脚本仍可能绕过代理直连。

#### 临时 egress 授权实现状态

- Shell 工具支持 `network=none|egress`，默认仍为 `none`。
- `network=egress` 只能用于 sandbox，首次使用需要当前会话确认；确认凭证绑定 session、范围和 workspace，默认 TTL 为 10 分钟。
- sandboxd 会校验 `network_profile`、未来时间戳、代理格式、隔离网络开关和 Docker 网络存在性；过期、网络不存在或未部署时拒绝执行。
- Docker Compose 已提供独立的 `egress-proxy` 和内部网络 `gugu-sandbox-egress`：沙盒容器只加入内部网络，代理同时连接默认网络并负责访问公网，容器不能通过默认网络绕过代理。
- Compose 中默认注入 `SANDBOX__EGRESS_PROXY_URL=http://egress-proxy:3128`、`SANDBOX__EGRESS_NETWORK_NAME=gugu-sandbox-egress` 和 `SANDBOX__EGRESS_ISOLATION_ENABLED=true`；非 Compose 部署必须自行提供等价的受控 HTTP(S) 代理和 Docker 网络。
- `sandboxd` 在 Docker 权限边界内再次校验代理、网络名和网络是否存在；网络不存在、代理无效或授权过期时拒绝执行并保持断网。Web/Worker 不直接持有 Docker socket。
- 代理配置位于 `squid/egress.conf`，默认拒绝 loopback、RFC1918/LAN、link-local、IPv6 私有地址和其他明显内部目标；不得改成普通 Docker `bridge`，也不得把 Docker socket 暴露给业务进程。

配置流程：

```bash
# Compose：创建代理和 sandboxd，内部网络会由 Compose 自动创建
docker compose up -d egress-proxy sandboxd
docker compose restart backend worker

# 检查服务与网络
docker compose ps egress-proxy sandboxd
docker network inspect gugu-sandbox-egress
```

启动后在 Admin → Shell 沙盒打开“临时公网访问”。该开关只是允许当前会话选择
`network=egress`；每个会话首次使用仍需确认，默认授权 TTL 为 10 分钟。

非 Compose 部署需要在 `config.override.json` 的 `sandbox` 节配置：

```json
{
  "sandbox": {
    "egress_proxy_url": "http://127.0.0.1:3128",
    "egress_network_name": "gugu-sandbox-egress",
    "egress_isolation_enabled": true
  }
}
```

同时必须让运行 sandboxd 的 Rootless Docker daemon 能看到该网络，并重启
`gugu-sandboxd`、`gugu-backend` 和 `gugu-worker`。代理 URL 不得包含用户名、密码或其他凭据。

#### 持久空间与临时空间

Shell 空间拆分为两类，避免构建缓存挤占长期用户文件：

- 持久用户空间：默认 `512 MB`，用于用户文件、脚本和工作区数据。
- 临时构建/cache 空间：默认 `1 GB`，用于 `node_modules`、Python venv、Rust target、前端构建缓存和临时产物；任务结束或容器销毁时可以回收。
- Admin 可以分别配置两类空间；两者都必须通过统一配额服务计量。
- OSS 文件库配额与 Shell 持久空间、临时空间分开计算。

#### Rootless ACL 初始化开关

Rootless Docker 对宿主机用户目录的 bind mount 需要使用 subordinate UID/GID 对应的 ACL。ACL 初始化属于部署操作，不进入 Web、Worker 或普通 sandboxd 请求路径，也不由 Compose 容器隐式提权执行。

默认启动不会修改宿主机权限。部署人员可以通过 Make 显式选择：

```bash
# 只输出计划
make sandbox-acl-plan ROOTLESS_LOGIN=gugu-sandbox

# 启动/安装前应用 ACL
SANDBOX_ACL=1 make start ROOTLESS_LOGIN=gugu-sandbox
SANDBOX_ACL=1 make install RUN_USER=gugu-sandbox

# Compose 复用同一宿主机初始化流程，并启用 sandbox profile
SANDBOX_ACL=1 make compose-up ROOTLESS_LOGIN=gugu-sandbox
```

未传入 `SANDBOX_ACL=1` 时，`make start`、`make restart`、`make install` 和 `make compose-up` 均跳过 ACL 修改。直接执行 `docker compose up` 也不会自动应用 ACL；`--profile sandbox` 只负责启动 sandboxd。初始化脚本只处理 `Gugu-data/users/*/shell`，不修改业务容器、镜像、数据库或其他用户目录。

#### system 模式边界

`system` 模式不是普通用户沙盒能力：

- 多租户或公网部署中，`system` 默认不可用，即使 Admin 打开普通 Shell 也不能授予。
- 只有本地自托管或单用户部署，且 Admin 明确开启时，才允许启用 system executor。
- system executor 与 Gugu-web 共享宿主机 Unix 用户权限，必须继续使用独立的超时、输出、进程和审计限制。

#### 镜像许可证

- `gugu-sandboxd`、执行器和咕咕自有代码使用 Apache License 2.0。
- `debian:bookworm-slim`、Debian 软件包及其他依赖继续遵循各自许可证，不因咕咕代码使用 Apache-2.0 而改变许可证。
- 发布镜像时保留 Apache-2.0、基础镜像版权声明和第三方许可证清单。

#### 容器化后的旧路径限制收敛

容器执行器稳定后，可以清理本机执行器中重复的路径穿越和旧 scope 兼容代码，但不能在容器执行器上线前直接删除。

- 容器内只挂载用户沙盒和当前工作区，路径边界由容器挂载、只读根文件系统和非 root 用户共同提供。
- `LocalWorkspaceExecutor` 只保留开发测试用途；生产 Shell 统一经过 `sandboxd` 和 `DockerSandboxExecutor`。
- 容器执行器迁移完成后，删除旧的 `personal/workspace` scope 分支、旧 `shell_scope` 兼容逻辑以及业务层重复路径解析。
- 保留 Shell API 的相对 cwd 校验、非法挂载拒绝、软链接逃逸检查和 sandboxd 的参数校验，不能把 Docker 隔离当作唯一防线。
- 清理前必须通过绝对路径、`..`、软链接、挂载边界、用户切换和容器重建回归测试；失败时继续保留旧限制。

目标结构：

```text
Shell 工具
  -> 权限策略
  -> sandboxd
  -> DockerSandboxExecutor
  -> 容器内路径与资源限制
```

### 3.3 用户文件存储迁移

当前本地存储统一使用仓库同级的 `Gugu-data/users`。历史 `backend/uploads` 只由一次性迁移脚本读取，不再作为运行时用户目录。

- 迁移由 `backend/scripts/migrate_storage_root.py` 执行。
- 默认先 dry-run，`make storage-migrate` 或 `make update` 才执行复制和配置切换。
- 迁移按 SHA-256 校验；相同文件跳过，目标冲突时中止，不覆盖目标文件。
- 迁移完成后更新 `config.override.json.storage.local_path` 为 `../Gugu-data/users`。
- 迁移完成后不再创建、挂载或维护 `backend/uploads`；旧目录删除由部署人员在确认迁移校验通过后单独执行。
- 已安装 systemd 服务由 `make update` 停止、迁移、重新生成可写目录白名单并启动。
- 迁移失败不得切换配置，服务继续使用旧存储根目录。

### 3.4 OSS 模式下的 Shell 配额

当 `storage.backend=oss` 时，OSS 文件库不可直接挂载到 Shell 容器。此时文件库继续使用 OSS 配额，Shell 沙盒使用独立的本地用户空间，只服务于 Shell 执行，不与 OSS 文件库共用容量。

- Shell 持久空间默认配额为 `512 MB`；临时构建/cache 空间默认配额为 `1 GB`。
- Admin 的用户配额管理页面增加 Shell 沙盒配额配置和已用空间展示。
- Shell 配额按用户保存；持久文件、下载内容、生成构建产物和临时缓存分别计量。
- 超出对应配额时拒绝写入、下载和生成，不影响用户在 OSS 文件库中的空间。
- 删除持久文件或回收临时缓存后释放对应配额。
- `system` Shell 不使用 Shell 沙盒配额，继续使用独立的临时目录、输出大小和执行时长限制；多租户部署默认禁用。
- 本地存储模式下，Shell 可以继续复用 `Gugu-data/users/<user-id>`，但仍应维护独立的 Shell 配额统计。

建议配置字段：

```text
shell_quota_bytes
shell_used_bytes
shell_ephemeral_quota_bytes
shell_ephemeral_used_bytes
shell_quota_updated_at
```

### 3.5 Admin 沙盒管理

容器沙盒完成后，Admin 增加独立的“Shell 沙盒”管理页面，作为 Shell 的运行时总闸门和容器状态入口，不把 Docker 参数暴露给普通用户，也不要求管理员手动填写容器命令。

- 页面显示沙盒状态：已关闭、Docker 未安装、Docker 未运行、容器执行器就绪或初始化失败。
- 沙盒默认关闭。关闭沙盒时，Shell 工具不注册且 dispatch 继续拒绝旧请求；不会删除用户文件、Shell 空间或已配置的配额。
- 只有检测到本机 Docker CLI 和可用 Docker daemon 后，才允许打开沙盒；Docker 未安装或 daemon 不可用时，开关保持禁用并显示原因。
- 管理员打开沙盒后，后端自动校验并初始化受限执行环境：固定镜像、非 root 用户、只读根文件系统、用户空间挂载、断网和 CPU/内存/进程/超时限制。初始化失败时不打开开关，并返回结构化错误。
- 管理员关闭沙盒后，只停止或回收 Shell 容器运行态，不清理用户数据；再次打开时按用户需要重新创建容器。
- Admin 页面只管理全局沙盒开关和运行状态；危险命令、用户 Shell 权限和用户配额继续沿用各自的权限/配额入口。
- 沙盒状态必须由后端事实源返回，不能由前端仅根据配置值推断“可用”。Shell 工具注册、dispatch 和执行器三层都必须检查沙盒就绪状态。

建议接口：

```text
GET   /api/v1/admin/sandbox/status
POST  /api/v1/admin/sandbox/enable
POST  /api/v1/admin/sandbox/disable
POST  /api/v1/admin/sandbox/egress/config
POST  /api/v1/admin/sandbox/egress/validate
```

建议状态字段：

```text
enabled
docker_installed
docker_daemon_ready
executor_ready
egress_proxy_configured
egress_available
egress_config_error
state
message
image
updated_at
```

#### 沙盒生命周期权限

沙盒的运行控制需要区分用户自助操作和 Admin 管理操作，不能把容器控制参数直接暴露给用户。

用户可以对自己的沙盒执行：

- **重启沙盒**：停止并重新启动当前容器，保留用户文件、挂载卷和配额记录。
- **重建沙盒**：删除旧容器并按当前系统配置重新创建容器，保留用户数据卷，不允许选择镜像、挂载路径、网络、资源上限或启动参数。
- 用户重启/重建需要冷却时间、并发限制和操作确认；失败时返回容器状态和可见原因。

Admin 可以执行：

- 查看单个用户沙盒的状态、资源占用、配额和最近错误。
- 重启或重建单个用户沙盒。
- 在维护场景下批量重启或重建沙盒。
- 配置镜像版本、CPU、内存、进程数、执行时长和磁盘配额。
- 强制停止异常、超限或违反策略的沙盒。

以下操作必须严格区分：

- **重启**只改变容器生命周期，不改变容器数据。
- **重建**只替换容器实例，默认保留用户数据卷；镜像更新或配置变更后使用重建使其生效。
- **清空沙盒**是独立的破坏性操作，会删除用户沙盒文件，不能隐含在重建、重启或关闭沙盒中，必须使用单独确认门。

全局关闭沙盒时停止或回收容器运行态，但不删除用户数据和配额分配。用户操作只能影响自己的沙盒，Admin 的批量操作需要记录审计日志。

建议接口：

```text
POST /api/v1/sandbox/restart
POST /api/v1/sandbox/rebuild
POST /api/v1/admin/sandbox/users/{user_id}/restart
POST /api/v1/admin/sandbox/users/{user_id}/rebuild
POST /api/v1/admin/sandbox/users/{user_id}/clear
```

## 4. 目标与非目标

### 4.1 首版目标

- Admin 可以全局开启/关闭 Shell 能力。
- Admin 关闭时，所有用户禁止使用，用户页面不显示 Shell 设置。
- 用户可以在个人设置中开启/关闭自己的 Shell 能力，并在允许时选择 `sandbox/system` 模式。
- 新会话默认使用 `sandbox`，不绑定工作区；绑定工作区后只改变默认目录，不改变 Shell 权限模式。
- 用户或咕咕可以为当前 session 绑定、切换、解除工作区。
- 工作区可以来自文件库文件夹或项目。
- 用户未开启 Shell 或系统总开关关闭时，不向 Agent 暴露 Shell 工具。
- `sandbox` 仅允许访问用户沙盒根目录及当前工作区挂载目录；`system` 使用独立的系统执行策略。
- 本机执行器不提供可信网络隔离；普通用户只能通过容器的 network profile 获得网络边界。
- 危险命令必须经过确认门。
- 记录结构化审计信息，不记录密钥、完整用户输入或敏感命令输出。

### 4.2 当前阶段不做

- 不开放宿主机 root shell，也不把宿主机 root 作为普通 Shell 能力开放。
- `system` 模式受独立 Admin/用户开关控制；关闭 system 不影响默认 `sandbox`。
- 不允许通过参数访问任意宿主机目录、Docker socket 或提权接口。
- 不支持任意远程主机执行。
- 不在 Phase 0-4 中实现 Docker/Podman、macOS Seatbelt 或 Windows AppContainer；这些属于 Phase 5 隔离执行器。
- 不允许模型自行创建或修改工作区边界。

## 5. 核心概念

### 5.1 Workspace

Workspace 是用户级执行边界，可引用文件库文件夹或项目。

```text
Workspace
- id
- user_id
- name
- kind: folder | project
- folder_id
- project_id
- enabled
- is_default
```

首版不保存任意宿主机路径。文件库文件夹和项目由服务端解析为真实目录，避免模型直接传入路径。

### 5.2 Session 绑定

```text
ConversationSession.workspace_id: nullable
```

- 新会话默认为 `null`。
- 不自动继承上次会话或用户默认工作区。
- 绑定、切换、解除只影响当前 session。
- 工作区被删除、禁用或用户失去权限时，session 视为未绑定。

### 5.3 执行模式

首版统一为：

```text
sandbox：用户独立沙盒；绑定工作区时挂载并进入当前工作区
system：宿主机受控执行器，仅在独立权限开启后可用
```

## 6. 权限模型

### 6.1 全局与用户权限

```python
shell_allowed = settings.agent.shell_enabled and is_local_admin(request)
```

要求：

- `shell_enabled` 默认值为 `true`，允许使用受沙盒隔离的 Shell 工具；
- Admin 关闭后立即停止新调用；
- 工具注册和 dispatch 都必须检查开关；
- 关闭时用户页面不显示 Shell 相关设置；
- 已经启动的命令由执行器超时/终止机制负责收尾；
- 本机执行器不可用时返回明确错误，不回退到其他目录或未授权执行器。

最终模式和权限必须由服务端计算：

```python
shell_allowed = admin_shell_enabled and user_shell_enabled
sandbox_allowed = shell_allowed
system_allowed = shell_allowed and admin_system_enabled and user_system_enabled
mode = "system" if session.shell_mode == "system" and system_allowed else "sandbox"
```

权限判断必须同时位于：

1. 工具注册阶段：无权限时不把 Shell 工具放进模型工具列表；
2. dispatch 阶段：拒绝旧请求、缓存工具定义或手工构造请求绕过开关；
3. 执行器启动阶段：再次校验 workspace 所属用户、状态和真实路径。

当前首版使用以下最终权限：

```python
sandbox_allowed = admin_shell_enabled and user_shell_enabled
system_allowed = sandbox_allowed and admin_system_enabled and user_system_enabled
mode = "system" if requested_mode == "system" and system_allowed else "sandbox"
```

请求 `system` 但权限不满足时不得静默提升或执行宿主机命令，应返回明确的权限错误；默认会话直接使用 `sandbox`。关闭 system 不影响 sandbox，只有 `shell_enabled` 总开关会关闭全部 Shell。

Admin 关闭总开关时：

- 所有用户立即不可用；
- 用户设置页隐藏 Shell 设置；
- 用户之前的个人开关保留但不生效；
- Admin 重新开启后恢复之前保存的个人开关。

危险命令使用独立的双重开关，不与普通 Shell 工具开关混用：

```python
dangerous_allowed = (
    admin_shell_enabled
    and admin_dangerous_shell_enabled
    and user_shell_enabled
    and user_dangerous_shell_enabled
    and mode in ("sandbox", "system")
)
```

判定规则：

- Admin 未开启 Shell 工具时，危险命令和普通 Shell 都不可用；
- Admin 未开启危险 Shell 命令时，危险命令硬拒绝；
- 用户未开启危险 Shell 命令时，危险命令硬拒绝；
- 双方开关都开启后，危险命令仍返回 `needs_confirmation`，不得由开关绕过逐次确认；
- `confirm=true` 只能通过已经开启的危险权限和既有确认门，不能绕过任一开关；
- Admin 关闭危险开关时保留用户原有个人设置，重新开启后恢复其状态。

## 7. Agent 工具设计

### 7.1 工具名

```text
shell
```

### 7.2 输入

```json
{
  "command": "npm test",
  "cwd": ".",
  "timeout": 30,
  "max_output_chars": 12000
}
```

首版不接受 `root_path`、宿主机绝对路径或任意 `scope`。模式由服务端策略决定，默认目录由当前 session workspace 决定。

### 7.3 输出

```json
{
  "ok": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "timed_out": false,
  "workspace_id": "...",
  "cwd": "."
}
```

输出必须经过长度限制和敏感信息脱敏。工具错误只返回用户可理解的脱敏信息，原始异常进入受限诊断日志。

### 7.4 没有工作区时

Shell 仍可在 `sandbox` 模式执行，默认目录为该用户的沙盒根目录。咕咕不得自行猜测宿主机目录；如果用户要求操作某个工作区，应先绑定或明确选择工作区。

### 7.5 危险命令开关

危险命令设置分别位于：

- Admin Agent 设置页：`shell_dangerous_enabled`，控制系统是否允许危险命令进入确认流程；
- 用户工具权限设置：`shell_dangerous_enabled`，控制当前用户是否允许危险命令进入确认流程。

用户页面只在 Admin 已开启 Shell 工具时显示 Shell 设置；危险命令开关在 Admin 未开启危险命令时保持禁用，并明确提示管理员限制。设置页面不能代替服务端策略校验。

## 8. 工作区操作

### 8.1 用户命令

```text
/workspace
/workspace list
/workspace use 项目A
/workspace unlink
```

### 8.2 Agent 工具

```text
workspace_list
workspace_current
workspace_bind
workspace_unbind
```

`workspace_bind` 和 `workspace_unbind` 只修改当前会话，不修改用户全局默认设置。绑定不存在或无权访问的工作区时必须返回明确错误。

## 9. 本机执行器

### 9.1 执行边界

```text
- 使用 Gugu-web 当前系统用户启动子进程
- sandbox 的 cwd 只能是沙盒根目录或当前 workspace 挂载目录的子目录
- system 的 cwd 默认跟随 workspace，但必须经过系统执行器的独立路径策略
- 不接受宿主机绝对路径、额外挂载和任意环境变量
- 环境变量使用最小白名单，不继承密钥、Token 和数据库连接信息
- 默认不主动联网；需要联网的命令按风险策略拒绝或单独确认
- 每次执行都有超时、输出上限和进程树清理
- 禁止 sudo、su、pkexec、系统服务管理和提权命令
```

### 9.2 路径限制

- sandbox 的 `cwd` 必须解析到沙盒根目录或 `/workspace` 挂载点内部。
- 拒绝 `..` 逃逸、绝对宿主机路径和未授权挂载。
- 解析真实路径后再次检查是否仍在沙盒根目录或当前 workspace 根目录下。
- 拒绝通过软链接逃逸到 workspace 外部。
- 容器只挂载当前 workspace，不挂载用户 home、数据库、配置文件或密钥目录；未绑定 workspace 时不挂载工作区。

### 9.3 资源限制

本机执行器默认值：

```text
timeout：30 秒，Admin 可配置上限 300 秒
max_output_chars：12000
memory/cpu/pids：由宿主机进程限制能力和后续沙盒阶段补齐
network：策略层默认拒绝联网命令
```

超时必须终止整个进程树，不能只终止 Shell 父进程。若无法确认进程树已收束，执行器必须返回失败，不得继续接受下一次同 workspace 执行。

### 9.2 Docker/Podman 后续执行器

Docker/Podman 不属于当前首版交付。后续只实现 `ShellSandbox` 的另一种后端，提供非 root、只读根文件系统、workspace 单独挂载、默认断网、资源限制和容器销毁。Docker/Podman 不可用时，不能自动回退到更高权限的宿主机执行器。

### 9.3 Phase 5 可用性评估（2026-08-24）

| 检查项 | 结果 | 结论 |
|---|---|---|
| devserver 操作系统 | Linux 7.0.0 x86_64 | 满足首版 Docker 后端目标平台 |
| Docker | 29.1.3，可通过 `/var/run/docker.sock` 访问 | 技术上可接入，但当前是 rootful daemon，不能直接作为不受限的 Agent 子进程入口 |
| Podman | 未安装 | 本阶段不选 Podman |
| cgroup | cgroup v2 | 可实现 CPU、内存和进程数限制 |
| 隔离能力 | AppArmor、seccomp、overlayfs、user namespace 可用 | 满足容器安全基线的必要条件，但仍需显式配置，不代表默认安全 |
| 资源 | 4 CPU、约 7.8 GiB 内存 | 可运行轻量命令容器 |
| 磁盘 | 根分区约 50G，剩余约 1.4G（98% 已用） | 当前阻塞项，不能安全拉取新镜像或建立 workspace 临时层 |
| Docker 存量 | 镜像约 13.14G，构建缓存约 8.7G | 需要清理或单独规划容器存储配额 |

**评估结论：部分可用，暂不启用。** Docker 运行时和 Linux 隔离能力已具备，容器版执行器的接口适配难度不高；但 rootful Docker socket 和磁盘余量是两个上线前阻塞项。当前不能把 Docker socket 暴露给 Agent，也不能在磁盘未清理前自动拉取基础镜像。

### 9.4 Rootless Docker 实测（2026-08-25）

- devserver 已安装 `uidmap`、`rootlesskit`、`slirp4netns`、`fuse-overlayfs`，并为 `coffeiz` 开启 user lingering。
- Ubuntu 的 AppArmor `apparmor_restrict_unprivileged_userns=1` 已通过官方建议的 RootlessKit 专用 profile 放行；rootful Docker daemon 和 Gugu 服务未停用。
- 用户级 Rootless Docker 29.7.2 已运行在独立 socket：`/run/user/1000/docker.sock`，不使用 `/var/run/docker.sock`。
- 三个 Gugu systemd 服务的模板已由 `start.sh install` 自动写入运行用户 UID 对应的
  `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`；服务进程不会因缺少交互式环境变量而误连 rootful socket。
- 运行时探测和执行器同时自动发现当前用户的 `/run/user/<uid>/docker.sock`；显式
  `DOCKER_HOST` 优先，Rootless socket 不存在时不伪装为可用，Rootless 要求不满足则拒绝执行。
- 因为执行器固定使用 `--pull=never`，readiness 还会对当前 Docker daemon 执行
  `image inspect image@digest`；镜像未加载时拒绝启用/执行，不把首次失败留到用户命令阶段。
- 固定测试镜像为 `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`。
- 与 `DockerSandboxExecutor` 相同的参数已完成 smoke test：容器 UID `65532`、workspace 可写、根文件系统不可写、`network=none` 生效，rootful Gugu 三个服务保持 active。
- Rootless bind mount 的写权限依赖 subordinate group 映射；用户沙盒目录初始化必须设置对应 group/默认 ACL，不能只创建普通用户目录。该初始化仍是生产启用前的待办。

权限初始化采用显式部署步骤：`backend/scripts/prepare_rootless_workspace.py` 默认只输出
计划，只有部署人员明确传入 `--apply` 才会创建目录并设置 ACL。脚本从 `/etc/subuid`
和 `/etc/subgid` 解析 Rootless 登录用户的映射，把容器 `65532:65532` 映射到宿主机
subordinate UID/GID；宿主机登录用户继续保留目录 owner，映射组通过 ACL 获得读写执行权限，
并设置默认 ACL 供容器新建文件继承。Web/Worker 请求路径不执行 `chown`、`setfacl` 或任何
提权操作；生产环境应由 sandboxd/部署服务完成初始化。目录必须经过路径审计，禁止对 `/`、
用户 home 根或未配置的存储根目录直接应用计划。

**Phase 5 开始前必须完成：**

1. 为 Gugu-web 准备独立的 rootless Docker daemon，或使用受限的专用执行服务，避免业务进程直接持有 rootful Docker socket。
2. 清理 Docker build cache/无用镜像并预留容器存储空间；至少保证基础镜像、workspace 临时层和输出缓冲有明确配额。
3. 固定基础镜像 digest，禁止工具根据用户输入选择镜像、挂载路径、特权模式或 Docker socket。
4. 明确容器参数：非 root 用户、`--read-only` 根文件系统、workspace 单独可写挂载、默认 `--network=none`、tmpfs 大小、CPU/内存/PID 限制和强制销毁。
5. 用最小固定镜像完成 smoke test；当前已实现 `DockerSandboxExecutor` 的固定参数构建、digest 校验和执行结果契约，但在 Rootless Docker、镜像 digest 和 devserver smoke test 完成前不得打开生产开关。

## 10. 命令风险策略

### 10.1 safe

允许直接执行：

```text
pwd、ls、find、rg、cat、head、tail、git status、git diff
pytest、npm test、pnpm test、构建和静态检查命令
```

### 10.2 write

用户已开启 Shell 且当前 sandbox 工作区可写时允许：

```text
mkdir、touch、编辑文件、构建产物、安装项目依赖
```

### 10.3 dangerous

每次必须走确认门：

```text
rm、mv、chmod、chown、kill、pkill
git reset、git clean、覆盖性迁移
修改服务或系统配置
下载并执行脚本
数据库写入和删除
```

解析器需要识别管道、命令替换、重定向、编码执行和组合命令，不能只按第一个单词判断风险。

高风险命令确认内容必须包含：

- 规范化命令；
- workspace 名称和 Shell 模式；
- 工作目录；
- 是否联网；
- 预期影响。

危险命令开关关闭时，在确认门之前直接拒绝；即使请求携带 `confirm=true`，也不能绕过 Admin 或用户开关。

## 11. 目录与职责

```text
backend/agent/tools/shell.py
    Agent 工具 schema、调用参数和结果格式

backend/agent/security/shell_policy.py
    总开关、sandbox/system 权限、命令风险分类

backend/agent/sandbox/base.py
    ShellSandbox 接口、权限快照和统一结果模型

backend/agent/sandbox/local_executor.py
    LocalWorkspaceExecutor，本机可信执行器、进程树清理和输出限制

backend/agent/sandbox/docker.py
    DockerSandboxExecutor，生产普通用户执行器

backend/agent/sandbox/protocol.py
    sandboxd JSON Lines 请求/响应协议

backend/agent/sandbox/client.py
    Gugu Web/Worker 到 sandboxd 的 Unix Socket 客户端；不可用时不回退执行

backend/agent/sandbox/sandboxd.py
    独立 sandboxd 进程，校验允许的数据根目录并承接 Docker 执行

backend/gugu-sandboxd.service
    Rootless sandboxd systemd 单元；由 `start.sh install` 与其他后端服务一起安装

backend/app/api/v1/preferences.py
    用户 Shell 开关

backend/app/api/v1/workspaces.py
    工作区列表、绑定、解除和权限校验

backend/app/models/
    Workspace 与 ConversationSession.workspace_id

frontend/src/views/Settings/
    用户 Shell 设置，受 Admin 总开关控制可见性

backend/tests/test_shell_policy.py
backend/tests/test_shell_sandbox.py
backend/tests/test_workspace_binding.py
```

## 12. 执行计划

### Phase 0：权限与契约冻结

- [x] 增加 Admin `shell_enabled` 总开关，默认 `true`（配置模型、Admin 行为配置页已接入）；system 范围仍默认关闭。
- [x] 明确工具不可见条件：Admin 总开关关闭或用户 Shell 开关关闭时不注册；system 选项单独按权限隐藏。
- [x] 开关变更后立即刷新配置，不依赖重启（复用现有 override 热更新）。
- [x] 冻结两种模式：默认 `sandbox`，独立高权限 `system` 默认关闭且不等同于 root 提权。
- [x] 冻结输入、输出、错误脱敏和审计字段。

### Phase 1：本机执行器核心

- [x] 实现 `ShellSandbox` 抽象契约和统一 `ShellResult`。
- [x] 实现 `LocalWorkspaceExecutor`，只接受沙盒或当前 workspace 挂载目录内的相对 cwd。
- [x] 使用参数数组启动进程，禁止 `shell=True` 拼接执行。
- [x] 实现 stdout/stderr 截断、超时和进程组清理。
- [x] 使用最小环境变量集合，避免继承密钥和数据库配置。
- [x] 本机执行器失败时不得回退到任意目录或其他执行后端。
- [ ] 将执行器接入 Agent 工具和 dispatch（归入 Phase 3）。

### Phase 2：工作区解析与权限快照

- [x] 支持文件夹和项目转换为 workspace，并解析真实根目录。
- [x] 增加用户 `shell_enabled` 偏好（复用 `user_preferences` JSON）。
- [x] 增加 `ConversationSession.workspace_id` 及迁移。
- [x] 通过一次性迁移删除 `ConversationSession.shell_scope`；运行时和新模型不再保留该字段。
- [x] 新会话默认不绑定 workspace。
- [x] 实现工作区列表、创建、绑定和解除绑定 API。
- [x] 在执行前验证 workspace 用户归属、启用状态和真实根目录。
- [x] 增加 `/workspace` 命令，支持查看当前绑定、`list` 列出可绑定工作区、绑定和解除绑定；增加 `delete <ID>` 的显式二次确认删除。
- [x] 移除 `/shell` 命令和旧会话范围写入 API，避免 Shell 状态与 workspace 绑定分叉。
- [x] 将旧 `personal/workspace` scope 的运行时分叉收敛为 `sandbox`；工作区只保留默认目录职责。
- [x] 从 Admin Agent 运行行为页移除旧的“工作区 Shell”和“个人目录 Shell”独立开关，避免与统一 sandbox 执行模型混淆；兼容字段暂保留至数据库清理窗口。
- [x] 系统范围使用独立策略；system 未开放时，所有会话保持 sandbox，不再回落 personal。

### Phase 3：工具注册与模型提示

- [x] 注册 `shell` 工具 schema 和统一返回值。
- [x] 仅在总开关和用户 Shell 权限满足时向模型暴露 sandbox；system 另受 Admin/用户 system 开关控制。
- [x] 增加 `shell-workspace` 技能和 `prompts/skills.md` 主动指针。
- [x] 在动态提示词中显示当前 Shell 模式、workspace 名称、相对 cwd 和权限状态。
- [x] 明确模型规则：使用系统提供的自动派生范围；不能传入 session_id、猜测默认目录或自行扩大范围。

### Phase 4：风险控制与审计（已完成本地执行器范围）

- [x] 完成 safe/write/dangerous 分类，并扫描整条命令，拒绝管道、重定向和命令替换。
- [x] dangerous 命令接入确认门，确认内容包含命令、workspace、cwd 和影响范围。
- [x] dispatch、执行器启动前和执行过程中再次校验权限快照；撤权后终止进程组。
- [x] 记录结构化审计，不记录完整命令、输出、Token 或敏感路径。
- [x] 增加同一 session 串行锁，避免 workspace 切换与执行竞态。
- [x] Admin 提供 system 模式总开关；关闭 system 时仅隐藏 system 选项，不影响默认 sandbox。
- [x] 增加总开关、旧 shell_scope 忽略和权限拒绝回归测试。
- [x] 增加默认 sandbox、工作区仅决定挂载目录、system 独立权限和旧 scope 忽略回归测试。

- [x] Admin 页面增加总开关。
- [x] Admin 页面增加危险 Shell 命令总开关，默认关闭。
- [x] 用户页面增加独立工具权限区域，并显示全局开关状态。
- [x] 用户页面增加危险 Shell 命令个人开关，默认关闭，并受 Admin 总开关限制。
- [x] 工作区状态与当前会话绑定 API 客户端入口。
- [x] 补权限、路径逃逸、软链接、危险命令、超时、输出超限和并发测试。
- [ ] 在 devserver 完成本机执行 smoke test。

### Phase 5：隔离增强（已完成基础生产门禁）

- [x] 评估 Docker/Podman 在 devserver 的可用性和资源成本；Docker 可用，Podman 未安装，磁盘余量暂时阻塞实施。
- [x] 建立带 `com.gugu.sandbox=true` 标签的运行态资源清理边界；不执行全局 Docker prune。未使用镜像/卷的长期保留策略移入 Phase 6。
- [x] 准备 devserver Rootless Docker 用户级 daemon，移除测试执行路径对 rootful Docker socket 的直接依赖；生产部署仍需配置专用 sandboxd。
- [x] 实现容器版 `DockerSandboxExecutor`，复用 Phase 1 的执行结果、超时、输出截断和权限撤销契约；Docker 未就绪时不回退本机执行器。
- [x] 固定容器参数：非 root、只读根文件系统、断网、cap-drop、no-new-privileges、Docker 内置 seccomp/AppArmor、PID/CPU/内存/tmpfs/ulimit 限制。
- [x] 增加镜像 digest 格式校验和 `--pull=never`，执行阶段不允许隐式拉取或由用户选择镜像。
- [x] 准备 devserver 的 Rootless Docker、user namespace、cgroup v2、fuse-overlayfs 和 systemd lingering；`gugu-sandbox` 专用部署用户仍待生产化。
- [x] 让探测和执行器优先使用当前用户 Rootless socket；systemd 模板和运行时自动发现双重覆盖，避免误连 rootful socket。
- [x] 固定 devserver smoke test 使用的 `debian:bookworm-slim` 镜像 digest，并验证容器内非 root 用户；仍需生成第三方许可证清单。
- [x] 在 devserver 完成真实 smoke：容器 UID `65532`、workspace 可写、`getent hosts example.com` 失败、只读根文件系统写入被拒绝；固定参数包含 CPU/内存/PID/tmpfs/ulimit 限制。
- [x] 生成固定 Debian 镜像的第三方包清单 `licenses/sandbox-debian-bookworm-slim.txt`，保留镜像 digest、包版本和许可证查阅位置。
- [x] OSS 模式下为每个用户创建独立本地 Shell 持久空间，默认配额 512 MB，并接入 Admin 配额管理；OSS 对象存储不作为容器 bind mount。
- [x] 初始化 Rootless bind mount 的 subordinate group/default ACL 计划脚本和部署入口；真实生产 apply 验收移入 Phase 6。
- [x] 增加 `prepare_rootless_workspace.py` 权限计划脚本：默认 dry-run，显式 `--apply` 才设置 subordinate group/default ACL；补充 subuid/subgid 映射与根目录拒绝测试。
- [x] 增加 `prepare_rootless_users.py` 批量权限初始化脚本：只扫描专门用户数据根目录下的用户目录，默认 dry-run，显式 `--apply` 才应用 ACL。
- [x] 增加独立临时构建/cache 空间，默认配额 1 GB，并将配额落实为每个临时容器 `/tmp` 的 tmpfs 上限；容器销毁后自动回收。
- [x] 统一 Shell 配额计量入口，覆盖 Shell 根目录创建、启动前检查、运行中 sandboxd 监测和清空后的空间回收；文件库上传/下载与构建产物账本统一收口移入 Phase 6。
- [x] 将本机执行器的实现文件和类型正式重命名为 `LocalWorkspaceExecutor`，明确其仅用于可信本机执行；生产普通用户不允许使用。
- [x] 将 safe/write/dangerous 明确限制为确认策略；真正的文件系统、网络、UID、能力和资源隔离由 Docker/sandboxd 提供。
- [x] 增加 `none/egress/internal` 网络 profile 契约；当前执行门禁开放 `none` 和受控 `egress`，`internal` 仍未开放。
- [x] 增加 egress 请求参数、10 分钟 session 级确认、sandboxd 过期时间校验和受控代理格式校验。
- [x] 未部署隔离网络时硬拒绝 egress，禁止用 Docker bridge 或 HTTP_PROXY 环境变量伪装安全隔离。
- [x] Compose 部署独立 egress proxy 网络；容器只加入 `gugu-sandbox-egress`，sandboxd 在 Docker 权限边界内校验网络存在性。
- [ ] 在具备 Rootless Docker 的 devserver/生产环境完成真实 egress 访问、内网拒绝、代理绕过和容器残留回归。
- [x] system executor 不再错误绑定当前 LLM preset 的 `deployment_mode`；只有 Admin 与用户两级 system 开关同时开启时才可用。多租户部署默认关闭该能力。
- [x] 增加 Admin “Shell 沙盒”管理页面和状态接口：关闭时禁用 Shell，Docker 不可用时禁止开启。
- [x] 实现 Docker 可用性检测与固定配置校验；禁止前端或管理员手动拼接容器启动参数。
- [x] 将沙盒就绪状态接入工具注册策略和 dispatch/执行器门禁；三层均禁止回退本机执行器。
- [x] 增加 Docker 探测、Rootless/digest/镜像存在性门禁、固定参数、权限计划、配额计量和拒绝路径回归测试（当前相关测试 48 个通过）。
- [x] 增加固定 digest 的当前 daemon 镜像存在性门禁，与 `--pull=never` 保持一致。
- [x] Admin 沙盒状态和开启接口复用固定 digest 镜像存在性门禁；镜像未加载时显示“镜像未加载”并拒绝开启。
- [x] Admin 沙盒页展示持久空间与临时构建/cache 配额；当前默认值分别为 512 MB 和 1 GB，计量与强制写入仍由后续 sandboxd/文件系统层负责。
- [x] Admin 状态接口明确返回当前生命周期模型为 `ephemeral`；每次命令独立创建并销毁容器，暂不提供误导性的常驻容器重启按钮。
- [x] 沙盒命令启动前检查未绑定工作区的独立 Shell 持久目录；已超出 512 MB 时拒绝继续执行并保留数据。运行中写入拦截仍由后续 sandboxd/文件系统层负责。
- [x] 将网络策略提升为沙盒配置契约；`none` 为默认，`egress` 只能经过独立受控代理与内网拒绝策略，`internal` 不开放，不能直接打开 Docker 网络。
- [x] 增加 Shell 持久/临时空间配额配置与无 symlink 目录计量基础；强制写入拦截仍由 sandboxd/文件系统层负责。
- [x] 临时容器增加固定 `com.gugu.sandbox=true` 标签；关闭全局沙盒时只回收带该标签的运行态容器，不删除用户空间、镜像或配额记录。
- [x] 增加用户沙盒重启/重建入口，限制为当前用户并保留用户数据。
- [x] 增加 Admin 单用户和批量沙盒生命周期管理，接入日志、权限边界和确认门。
- [x] 将清空沙盒设计为独立破坏性操作，不允许被重建流程隐式触发。
- [x] 容器执行器已成为生产 sandbox 默认后端；运行时已停止消费旧 `personal/workspace` scope 和 `shell_scope` 授权语义。
- [x] 完成绝对路径、`..`、软链接、挂载边界、用户切换和容器重建回归测试。
- [x] 对比本机执行器与容器执行器的权限差异：本机执行器仅保留本地自托管 system 场景，普通用户 Shell 不回退本机。

### Phase 6：sandboxd 生命周期与生产收口（进行中）

Phase 6 不把当前的每命令临时容器伪装成常驻容器。当前 `DockerSandboxExecutor` 的生命周期是
`docker run --rm`：命令结束即销毁容器，用户数据位于宿主机独立目录。只有 sandboxd 引入容器实例登记、
并发控制和持久数据卷后，才实现真正的用户级“重启/重建/清空”接口。

- [x] 冻结当前生命周期契约为 `ephemeral`，Admin 状态接口明确返回该值。
- [x] 为临时容器增加固定生命周期标签，关闭沙盒只回收该标签容器，不执行全量 Docker 清理。
- [x] 回收操作不删除镜像、挂载目录和配额记录；回收失败不伪造成功数量。
- [x] 保持 Rootless socket、固定 digest、非 root、断网和 `--pull=never` 作为 sandboxd 接入前的不可变前置条件。
- [x] 实现独立 `sandboxd` Unix socket/API：请求 peer 鉴权、用户级请求登记、并发上限、超时/配额回收和结构化审计。
- [x] 增加 sandboxd JSON Lines 协议、Unix Socket 客户端和独立服务入口；请求禁止传入镜像、挂载、网络、UID/GID 或 Docker 参数。
- [x] Shell sandbox 路径支持配置 `sandboxd_socket` 后只走 sandboxd；Socket 不可用时返回失败，不回退 Docker CLI 或本机执行器。
- [x] 增加 `gugu-sandboxd.service` 和 `start.sh install` 安装/启停入口；服务使用 Rootless Docker socket 和固定用户数据根目录。
- [x] 在 devserver 执行安装并验证默认执行路径切换到 sandboxd；Socket 不可用时明确失败，禁止回退 direct Docker 或本机执行器。
- [x] 实现用户级 restart/rebuild 和 Admin 单用户/批量 restart/rebuild，并保留用户数据；当前生命周期明确为每命令临时容器。
- [x] 实现独立的 clear 确认门，只清理用户沙盒数据，不隐式绑定于 rebuild/disable。
- [x] 将持久配额和临时配额接入 sandboxd/执行器强制层；超额写入会在执行期间终止命令。跨文件库下载/构建账本的统一配额移入 Phase 6。
- [x] 完成 OSS 模式用户沙盒目录创建、Rootless ACL 计划和配额记录/审计入口；真实生产 ACL apply 验收移入 Phase 6。
- [x] 完成 Docker 运行态清理策略；清理限定 sandbox 标签资源，不触碰 Gugu 业务容器。镜像/卷长期保留策略移入 Phase 6。
- [x] 增加可选 Rootless ACL 初始化入口：`sandbox-acl-plan` 默认 dry-run，`SANDBOX_ACL=1` 才允许 `sandbox-acl-apply`；`start`、`restart`、`install` 和 `compose-up` 共用同一宿主机初始化路径。
- [x] 完成多租户部署的 system executor 禁用门禁，并保留本地自托管显式开启能力。
- [x] 完成绝对路径、软链接、挂载边界、用户切换、容器重建、取消和异常恢复的核心回归测试；旧 scope 不再参与运行时授权。
- [x] 为每个存活用户创建 `Gugu-data/users/<user-id>/shell` 持久目录，并登记 `file_library`、`shell_persistent`、`shell_ephemeral` 三类账本。
- [x] 统一记录文件上传、`web_download`、文件复制、构建和 Shell 执行事件；账本支持幂等键、用量校准和结构化审计验证。
- [x] 文件库配额判断改用统一账本，并在写入前按数据库与本地目录事实对账；删除、恢复和内容更新通过下一次对账纠正历史用量。
- [x] 新增数据库迁移删除旧 `conversation_sessions.shell_scope` 字段，关闭兼容字段的继续写入窗口。

### 12.6 Rootless workspace 权限验收

- [x] 容器 UID/GID `65532:65532` 的 subordinate 映射可由脚本稳定解析。
- [x] dry-run 不创建目录、不修改 owner、group 或 ACL。
- [x] apply 计划同时保留宿主机登录用户 owner、授予映射组 `rwx`，并设置默认 ACL。
- [x] 脚本拒绝根目录和无效 subordinate 映射；Web/Worker 不直接调用权限修改命令。
- [ ] 在 sandboxd 生产初始化流程中执行 apply，并对每个用户持久空间完成创建、配额和审计。

### 12.7 用户持久空间与统一配额账本

- 每个活跃用户的持久根目录固定为 `Gugu-data/users/<user-id>/shell`，由应用启动时幂等创建。
- `storage_quota_ledgers` 保存 `file_library`、`shell_persistent`、`shell_ephemeral` 三类当前用量、配额和预留量。
- `storage_quota_events` 保存初始化、上传、`web_download`、复制、构建、Shell 执行和对账校准事件；同一幂等键不会重复增加用量。
- 文件库写入在配额判断前按数据库事实对账；Shell 持久空间在执行前、执行后分别测量。临时构建空间由容器 tmpfs 生命周期负责回收，账本保留其类别和配额。
- 删除、恢复和正文更新不直接猜测增量，下一次写入或显式校验会按事实对账，避免回收站和覆盖上传造成账本漂移。
- `20260826000001_add_storage_quota_ledger` 创建账本，`20260826000002_remove_legacy_shell_scope` 删除已废弃的会话字段；迁移后不得再写入 `shell_scope`。

## 13. 验收标准

### 13.1 本机执行器验收

- 默认配置下后台 Shell 总开关为开启，但仍需用户开关和 Docker 沙盒运行时就绪后才可调用；system 范围、危险命令和 Autopilot 仍不可用。
- Admin 关闭开关后，旧请求也会被 dispatch 拒绝。
- Admin 和用户 Shell 权限满足时，sandbox 工具即可注册并执行；workspace 只决定默认 cwd。
- sandbox 只能在沙盒根目录或当前 workspace 挂载目录内工作，不会回退到任意宿主机目录。
- 命令超时、输出超限和后台进程都能被收束。
- `sudo`、提权命令、系统目录、密钥目录和软链接逃逸被拒绝。

### 13.2 权限与会话验收

- Admin 关闭后，任意用户无法看到或调用 Shell。
- 用户未开启时，模型工具列表没有 Shell；未绑定 workspace 时仍可使用默认 sandbox。
- sandbox 无法访问沙盒/当前 workspace 外路径、软链接目标和宿主机密钥；system 使用独立权限策略。
- safe 命令可以正常执行并返回统一结果。
- dangerous 命令未确认时不会执行。
- 超时命令会终止完整进程树并释放执行状态。
- 同一 session 并发调用不会交叉使用不同 workspace。
- workspace 切换只影响当前 session。
- `/workspace unlink` 后立即回到 sandbox 根目录，不会关闭 Shell。
- 沙盒关闭后 Shell 不出现在工具列表，旧请求也被拒绝；用户文件和配额保持不变。
- Docker 未安装、daemon 未运行或容器初始化失败时，Admin 无法打开沙盒，并能看到明确状态原因。
- Rootless Docker 不可用时不会回退到本机执行器；业务进程不具备 root Docker socket 访问权限。
- 沙盒镜像使用固定 digest，容器以非 root 用户运行，许可证文件和第三方许可证清单随镜像发布。
- 用户重启/重建只能影响自己的容器；重建后文件仍然存在，清空操作必须单独确认。
- Admin 可查看并管理单个用户沙盒，批量操作有审计记录，不会误删用户数据。
- 容器执行器稳定前，旧本机路径限制不得删除；稳定后清理兼容代码仍保留 API 参数校验和 sandboxd 防线。

### 13.3 后续容器验收

- Docker/Podman 后端复用本机执行器的权限快照和统一结果模型。
- 容器不可用时不会静默切换到更高权限的执行路径。
- 容器具备非 root、workspace 单独挂载、默认断网和资源限制。
- OSS 模式下每个用户默认拥有 512 MB Shell 持久空间和 1 GB 临时构建空间，Admin 可以分别修改配额，Shell 空间与 OSS 文件库配额互不影响。

## 14. 后续平台适配

统一接口保持不变：

```python
class ShellSandbox:
    async def execute(self, command, workspace, cwd, timeout, limits): ...
```

后续实现：

```text
Linux：DockerSandbox / PodmanSandbox
macOS：DockerSandbox，后续评估 SeatbeltSandbox
Windows：DockerSandbox / WSL2Sandbox，后续评估 AppContainerSandbox
```

首版不因跨平台适配延后 Linux/devserver 交付。
