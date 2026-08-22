# PRD-SHELL-1：工作区 Shell 沙盒

## 1. 文档信息

- 状态：设计中
- 目标：首版当天完成 devserver/Linux 可用闭环
- 首版平台：Linux + Docker/Podman
- 后续平台：macOS、Windows 复用执行器接口
- 相关能力：Agent 工具、用户设置、会话绑定、文件库工作区

## 2. 背景

咕咕需要能够在用户明确授权后执行项目构建、测试、文件整理和诊断命令。直接在宿主机执行任意 Bash 会带来路径越权、凭据泄露、后台驻留、服务破坏和跨用户访问风险，因此首版必须通过容器沙盒限制执行范围。

工作区不是 Docker 管理的文件库。Gugu-web 负责用户、文件库、项目和会话权限；容器只负责隔离进程、挂载经过授权的目录并执行命令。

## 3. 版本策略

本 PRD 分为两个交付阶段。首版优先验证后台开关、工具注册和执行链路，暂不把完整的多用户权限系统与 Shell 执行器绑在同一批改动中。

### 3.1 V0：全局本地开发模式

- Admin 总开关默认关闭。
- 关闭时完全不注册 Shell 工具，并在 dispatch 层拒绝旧请求。
- 开启后只允许本地 Admin 使用全局 Shell 能力。
- 暂不启用用户开关、session 工作区绑定和复杂命令风险分级。
- “最高权限”仅指 Gugu 当前系统用户权限，不等于 root、`sudo` 或 Docker `--privileged`。
- 保留执行超时、输出大小、后台进程和敏感路径等最小安全边界。

### 3.2 V1：细粒度权限模式

- 增加用户个人开关。
- 增加 session 工作区绑定。
- 增加 workspace/system 范围。
- 增加命令风险等级和危险命令确认门。
- 增加完整审计和跨用户并发隔离。

## 4. 目标与非目标

### 4.1 V1 目标

- Admin 可以全局开启/关闭 Shell 能力。
- Admin 关闭时，所有用户禁止使用，用户页面不显示 Shell 设置。
- 用户可以在个人设置中开启/关闭自己的 Shell 能力。
- 新会话默认不绑定工作区。
- 用户或咕咕可以为当前 session 绑定、切换、解除工作区。
- 工作区可以来自文件库文件夹或项目。
- 没有 session 工作区时，不向 Agent 暴露 Shell 工具。
- 仅允许在当前 workspace 挂载目录内执行命令。
- 默认使用非 root 容器、只读根文件系统、断网和资源限制。
- 危险命令必须经过确认门。
- 记录结构化审计信息，不记录密钥、完整用户输入或敏感命令输出。

### 4.2 V0/V1 不做

- V0 不开放宿主机 root shell；后续也不把宿主机 root 作为普通 Shell 能力开放。
- 不开放 system scope。
- 不允许 Docker socket、`--privileged` 或宿主机目录全量挂载。
- 不支持任意远程主机执行。
- 不在首版实现 macOS Seatbelt 或 Windows AppContainer。
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
workspace：当前工作区及其子目录
```

预留：

```text
workspace-root：容器内 root，仍只访问当前工作区
system：宿主机受控操作，仅 Admin，后续单独设计
```

## 6. 权限模型

### 6.1 V0 全局开关

```python
shell_allowed = settings.agent.shell_enabled and is_local_admin(request)
```

要求：

- `shell_enabled` 默认值为 `false`；
- Admin 关闭后立即停止新调用；
- 工具注册和 dispatch 都必须检查开关；
- 关闭时用户页面不显示 Shell 相关设置；
- 已经启动的命令由执行器超时/终止机制负责收尾；
- 不允许因为 Docker 不可用而回退到宿主机直接执行。

V0 的本地 Admin 身份可以通过现有 Admin 鉴权或本地开发身份判断。该模式不得直接暴露到公网生产环境。

最终权限必须由服务端计算：

```python
shell_allowed = (
    admin_shell_enabled
    and user_shell_enabled
    and session.workspace_id is not None
    and workspace_enabled
)
```

权限判断必须同时位于：

1. 工具注册阶段：无权限时不把 Shell 工具放进模型工具列表；
2. dispatch 阶段：拒绝旧请求、缓存工具定义或手工构造请求绕过开关；
3. 容器启动阶段：再次校验 workspace 所属用户、状态和真实路径。

### 6.2 V1 用户与会话权限

V1 使用以下最终权限：

```python
shell_allowed = (
    admin_shell_enabled
    and user_shell_enabled
    and session.workspace_id is not None
    and workspace_enabled
)
```

Admin 关闭总开关时：

- 所有用户立即不可用；
- 用户设置页隐藏 Shell 设置；
- 用户之前的个人开关保留但不生效；
- Admin 重新开启后恢复之前保存的个人开关。

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

## 9. 容器沙盒

### 9.1 默认容器策略

```text
- 非 root 用户
- 只读根文件系统
- 只读挂载工具链目录
- 当前 workspace 单独挂载到 /workspace
- /workspace 按需读写
- 默认无网络
- 禁止 Docker socket
- 禁止 --privileged
- 禁止额外 Linux capabilities
- seccomp/AppArmor 使用默认限制
- CPU、内存、进程数、临时磁盘和执行时间限制
- 命令结束后销毁容器
```

### 9.2 路径限制

- `cwd` 必须解析到 `/workspace` 内部。
- 拒绝 `..` 逃逸、绝对宿主机路径和未授权挂载。
- 解析真实路径后再次检查是否仍在 workspace 根目录下。
- 拒绝通过软链接逃逸到 workspace 外部。
- 容器只挂载当前 workspace，不挂载用户 home、数据库、配置文件或密钥目录。

### 9.3 资源限制

首版默认值：

```text
timeout：30 秒，Admin 可配置上限 300 秒
max_output_chars：12000
memory：1 GiB
cpu：1 core
pids：128
network：disabled
```

超时必须终止整个进程树并销毁容器，不能只终止 shell 父进程。

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

## 11. 目录与职责

```text
backend/agent/tools/shell.py
    Agent 工具 schema、调用参数和结果格式

