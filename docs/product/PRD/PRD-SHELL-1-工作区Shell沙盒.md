# PRD-SHELL-1：工作区 Shell 沙盒

## 1. 文档信息

- 状态：执行器实现准备中
- 目标：默认使用用户独立沙盒；工作区只作为默认目录，再评估 Docker/Podman 后端
- 首版平台：devserver/Linux 本机执行
- 后续平台：macOS、Windows 复用执行器接口，暂不承诺相同隔离强度
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

#### 镜像许可证

- `gugu-sandboxd`、执行器和咕咕自有代码使用 Apache License 2.0。
- `debian:bookworm-slim`、Debian 软件包及其他依赖继续遵循各自许可证，不因咕咕代码使用 Apache-2.0 而改变许可证。
- 发布镜像时保留 Apache-2.0、基础镜像版权声明和第三方许可证清单。

### 3.3 用户文件存储迁移

当前本地存储实际目录为 `backend/uploads`，迁移目标为仓库同级的 `Gugu-data/users`。迁移不改变数据库中的 `storage_key`，因为现有 key 已包含用户隔离前缀；只切换 Local Storage 的根目录。

- 迁移由 `backend/scripts/migrate_storage_root.py` 执行。
- 默认先 dry-run，`make storage-migrate` 或 `make update` 才执行复制和配置切换。
- 迁移按 SHA-256 校验；相同文件跳过，目标冲突时中止，不覆盖目标文件。
- 迁移完成后更新 `config.override.json.storage.local_path` 为 `../Gugu-data/users`。
- 旧 `backend/uploads` 保留，不在迁移脚本中自动删除。
- 已安装 systemd 服务由 `make update` 停止、迁移、重新生成可写目录白名单并启动。
- 迁移失败不得切换配置，服务继续使用旧存储根目录。

### 3.4 OSS 模式下的 Shell 配额

当 `storage.backend=oss` 时，OSS 文件库不可直接挂载到 Shell 容器。此时文件库继续使用 OSS 配额，Shell 沙盒使用独立的本地用户空间，只服务于 Shell 执行，不与 OSS 文件库共用容量。

- Shell 沙盒默认配额为 `128 MB`。
- Admin 的用户配额管理页面增加 Shell 沙盒配额配置和已用空间展示。
- Shell 配额按用户保存；用户创建文件、下载内容、生成构建产物和缓存都计入同一配额。
- 超出配额时拒绝写入、下载和生成，不影响用户在 OSS 文件库中的空间。
- 删除沙盒文件后释放 Shell 配额。
- `system` Shell 不使用这 128 MB 作为宿主机磁盘配额，继续使用独立的临时目录、输出大小和执行时长限制。
- 本地存储模式下，Shell 可以继续复用 `Gugu-data/users/<user-id>`，不额外创建 Shell 配额字段。

建议配置字段：

```text
shell_quota_bytes
shell_used_bytes
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
```

建议状态字段：

