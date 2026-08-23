# PRD-SHELL-1：工作区 Shell 沙盒

## 1. 文档信息

- 状态：执行器实现准备中
- 目标：先完成本机工作区受限执行闭环，再评估 Docker/Podman 沙盒
- 首版平台：devserver/Linux 本机执行
- 后续平台：macOS、Windows 复用执行器接口，暂不承诺相同隔离强度
- 相关能力：Agent 工具、用户设置、会话绑定、文件库工作区

## 2. 背景

咕咕需要能够在用户明确授权后执行项目构建、测试、文件整理和诊断命令。直接在宿主机执行任意 Shell 会带来路径越权、凭据泄露、后台驻留、服务破坏和跨用户访问风险。

本阶段先做“本机工作区受限执行器”：执行进程仍运行在当前系统用户下，但所有权限、路径、命令风险、超时和输出边界都由 Gugu-web 在执行前后统一校验。Docker/Podman 作为后续更强隔离层，不阻塞本阶段落地。

## 3. 版本策略

本 PRD 按执行链路拆成六个阶段。先完成权限和执行范围基础，再落地本机执行器，最后补工具注册、确认门、审计和回归测试。每一阶段都保持可独立验证，不提前暴露尚未实现的 Shell 工具。

### 执行范围

会话范围由绑定状态自动派生，不再通过命令单独维护 `shell_scope`：

| 范围 | 根目录 | 说明 |
|---|---|---|
| `workspace` | 当前工作区 | 保留原有行为，要求绑定启用的工作区 |
| `personal` | 用户个人文件目录 | 未绑定工作区且 system 未开放时的回落范围；必须由 Admin 和用户分别开启 |
| `system` | 系统根目录 | 未绑定工作区时的优先范围；必须由 Admin 和用户分别开启 |

`shell_enabled` 是所有范围共用的总开关。绑定 workspace 的会话自动使用 `workspace`；解除绑定后优先使用 `system`，system 任一开关未开启时回落到 `personal`。只有总开关关闭时才会禁用所有 Shell。Shell 工具的会话 ID由执行器注入，模型不能自行指定。

### 3.1 当前阶段：权限与执行器基础

- Admin 总开关默认关闭。
- 关闭时完全不注册 Shell 工具，并在 dispatch 层拒绝旧请求。
- 开启后仍需同时满足对应范围的用户开关和会话绑定状态；system 仍需额外的危险命令确认门。
- “本机执行”仅指使用当前系统用户权限，不等于 root、`sudo` 或系统级权限。
- 工作区和个人范围不接受宿主机绝对路径，不允许根目录外访问；系统范围仅在独立 Admin/用户开关均开启时优先使用。
- 保留执行超时、输出大小、后台进程和敏感路径等边界。
- 危险命令另设独立的 Admin 总开关和用户个人开关，两个开关默认关闭。
- 危险命令即使两个开关都开启，仍必须经过现有逐次确认门。

### 3.2 后续阶段：隔离增强

- 增加 Docker/Podman 沙盒执行器。
- 在容器内复用同一 `ShellSandbox` 接口和权限快照。
- 根据平台评估 macOS Seatbelt、Windows WSL2/AppContainer 等增强隔离。

## 4. 目标与非目标

### 4.1 首版目标

- Admin 可以全局开启/关闭 Shell 能力。
- Admin 关闭时，所有用户禁止使用，用户页面不显示 Shell 设置。
- 用户可以在个人设置中开启/关闭自己的 Shell 能力。
- 新会话默认不绑定工作区，此时优先匹配 system；没有 system 权限但 personal 权限满足时回落到 personal。
- 用户或咕咕可以为当前 session 绑定、切换、解除工作区。
- 工作区可以来自文件库文件夹或项目。
- 未绑定工作区且 system/personal 权限都未满足时，不向 Agent 暴露 Shell 工具。
- 仅允许在当前 workspace 真实目录及其子目录内执行命令。
- 本机执行器默认断网能力由命令策略控制；容器阶段再提供强制网络隔离。
- 危险命令必须经过确认门。
- 记录结构化审计信息，不记录密钥、完整用户输入或敏感命令输出。

### 4.2 当前阶段不做

