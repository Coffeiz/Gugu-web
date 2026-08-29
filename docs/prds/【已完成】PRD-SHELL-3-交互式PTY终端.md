# PRD-SHELL-3：交互式 PTY 终端

## 1. 文档信息

- 状态：Phase 5 已完成（实现与 devserver 回归通过）
- 目标：提供接近本地 CLI 的实时交互式终端体验
- 依赖：`PRD-SHELL-1-工作区Shell沙盒`
- 关联：`PRD-SHELL-2-共享协作终端`
- 首版平台：Web

## 2. 背景与目标

当前终端使用一次性 Shell 请求和结构化事件输出：前端提交一条命令，后端执行后返回
结果。这种模式适合咕咕执行工具并记录命令结果，但不是真正的终端，无法提供持续的
stdin/stdout、Tab 补全、方向键、Ctrl-C、光标移动、彩色输出和交互式 CLI 程序支持。

本 PRD 新增“交互式 PTY 终端”模式。用户可以在页面中直接操作一个受控的 CLI 终端，
同时保留咕咕已有的 Shell 工具适配和结构化事件链路。两种模式共享终端领域的数据、
权限和可见性规则，但不共用执行协议。

## 3. 产品边界

### 3.1 用户交互终端

- 用户可以创建多个独立交互式终端。
- 页面提供真实终端输入，不使用普通文本输入框模拟命令行。
- 支持 Tab 补全、命令历史、方向键、退格、Ctrl-C、Ctrl-L、颜色和光标控制序列。
- 支持终端窗口尺寸变化，PTY 的 rows/cols 与浏览器视口保持同步。
- 浏览器刷新或短暂断线后可以重新连接原终端，不重复创建 Shell 进程。
- 用户终端可以绑定工作区，也可以在具有 system 权限时使用 system 范围。

### 3.2 咕咕 Shell 兼容

咕咕调用 `shell_exec` 时继续使用现有受控 Shell 执行链，不强制改成用户 PTY：

- 继续经过 Shell policy、权限、工作区、网络 profile 和危险命令确认。
- 继续由一次性 `ShellSandboxExecutor` 执行命令。
- 命令、stdout、stderr、退出码、失败原因和 Run 关联继续写入 `terminal_events`。
- 页面仍能实时观察咕咕终端的结构化状态和输出事件。
- 咕咕按当前 session、Goal 或 Run 复用对应的 `source=agent` 终端。
- 咕咕终端不因引入 PTY 而绕过现有工具调用限制、确认门或审计规则。

两种终端模式明确区分：

```text
mode=interactive-pty  source=user   浏览器 WebSocket + PTY
mode=agent-events     source=agent  Shell 工具 + 结构化终端事件
```

## 4. 目标架构

```text
用户浏览器
  └─ xterm.js
      └─ WebSocket
          └─ InteractiveTerminalManager
              └─ PTY Bridge
                  └─ sandbox 容器内 bash/zsh

咕咕 Agent
  └─ shell_exec
      └─ ShellSandboxExecutor
          └─ 结构化 terminal_events
```

PTY 与咕咕 Shell 不共享输入通道。它们只共享：

- `terminal_sessions` 终端身份和生命周期
- `terminal_events` 可重放状态与输出摘要
- owner、session、workspace 和 Shell capability 校验
- 沙箱、网络、资源、超时和输出配额策略
- 页面终端列表和统一事件更新

### 4.1 统一沙盒镜像

所有沙盒执行场景共用同一个项目维护的固定镜像，不按用户、会话或工具重复构建：

```text
docker/sandbox/Dockerfile
  └─ gugu-sandbox:<version>@sha256:<digest>
       ├─ 用户交互式 PTY
       ├─ 咕咕 Shell 工具
       └─ 后台 Shell 任务
```

镜像在构建阶段预装 Bash/readline、Python 3、Node/npm、Git、curl、jq 等基础开发工具；
运行时继续使用固定的 `65532:65532` 用户、只读 rootfs、默认断网、资源限制和独立用户
数据挂载。不得在容器启动后通过 apt 或公网安装工具，也不得把宿主机解释器映射进沙盒。

镜像升级必须重新构建、扫描、记录 digest，并在所有沙盒场景完成 smoke test 后，才能更新
`SandboxSettings.image` 和 `image_digest`。升级镜像不改变用户数据目录，也不允许业务进程
接受用户传入的镜像名或 Docker 参数。

## 5. 目标修改文件目录

以下目录是本 PRD 的目标边界。实际实现时优先复用现有模块，不把 PTY 生命周期、
WebSocket 连接和沙箱权限逻辑堆进 API 路由或页面入口。