```text
enabled
docker_installed
docker_daemon_ready
executor_ready
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
- 本机执行器默认断网能力由命令策略控制；容器阶段再提供强制网络隔离。
- 危险命令必须经过确认门。
- 记录结构化审计信息，不记录密钥、完整用户输入或敏感命令输出。

### 4.2 当前阶段不做

- 不开放宿主机 root shell，也不把宿主机 root 作为普通 Shell 能力开放。
- `system` 模式受独立 Admin/用户开关控制；关闭 system 不影响默认 `sandbox`。
- 不允许通过参数访问任意宿主机目录、Docker socket 或提权接口。
- 不支持任意远程主机执行。
- 不在当前阶段实现 Docker/Podman、macOS Seatbelt 或 Windows AppContainer。
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

- `shell_enabled` 默认值为 `false`；
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

**Phase 5 开始前必须完成：**

1. 为 Gugu-web 准备独立的 rootless Docker daemon，或使用受限的专用执行服务，避免业务进程直接持有 rootful Docker socket。
2. 清理 Docker build cache/无用镜像并预留容器存储空间；至少保证基础镜像、workspace 临时层和输出缓冲有明确配额。
3. 固定基础镜像 digest，禁止工具根据用户输入选择镜像、挂载路径、特权模式或 Docker socket。
4. 明确容器参数：非 root 用户、`--read-only` 根文件系统、workspace 单独可写挂载、默认 `--network=none`、tmpfs 大小、CPU/内存/PID 限制和强制销毁。
5. 先用 `hello-world`/最小固定镜像完成 smoke test，再实现 `DockerSandbox`；Docker 不可用时必须返回明确错误，不能回退 `LocalWorkspaceSandbox`。

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

backend/agent/sandbox/local.py
    本机工作区执行器、进程树清理和输出限制

backend/agent/sandbox/docker.py
    后续 Docker/Podman 容器执行器，不属于当前阶段

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

- [x] 增加 Admin `shell_enabled` 总开关，默认 `false`（配置模型、Admin 行为配置页已接入）。
- [x] 明确工具不可见条件：Admin 总开关关闭或用户 Shell 开关关闭时不注册；system 选项单独按权限隐藏。
- [x] 开关变更后立即刷新配置，不依赖重启（复用现有 override 热更新）。
- [x] 冻结两种模式：默认 `sandbox`，独立高权限 `system` 默认关闭且不等同于 root 提权。
- [x] 冻结输入、输出、错误脱敏和审计字段。

### Phase 1：本机执行器核心

- [x] 实现 `ShellSandbox` 抽象契约和统一 `ShellResult`。
- [x] 实现 `LocalWorkspaceSandbox`，只接受沙盒或当前 workspace 挂载目录内的相对 cwd。
- [x] 使用参数数组启动进程，禁止 `shell=True` 拼接执行。
- [x] 实现 stdout/stderr 截断、超时和进程组清理。
- [x] 使用最小环境变量集合，避免继承密钥和数据库配置。
- [x] 本机执行器失败时不得回退到任意目录或其他执行后端。
- [ ] 将执行器接入 Agent 工具和 dispatch（归入 Phase 3）。

### Phase 2：工作区解析与权限快照

- [x] 支持文件夹和项目转换为 workspace，并解析真实根目录。
- [x] 增加用户 `shell_enabled` 偏好（复用 `user_preferences` JSON）。
- [x] 增加 `ConversationSession.workspace_id` 及迁移。
- [x] 保留 `ConversationSession.shell_scope` 迁移字段以兼容旧数据库；运行时不再读取它。
- [x] 新会话默认不绑定 workspace。
- [x] 实现工作区列表、创建、绑定和解除绑定 API。
- [x] 在执行前验证 workspace 用户归属、启用状态和真实根目录。
- [x] 增加 `/workspace` 命令，支持查看当前绑定、`list` 列出可绑定工作区、绑定和解除绑定。
- [x] 移除 `/shell` 命令和旧会话范围写入 API，避免 Shell 状态与 workspace 绑定分叉。
- [ ] 将旧 `personal/workspace` scope 迁移为 `sandbox`，并增加 `ConversationSession.shell_mode`；工作区只保留默认目录职责。
- [ ] 系统范围使用独立策略；system 未开放时，所有会话保持 sandbox，不再回落 personal。

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
- [ ] 增加默认 sandbox、工作区仅决定 cwd、system 独立权限和旧 scope 迁移回归测试。

- [x] Admin 页面增加总开关。
- [x] Admin 页面增加危险 Shell 命令总开关，默认关闭。
- [x] 用户页面增加独立工具权限区域，并显示全局开关状态。
- [x] 用户页面增加危险 Shell 命令个人开关，默认关闭，并受 Admin 总开关限制。
- [x] 工作区状态与当前会话绑定 API 客户端入口。
- [x] 补权限、路径逃逸、软链接、危险命令、超时、输出超限和并发测试。
- [ ] 在 devserver 完成本机执行 smoke test。

### Phase 5：隔离增强（评估完成，实施待资源整改）

- [x] 评估 Docker/Podman 在 devserver 的可用性和资源成本；Docker 可用，Podman 未安装，磁盘余量暂时阻塞实施。
- [ ] 清理 devserver Docker 存储并建立容器存储配额。
- [ ] 准备 rootless Docker 或受限专用执行服务，移除业务进程对 rootful Docker socket 的直接依赖。
- [ ] 实现容器版 `ShellSandbox`，复用 Phase 1 的接口和测试。
- [ ] 准备 `gugu-sandbox` 专用系统用户、Rootless Docker、user namespace、cgroup v2、fuse-overlayfs 和 systemd lingering。
- [ ] 固定 `debian:bookworm-slim` 镜像 digest，容器内使用非 root 用户并生成第三方许可证清单。
- [ ] 增加非 root、只读根文件系统、workspace 挂载、断网和资源限制。
- [ ] OSS 模式下为每个用户创建独立 Shell 空间，默认配额 128 MB，并接入 Admin 配额管理。
- [ ] 复用统一配额服务，覆盖 Shell 创建、下载、构建产物、缓存和删除后的空间回收。
- [ ] 增加 Admin “Shell 沙盒”管理页面和状态接口：关闭时禁用 Shell，Docker 不可用时禁止开启。
- [ ] 实现 Docker 可用性检测与自动初始化；禁止前端或管理员手动拼接容器启动参数。
- [ ] 将沙盒就绪状态接入工具注册、dispatch、执行器三层权限闸门。
- [ ] 验证关闭沙盒只停止/回收容器，不删除用户空间和既有配额分配。
- [ ] 增加用户沙盒重启/重建入口，限制为当前用户并保留数据卷。
- [ ] 增加 Admin 单用户和批量沙盒生命周期管理，接入审计日志与确认门。
- [ ] 将清空沙盒设计为独立破坏性操作，不允许被重建流程隐式触发。
- [ ] 对比本机执行器与容器执行器的权限差异，决定默认后端。

## 13. 验收标准

### 13.1 本机执行器验收

- 默认配置下不存在可调用的 Shell 工具。
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

### 13.3 后续容器验收

- Docker/Podman 后端复用本机执行器的权限快照和统一结果模型。
- 容器不可用时不会静默切换到更高权限的执行路径。
- 容器具备非 root、workspace 单独挂载、默认断网和资源限制。
- OSS 模式下每个用户默认拥有 128 MB Shell 空间，Admin 可以修改配额，Shell 空间与 OSS 文件库配额互不影响。

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