- 不开放宿主机 root shell，也不把宿主机 root 作为普通 Shell 能力开放。
- system scope 受独立 Admin/用户开关控制；关闭 system 不影响 workspace/personal。
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

### 5.3 执行范围

首版只实现：

```text
workspace：当前工作区真实目录及其子目录
```

预留：

```text
workspace-root：后续容器内 root，仍只访问当前工作区
system：宿主机受控操作，仅 Admin，后续单独设计
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

最终权限必须由服务端计算：

```python
shell_allowed = (
    admin_shell_enabled
    and user_shell_enabled
    and (
        (session.workspace_id is not None and workspace_enabled)
        or (session.workspace_id is None and (system_enabled or personal_enabled))
    )
)
```

权限判断必须同时位于：

1. 工具注册阶段：无权限时不把 Shell 工具放进模型工具列表；
2. dispatch 阶段：拒绝旧请求、缓存工具定义或手工构造请求绕过开关；
3. 执行器启动阶段：再次校验 workspace 所属用户、状态和真实路径。

当前首版使用以下最终权限：

```python
shell_allowed = (
    admin_shell_enabled
    and user_shell_enabled
    and (
        (session.workspace_id is not None and workspace_enabled)
        or (session.workspace_id is None and (system_enabled or personal_enabled))
    )
)
```

未绑定工作区时，服务端优先选择 `system`；只有 system 任一开关未满足时才尝试 `personal`。
关闭 `shell_system_enabled` 不会关闭工作区或个人目录 Shell；只有 `shell_enabled` 总开关会关闭全部范围。

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
    and (
        (session.workspace_id is not None and workspace_enabled)
        or (session.workspace_id is None and (system_enabled or personal_enabled))
    )
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

首版不接受 `root_path`、宿主机绝对路径或任意 `scope`。范围由当前 session workspace 决定。

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

Shell 工具不注册。用户要求执行命令时，咕咕应提示先选择或绑定工作区，不得自行猜测默认目录。

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
/workspace clear
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
- cwd 只能是当前 workspace 根目录或其子目录
- 不接受宿主机绝对路径、额外挂载和任意环境变量
- 环境变量使用最小白名单，不继承密钥、Token 和数据库连接信息
- 默认不主动联网；需要联网的命令按风险策略拒绝或单独确认
- 每次执行都有超时、输出上限和进程树清理
- 禁止 sudo、su、pkexec、系统服务管理和提权命令
```

### 9.2 路径限制

- `cwd` 必须解析到 `/workspace` 内部。
- 拒绝 `..` 逃逸、绝对宿主机路径和未授权挂载。
- 解析真实路径后再次检查是否仍在 workspace 根目录下。
- 拒绝通过软链接逃逸到 workspace 外部。
- 容器只挂载当前 workspace，不挂载用户 home、数据库、配置文件或密钥目录。

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

用户已开启 Shell 且 workspace 可写时允许：

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
- workspace 名称和范围；
- 工作目录；
- 是否联网；
- 预期影响。

危险命令开关关闭时，在确认门之前直接拒绝；即使请求携带 `confirm=true`，也不能绕过 Admin 或用户开关。

## 11. 目录与职责