```text
backend/
├─ agent/terminal/
│  ├─ contracts.py                 # 终端来源、模式、状态和跨层契约
│  ├─ protocol.py                  # Python 侧 WebSocket 消息校验与协议常量
│  ├─ pty_manager.py               # PTY 创建、读写、resize、signal、TTL 和回收
│  └─ sandbox_bridge.py             # PTY 与 sandboxd/受控沙箱的启动边界
├─ agent/sandbox/
│  ├─ protocol.py                  # 扩展 PTY 所需的沙箱请求协议
│  ├─ client.py                    # PTY 沙箱连接客户端
│  └─ sandboxd.py                  # PTY 沙箱侧生命周期与资源限制
├─ agent/security/
│  └─ shell_policy.py              # 复用并扩展 PTY 连接、输入和范围权限判定
├─ app/api/v1/
│  └─ terminals.py                 # 终端 REST API 和 WebSocket 网关入口
├─ app/services/
│  └─ terminals.py                 # 终端记录、事件、模式和状态同步
├─ app/models/
│  └─ __init__.py                  # terminal_sessions / terminal_events PTY 字段
├─ alembic/versions/
│  └─ <timestamp>_add_terminal_pty.py  # PTY 字段和索引迁移
└─ tests/
   ├─ test_terminal_contracts.py   # 模式和协议契约测试
   ├─ test_terminal_access.py      # owner、workspace、Shell capability 回归
   ├─ test_terminal_pty.py         # PTY 生命周期和输入输出测试
   └─ test_terminal_ws.py          # WebSocket 连接、重连、resize 和退出测试

backend/ts/packages/contracts/
├─ src/terminal.ts                 # api/Worker 共用的终端模式和消息联合类型
└─ src/index.ts                    # 导出终端契约

frontend/src/
├─ services/api.ts                 # 终端 REST 类型和 WebSocket 客户端入口
├─ services/terminalSocket.ts      # WebSocket 连接、重连和消息解析
├─ components/terminal/
│  ├─ InteractiveTerminal.vue      # xterm.js 挂载和输入输出适配
│  ├─ TerminalToolbar.vue           # 终止、断开、重命名和删除操作
│  └─ TerminalConnectionStatus.vue  # 连接、重连和不可用状态
└─ views/Terminals/
   └─ index.vue                    # 页面布局、模式分流和终端列表调度

docs/prds/
├─ PRD-SHELL-2-共享协作终端.md      # 保留 agent-events 终端的既有边界
└─ PRD-SHELL-3-交互式PTY终端.md      # 本交互式 PTY 能力的实施契约
```

### 5.1 文件职责约束

- `backend/app/api/v1/terminals.py` 只负责认证、参数解析和连接生命周期，不直接管理
  PTY 进程。
- `backend/agent/terminal/pty_manager.py` 不负责决定用户是否有权限；权限判断必须复用
  `agent/terminal/access.py`、`shell_policy.py` 和现有 workspace owner 校验。
- `backend/agent/tools/shell.py` 保持咕咕一次性 Shell 工具适配，不改成浏览器 PTY 输入
  通道。
- `frontend/src/views/Terminals/index.vue` 只按 `mode` 选择交互式组件或结构化事件组件，
  不在页面内解析 ANSI 或实现重连状态机。
- `backend/ts/packages/contracts/src/terminal.ts` 与 Python 契约保持字段语义一致，不能
  让前端自行定义另一套终端模式枚举。
- 不删除现有 `/terminals/{id}/input` 和 `/terminals/{id}/events`，直到咕咕
  `agent-events` 链路完成迁移并通过回归测试。

## 6. 终端协议

### 6.1 WebSocket 地址

```text
GET /api/v1/terminals/{terminal_id}/ws
```

建立连接时后端必须重新校验：

- 当前用户是否为终端 owner
- Admin 和用户 Shell capability 是否仍然开启
- 终端工作区是否仍然授权
- 终端是否允许交互输入
- 当前终端模式是否为 `interactive-pty`

### 6.2 客户端消息

```json
{"type":"input","data":"ls -la\n"}
{"type":"resize","cols":120,"rows":32}
{"type":"signal","signal":"SIGINT"}
{"type":"detach"}
```

客户端不得传入或覆盖 `uid`、挂载、网络、容器、工作区根目录、capabilities、环境白名单
和 Shell 启动参数。终端安全配置只能由服务端根据权限和沙箱策略生成。

### 6.3 服务端消息

```json
{"type":"ready","terminalId":"...","cols":120,"rows":32}
{"type":"output","data":"..."}
{"type":"status","status":"running"}
{"type":"exit","code":0,"signal":null}
{"type":"error","code":"terminal_unavailable"}
```

`output.data` 允许包含 ANSI 控制序列，前端必须交给终端模拟器解析，不得当作普通 HTML
插入页面。事件日志和诊断日志不得记录完整输入或原始输出。

## 7. PTY 生命周期