backend/agent/security/shell_policy.py
    总开关、用户开关、workspace 权限、命令风险分类

backend/agent/sandbox/base.py
    ShellSandbox 接口和统一结果模型

backend/agent/sandbox/docker.py
    Docker/Podman 容器执行器

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

## 12. 当天实施计划

### Phase 0：全局开关与最小配置

- [x] 增加 Admin `shell_enabled` 总开关，默认 `false`（配置模型、Admin 行为配置页已接入）。
- [ ] 开关关闭时不注册工具，并在 dispatch 层拒绝调用。
- [x] 开关变更后立即刷新配置，不依赖重启（复用现有 override 热更新）。
- [ ] 限制 V0 仅本地 Admin 可开启后使用。
- [ ] 增加基础超时、输出限制和后台进程清理。

### Phase 1：V0 Shell 执行器

- [ ] 实现统一 `ShellSandbox` 接口。
- [ ] 实现 Linux Docker/Podman 执行器。
- [ ] 接入基础 Shell 工具 schema 和统一返回值。
- [ ] 完成容器销毁、超时和输出截断。
- [ ] 禁止 `sudo`、`--privileged`、Docker socket 和密钥目录挂载。

### Phase 2：工作区与用户权限

- [ ] 支持文件夹和项目转换为 workspace。
- [x] 增加用户 `shell_enabled` 偏好（复用 `user_preferences` JSON）。
- [x] 增加 `ConversationSession.workspace_id` 及迁移。
- [x] 新会话默认不绑定 workspace。
- [x] 实现工作区列表、创建、绑定和解除绑定 API。
- [x] 验证 workspace 的用户归属和启用状态；真实根目录校验留给执行器阶段。
- [x] 增加 `/workspace` 命令。

### Phase 3：细粒度 Shell 策略

- [x] 完成 safe/write/dangerous 风险分类（策略层；执行器接入前不执行）。
- [x] 完成 workspace 范围控制（策略层拒绝未绑定/越权工作区；system 范围仍禁用）。
- [x] 完成危险命令确认门的策略判定（执行器接入时必须携带确认凭证）。
- [ ] 完成完整审计和跨用户并发隔离。

### Phase 4：Agent 与前端完善

- [ ] Admin 关闭时不注册 Shell 工具。
- [ ] dispatch 和容器启动前再次校验权限。
- [ ] 无 workspace 时不注册 Shell 工具。
- [ ] 接入危险命令确认门。
- [ ] 接入审计日志和脱敏错误。

- [x] Admin 页面增加总开关。
- [x] 用户页面增加独立工具权限区域，并显示全局开关状态。
- [x] 工作区状态与当前会话绑定 API 客户端入口。
- [ ] 补权限、路径逃逸、危险命令、超时和并发测试。
- [ ] 在 devserver 完成真实容器 smoke test。

## 13. 验收标准

### 13.1 V0 验收

- 默认配置下不存在可调用的 Shell 工具。
- Admin 关闭开关后，旧请求也会被 dispatch 拒绝。
- Admin 开启后，只有本地 Admin 可以使用。
- Docker/Podman 不可用时不会回退到宿主机执行。
- 命令超时、输出超限和后台进程都能被收束。
- `sudo`、Docker socket、`--privileged` 和密钥目录访问被拒绝。

### 13.2 V1 验收

- Admin 关闭后，任意用户无法看到或调用 Shell。
- 用户未开启或 session 未绑定 workspace 时，模型工具列表没有 Shell。
- Shell 无法访问 workspace 外路径、软链接目标和宿主机密钥。
- safe 命令可以正常执行并返回统一结果。
- dangerous 命令未确认时不会执行。
- 超时命令会终止进程树并销毁容器。
- 同一 session 并发调用不会交叉使用不同 workspace。
- workspace 切换只影响当前 session。
- `/workspace clear` 后立即无法执行 Shell。
- Docker/Podman 不可用时返回明确错误，不降级到宿主机执行。

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