```text
backend/agent/tools/shell.py
    Agent 工具 schema、调用参数和结果格式

backend/agent/security/shell_policy.py
    总开关、用户开关、workspace 权限、命令风险分类

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
- [x] 明确工具不可见条件：Admin 总开关关闭、对应范围关闭、用户范围开关关闭或 session scope 为 `off` 时均不注册。
- [x] 开关变更后立即刷新配置，不依赖重启（复用现有 override 热更新）。
- [x] 将 `workspace`、`personal`、`system` 作为独立范围；`system` 默认关闭且不等同于 root 提权。
- [x] 冻结输入、输出、错误脱敏和审计字段。

### Phase 1：本机执行器核心

- [x] 实现 `ShellSandbox` 抽象契约和统一 `ShellResult`。
- [x] 实现 `LocalWorkspaceSandbox`，只接受 workspace 内的相对 cwd。
- [x] 使用参数数组启动进程，禁止 `shell=True` 拼接执行。
- [x] 实现 stdout/stderr 截断、超时和进程组清理。
- [x] 使用最小环境变量集合，避免继承密钥和数据库配置。
- [x] 本机执行器失败时不得回退到任意目录或其他执行后端。
- [ ] 将执行器接入 Agent 工具和 dispatch（归入 Phase 3）。

### Phase 2：工作区解析与权限快照

- [x] 支持文件夹和项目转换为 workspace，并解析真实根目录。
- [x] 增加用户 `shell_enabled` 偏好（复用 `user_preferences` JSON）。
- [x] 增加 `ConversationSession.workspace_id` 及迁移。
- [x] 保留 `ConversationSession.shell_scope` 迁移字段以兼容旧数据库；运行时不再读取它，范围由 workspace 绑定状态派生。
- [x] 新会话默认不绑定 workspace。
- [x] 实现工作区列表、创建、绑定和解除绑定 API。
- [x] 在执行前验证 workspace 用户归属、启用状态和真实根目录。
- [x] 增加 `/workspace` 命令，支持查看当前绑定、`list` 列出可绑定工作区、绑定和解除绑定。
- [x] 移除 `/shell` 命令和会话范围写入 API，避免 Shell 状态与 workspace 绑定分叉。
- [x] 系统范围使用独立策略，不复用工作区路径；system 未开放时，未绑定会话回落 personal。

### Phase 3：工具注册与模型提示

- [x] 注册 `shell` 工具 schema 和统一返回值。
- [x] 仅在总开关、派生范围 Admin 开关、用户范围开关和 workspace 绑定状态均满足时向模型暴露工具。
- [x] 增加 `shell-workspace` 技能和 `prompts/skills.md` 主动指针。
- [x] 在动态提示词中显示当前 Shell 范围、workspace 名称、相对 cwd 和权限状态。
- [x] 明确模型规则：使用系统提供的自动派生范围；不能传入 session_id、猜测默认目录或自行扩大范围。

### Phase 4：风险控制与审计（已完成本地执行器范围）

- [x] 完成 safe/write/dangerous 分类，并扫描整条命令，拒绝管道、重定向和命令替换。
- [x] dangerous 命令接入确认门，确认内容包含命令、workspace、cwd 和影响范围。
- [x] dispatch、执行器启动前和执行过程中再次校验权限快照；撤权后终止进程组。
- [x] 记录结构化审计，不记录完整命令、输出、Token 或敏感路径。
- [x] 增加同一 session 串行锁，避免 workspace 切换与执行竞态。
- [x] Admin 按范围提供总开关；关闭的范围在个人设置中直接隐藏。
- [x] 增加 workspace 派生、system 优先/personal 回落、总开关、旧 shell_scope 忽略和权限拒绝回归测试。

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
- [ ] 增加非 root、只读根文件系统、workspace 挂载、断网和资源限制。
- [ ] 对比本机执行器与容器执行器的权限差异，决定默认后端。

## 13. 验收标准

### 13.1 本机执行器验收

- 默认配置下不存在可调用的 Shell 工具。
- Admin 关闭开关后，旧请求也会被 dispatch 拒绝。
- Admin、用户和 session workspace 均满足时，工具才会注册并执行。
- 本机执行器只能在当前 workspace 内工作，不会回退到任意宿主机目录。
- 命令超时、输出超限和后台进程都能被收束。
- `sudo`、提权命令、系统目录、密钥目录和软链接逃逸被拒绝。

### 13.2 权限与会话验收

- Admin 关闭后，任意用户无法看到或调用 Shell。
- 用户未开启或 session 未绑定 workspace 时，模型工具列表没有 Shell。
- Shell 无法访问 workspace 外路径、软链接目标和宿主机密钥。
- safe 命令可以正常执行并返回统一结果。
- dangerous 命令未确认时不会执行。
- 超时命令会终止完整进程树并释放执行状态。
- 同一 session 并发调用不会交叉使用不同 workspace。
- workspace 切换只影响当前 session。
- `/workspace clear` 后立即无法执行 Shell。

### 13.3 后续容器验收

- Docker/Podman 后端复用本机执行器的权限快照和统一结果模型。
- 容器不可用时不会静默切换到更高权限的执行路径。
- 容器具备非 root、workspace 单独挂载、默认断网和资源限制。

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