### 7.1 创建与连接

1. 用户创建终端记录，服务端生成唯一 `terminal_id`。
2. 首次 WebSocket 连接时，在受控沙箱内启动 PTY 和指定 Shell。
3. 服务端保存 PTY 的进程标识、沙箱标识、连接数和最后活动时间。
4. WebSocket 连接成功后发送 `ready`，随后转发双向字节流。

### 7.2 断线与恢复

- 单个浏览器断开不立即终止 PTY。
- PTY 在无连接状态下保留有限 TTL，超过 TTL 自动终止并回收。
- 重连使用原 `terminal_id`，服务端只允许 owner 重新接管。
- 服务重启后不能假设内存中的 PTY 仍然存在；数据库状态必须校正为 `exited` 或
  `unavailable`，禁止产生“假运行”终端。
- 多个观察连接可以共享同一个 PTY，但输入权限必须有明确的单写入者策略。

### 7.3 终止与删除

- “停止”向 PTY 发送受控终止信号并等待进程退出。
- 超时后由服务端执行强制回收，不能依赖浏览器关闭连接。
- 删除终端时先终止 PTY，再删除终端记录和事件；删除操作使用统一确认门。
- 普通关闭只断开查看，不杀死仍在运行的 PTY。

## 8. 安全要求

PTY 会使用户直接拥有交互式 Shell，不能再把命令关键字扫描当作主要安全边界。必须
依赖沙箱本身和服务端不可覆盖的安全配置：

- 固定 UID/GID，禁止提权和 suid 生效。
- 固定工作区根目录，阻止 `..`、符号链接和挂载越界。
- 使用 drop-all capabilities、NoNewPrivs、seccomp 和只读系统目录。
- 不挂载 Docker socket、宿主机 PTY 或未授权宿主目录。
- 网络 profile 由服务端选择，浏览器和用户输入不能修改。
- 资源限制覆盖 CPU、内存、进程数、磁盘、输出量和运行时长。
- Shell capability 被撤销时，立即拒绝新连接和新输入，并终止或冻结现有 PTY。
- system 范围必须单独授权，默认终端仍运行在用户沙盒范围。
- 输入、输出、环境变量和命令参数不得写入普通可见日志；诊断只记录指纹、长度、
  状态和错误类型。

## 9. 前端方案

- 使用 `xterm.js` 渲染终端，不自行实现 ANSI、光标和补全逻辑。
- 使用 `@xterm/addon-fit` 根据容器尺寸计算 rows/cols。
- 使用 ResizeObserver 触发 resize 消息，避免依赖固定窗口尺寸。
- 终端输出区域使用传统暗色终端表面，输入光标、选择文本和 ANSI 颜色保持可读。
- 页面保留终端列表、来源、工作区、运行状态和删除入口。
- `agent-events` 终端继续按命令、stdout、stderr 和状态事件展示，不强行伪装成 PTY。
- WebSocket 断线显示连接状态，并使用退避重连；重连失败时提供明确的终端不可用状态。

## 10. 数据模型扩展

在现有 `terminal_sessions` 基础上增加或确认以下字段：

```text
mode: interactive-pty | agent-events
pty_pid: nullable
pty_sandbox_id: nullable
pty_cols: nullable
pty_rows: nullable
attached_clients: integer
last_attached_at: nullable
detached_at: nullable
```

PTY 运行状态不能只依赖数据库字段。服务端必须通过 PTY Manager 的进程状态和沙箱状态
校验后再对外返回 `running`，避免遗留进程或假状态。

## 11. 实施 Todo

### Phase 0：契约与安全边界

- [x] 更新 Python 与 TypeScript 共享终端类型，增加 `mode=interactive-pty|agent-events`。
- [x] 明确 PTY 连接、输入、resize、signal、detach 和退出事件协议。
- [x] 复核 Shell capability、system 权限、workspace owner 和危险操作确认门。
- [x] 设计 PTY 沙箱启动参数、资源配额和孤儿进程回收策略。
- [x] 增加“PTY 不继承命令扫描作为主要安全边界”的安全说明和测试约定。

Phase 0 只落地契约和边界，不启动 PTY、不新增 WebSocket 路由、不改变现有
`ShellSandboxExecutor`，也不把 `agent-events` 终端误标为交互式终端。数据库中的 PTY
运行字段在后续迁移阶段增加，避免契约先行时产生未完成的持久化状态。

### Phase 1：服务端 PTY Manager

- [x] 实现 PTY Manager 的创建、读写、resize、signal、detach、TTL 和 terminate 生命周期。
- [x] 定义 sandboxd 与 PTY Manager 的客户端/服务端消息校验契约。
- [x] PTY Manager 只接受受控 sandbox transport，不允许宿主机直接执行。
- [x] 增加 PTY 进程、沙箱和窗口尺寸的内存快照，供持久化层校正。
- [x] 在 Docker 沙箱执行器内提供固定安全参数的真实 PTY 启动、读写、resize、signal 和回收能力。
- [x] 增加 sandboxd 长连接 PTY transport，Web/API 不直接启动宿主机 PTY。
- [x] 实现断线 TTL、多连接控制和应用服务退出时的状态清理。
- [x] 为输出设置缓冲区、速率、总量和单连接资源限制。

Phase 1 当前已完成生命周期管理核心、沙箱桥接安全契约和固定 Docker PTY 启动参数生成。
`SandboxPtyBridge` 在
sandboxd 尚未提供交互式 PTY 前会明确拒绝启动，不会回退到 Web/API 进程的本机
Shell。真实 sandboxd PTY 协议和 PTY 输出边界已经接入；数据库字段持久化、断线 TTL、多连接
控制和应用退出清理已经接入；sandboxd 启动时会清理固定命名空间中的遗留 PTY 容器。
数据库已增加 PTY 模式和运行快照字段。

### Phase 2：WebSocket 网关

- [x] 增加 `/terminals/{id}/ws` 并接入统一认证和 owner 校验。
- [x] 实现双向 input/output、resize、signal、status 和 exit 消息。
- [x] 接入统一事件更新，终端列表和状态变化能够被其他页面实时看到。
- [x] 处理断线重连、重复连接、半关闭连接和后端异常。

### Phase 3：xterm.js 页面

- [x] 集成 xterm.js 和 fit addon。
- [x] 将输入框替换为真实终端挂载区域，仅对 `interactive-pty` 使用。
- [x] 支持 Tab、方向键、Ctrl-C、Ctrl-L、ANSI 输出和窗口 resize。
- [x] 完成暗色终端视觉、连接状态、停止、重命名和删除交互。
- [x] 保留 `agent-events` 的结构化输出展示。

### Phase 4：咕咕 Shell 适配与回归

- [x] 验证 `shell_exec` 仍使用原有一次性执行链。
- [x] 验证咕咕终端自动创建、复用、Run 关联和事件持久化不受影响。
- [x] 验证用户 PTY 输入不会绕过 Shell policy、权限和工作区隔离。
- [x] 验证用户终端和咕咕终端可以同时存在并正确区分来源。

### Phase 5：测试与运维

- [x] 构建 `docker/sandbox/Dockerfile`，在 devserver 记录通用镜像 digest，并完成受限用户 smoke test。
- [x] 用同一 digest 验证用户 PTY、咕咕 Shell 和后台 Shell 均复用同一镜像引用，不按沙盒重复安装工具。
- [x] 增加 PTY 单元测试：输入转发、Tab 补全启动参数、resize、信号、退出和输出限制。
- [x] 增加安全测试：跨用户连接、越权 workspace、system 权限、路径逃逸、Rootless Docker 和资源限制。
- [x] 增加 WebSocket 断线、重连、TTL、孤儿进程和服务重启状态校正测试。
- [x] 增加终端页面回归覆盖真实终端挂载、实时输出、终止、删除和多终端切换。
- [x] 在 devserver 验证 Compose 服务展开、sandboxd Socket 和 WebSocket Upgrade 链路。

当前状态：通用镜像已在 devserver 使用清华 Debian 镜像构建，digest 为
`sha256:d96f4b4467f057ae31545e54f91a064d0470dd9b82f80ecab73d3dd75a1004ac`；受限用户 smoke
test 和终端/沙盒回归均通过。devserver 的用户运行配置仍固定旧 digest，因此没有未经确认覆盖
`config.override.json`；切换生产运行配置时必须先备份并只更新 sandbox 的 image/digest 字段。
当前 devserver 未安装 Trivy/Grype，Phase 5 的“扫描”以镜像包清单和运行时安全基线检查代替，
上线前仍应在发布流水线接入漏洞扫描器。

## 12. 验收标准

- 用户可以在页面中输入命令并实时看到逐字节输出。
- Tab 补全、方向键、Ctrl-C、颜色和光标行为与普通 CLI 基本一致。
- 终端窗口变化后，CLI 的行列尺寸正确同步。
- 浏览器刷新或短暂断线后可以恢复同一个 PTY，不重复创建 Shell。
- PTY 始终运行在受控沙箱内，不能通过交互输入越过用户、工作区或 system 权限边界。
- 咕咕 Shell 的既有工具调用、确认门、Run 关联、结构化事件和页面观察能力不回归。
- 用户 PTY 与咕咕事件终端在列表、状态、权限和输出来源上明确区分。
- 停止、删除、超时、权限撤销和沙箱退出都能终止或校正 PTY 状态。
- 测试不写入真实用户配置、真实工作区或真实生产终端输出。
