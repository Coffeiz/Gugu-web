# PRD-DEPLOY-2：单容器 Bubblewrap Shell 与外置沙箱自动发现

> 状态：提案；当前单独运行 `gugu-web` 不提供 sandbox Shell，需外部 `sandboxd`；Bubblewrap 单容器执行尚未实现
> 创建：2026-09-27
> 最近更新：2026-09-29
> 关联模块：`backend/agent/sandbox/`、`backend/agent/tools/shell.py`、`backend/app/api/v1/sandbox_admin.py`、`backend/app/core/config.py`、`backend/docker-entrypoint.sh`、`Dockerfile`、`docker-compose.yml`、`docker-compose.prod.yml`
> 背景参考：`docs/prds/【已完成】PRD-SHELL-1-工作区Shell沙盒.md`、`docs/prds/【已完成】PRD-DEPLOY-1-一体化镜像一键部署.md`、Bubblewrap [README](https://github.com/containers/bubblewrap/blob/main/README.md)、Docker [seccomp 文档](https://docs.docker.com/engine/security/seccomp/)

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 单个 `gugu-web` 容器、不用 Compose、不部署 `gugu-sandbox` 时运行 sandbox Shell | 🔲 待实施 | 当前 sandbox scope 只经 Unix Socket 调用 `SandboxdClient`；Socket 不可用即拒绝，没有 Bubblewrap 执行器。 |
| 已部署外置 `gugu-sandbox` / `sandboxd` 时自动识别并调用 | 🟡 部分完成 | 已有 `SandboxdClient` 与 status 协议，但当前依靠固定配置路径，尚无 `auto` provider 选择和探测边界。 |
| 基础跨用户文件隔离及进程隔离 | 🔲 待实施 | 当前 Docker 执行器提供容器隔离；`LocalWorkspaceExecutor` 不是 sandbox 的安全替代。 |
| fnOS 默认容器安全配置下 Bubblewrap 可启动 | 🔲 待验证 | Bubblewrap 依赖 namespace 与 mount；Docker 默认 seccomp/能力组合可能阻止所需调用，必须先在目标 fnOS 实机验证，不能只以包已安装判定可用。 |

## 1. 背景与目标

### 1.1 背景

用户希望从 fnOS 导入并启动一个 `gugu-web` 镜像后即可使用 Shell，不必部署 Compose、额外的 `gugu-sandbox` 镜像或长期运行的沙箱容器。当前执行边界把 sandbox scope 固定交给外置 `sandboxd`；没有该服务时 Shell 失败。`LocalWorkspaceExecutor` 是显式 system scope 的执行器，直接复用它会让模型命令获得应用进程可访问的宿主文件权限，因此不能作为缺少沙箱时的兜底。

### 1.2 目标

- 单容器镜像自带 Bubblewrap 和精简只读 Shell rootfs；不需要 Compose、宿主 Docker Socket、额外容器或另一个沙箱镜像即可运行 sandbox scope 的命令。
- 默认执行 provider 为 `auto`：若发现兼容且健康的外置 `gugu-sandbox` / `sandboxd` Unix Socket，则复用现有 `SandboxdClient` 协议；未发现 Socket 时使用容器内 Bubblewrap runner。
- 单容器路径提供“防误操作、限制常见越权”的基础隔离，目标人群是个人部署及少量可信成员；明确不把 Bubblewrap 路径宣传为对抗恶意租户、内核漏洞或应用容器逃逸的强多租户边界。
- 两种 provider 共用 Shell 授权、工作区归属、确认门、超时、输出上限、审计、取消和配额等应用策略；执行器只负责进程与 OS 隔离。
- Bubblewrap 不可用时明确显示原因并拒绝 sandbox 命令；不得退回 `LocalWorkspaceExecutor`、`os.system`、Docker CLI 或未隔离执行。

### 1.3 部署安全前置条件

Bubblewrap 使用 Linux user/mount 等 namespace 构造文件系统视图；上游说明其依赖 user namespaces，且已移除旧的 setuid 运行模式。Docker 默认 seccomp 是 syscall allowlist，namespace 与挂载操作是否被允许还取决于 daemon profile、容器 capability、内核及 NAS 厂商配置。故“镜像里安装 bwrap”本身不等于可运行。

首个验收门必须在 fnOS 默认创建方式下验证；若默认 profile 阻止 Bubblewrap，则只允许评估并记录能工作的最小单容器运行选项（优先精确 capability，而非 `privileged` 或 `seccomp=unconfined`）。该选项必须可以通过 fnOS 的单容器部署流程应用；如果 fnOS UI/可交付安装入口无法设置它，提案不得宣称开箱即用，须暂停发布并重新评审部署产品形态。运行时 capability 只用于受限 Bubblewrap 启动边界，不得把 Docker Socket 挂进 `gugu-web`。

依据：[Bubblewrap user namespace 与 setuid 说明](https://github.com/containers/bubblewrap/blob/main/README.md#user-namespaces)、[Bubblewrap namespace / 文件系统隔离与限制](https://github.com/containers/bubblewrap/blob/main/README.md#sandboxing)、[Docker 默认 seccomp 与 profile 配置](https://docs.docker.com/engine/security/seccomp/)。

### 1.4 明确不做

- 不在 Web、Worker 或 Gateway 进程中裸执行用户 Shell；不把 `LocalWorkspaceExecutor` 用作失败回退。
- 不要求或自动挂载宿主 Docker Socket，不创建 Docker-in-Docker，也不新增常驻容器。
- 不承诺 Bubblewrap 单容器模式与独立 Rootless Docker 沙箱具有相同的恶意租户隔离强度、网络隔离、cgroup 配额或抗内核攻击能力。
- 不把模型提供的路径、provider 名、Bubblewrap 参数、挂载参数或 Socket 路径当作部署配置；只能从可信服务端配置读取。
- 第一阶段不在 Bubblewrap provider 下开放未经代理强制的公网/内网网络访问；需要受控 egress 时由外置 sandboxd 执行，或后续另立经过安全评审的方案。

## 2. 功能需求

### FR-DEPLOY2-001：默认单容器提供 Bubblewrap sandbox

单容器部署启动后，`sandbox.enabled=true` 且用户具备 Shell 权限时，sandbox scope 默认由 Bubblewrap runner 执行。启动检查验证 `bwrap`、必要 namespace、mount、运行 rootfs、临时目录和隔离参数实际可用；只有完整探测通过才报告 ready。二进制存在但隔离能力不全仍为 unavailable。

### FR-DEPLOY2-002：自动发现并优先使用外置 gugu-sandbox

服务端在启动和状态刷新时检查可信配置中的 `GUGU_SANDBOXD_SOCKET`（未配置时使用约定默认路径），并通过现有 status 协议进行有超时、有限数据长度及协议版本校验的健康握手：

| 发现结果 | `auto` provider 行为 |
|---|---|
| 路径不存在 / 没有 Socket | 选择本容器 Bubblewrap；这是无外置沙箱单容器的常态。 |
| Socket 可连接、协议兼容且 status ready | 选择外置 sandboxd，并通过现有 `SandboxdClient` 执行。 |
| Socket 存在但拒绝连接、status 不健康或协议不兼容 | 报告 `external_unavailable` 并拒绝执行，不悄悄切换 provider；避免将外置部署故障掩盖成不同安全等级的执行。 |
| 外置服务探测期间 | 暂不就绪；探测有严格超时，完成后刷新状态，不阻塞 Web 启动。 |

Socket 检查、所有权/权限校验与握手只能使用可信配置和固定路径；不允许模型或普通用户指定 Socket。只挂载 Socket 的部署可以保持单个应用容器；不要求 Compose，但部署者必须把 Socket 暴露给 app 才能被发现。明确 `external` 的部署模式不得在 Socket 缺失时回退到 Bubblewrap。

### FR-DEPLOY2-003：Bubblewrap 文件系统只暴露最小工作集

- Bubblewrap 使用镜像内专用的精简 Shell rootfs；rootfs 只读，不把应用完整 `/`、Python venv、环境文件、密钥、数据库/Redis 文件或其他用户数据映射进去。
- 每次执行只读挂载运行所需基础目录，只读提供必要的 `/proc`（新 PID namespace）和最小 `/dev`；`/tmp` 为有大小上限的临时空间。
- 唯一可写持久路径是服务端依据 ownership 校验得到的当前用户 Shell 根目录。绑定工作区时只额外挂载当前用户明确授权的工作区，并保持请求要求的只读/可写策略。
- 沙盒内路径由服务端规范化并检查真实路径、符号链接和越界；模型不能传入任意宿主路径或 bwrap 挂载选项。
- 使用独立 mount、user、PID、IPC、UTS namespace；默认创建隔离 network namespace。运行命令使用非特权沙盒 UID，丢弃 capability，关闭额外文件描述符，清空环境后仅加入经 allowlist 选择的变量。

### FR-DEPLOY2-004：Shell 执行生命周期与既有权限策略一致

Bubblewrap 执行器实现现有 sandbox 执行契约，覆盖普通命令、PTY、流式输出、取消、权限撤销、超时、并发限制、输出限制、持久目录配额检查及残留进程清理。超时/取消必须结束整个执行进程组，父 runner 退出时子进程不得继续驻留。Bubblewrap argv 与 namespace 参数为固定服务端策略，不接受模型覆盖。

容器内 Bubblewrap 不具备可移植的 Docker cgroup 配额接口时，不得把 `RLIMIT` 或目录用量检查描述为与 Docker CPU/内存/PID quota 等价；Admin 状态和部署说明必须列出实际生效的资源限制。单容器方案至少强制执行时间、输出、并发、临时空间和持久目录用量限制。若无法证明单用户文件访问隔离，Shell 不得标记 ready。

### FR-DEPLOY2-005：网络与失败状态不降级

Bubblewrap provider 默认使用独立 network namespace（仅 loopback），不继承 app 网络，不传递代理变量来假装强制代理。Bubblewrap provider 收到 `network=egress` 时明确拒绝并提示需要可用的外置 sandboxd；外置 provider 继续执行其已有受控 egress 策略。任何 namespace、mount、rootfs、Socket 或健康检查失败均 fail-closed，禁止转为 system scope。

### FR-DEPLOY2-006：Admin 状态展示真实执行器

Admin 沙盒状态显示：`selected_provider`（`bubblewrap` / `sandboxd` / `none`）、探测状态、就绪结果、不可用原因、Bubblewrap 版本与已验证的隔离能力、外置 Socket 是否被发现（不回显敏感路径）、网络能力、真实生效的资源边界。用户 Shell 开关、Admin 总开关和用户授权仍是执行前必要条件。状态探测不得暴露宿主路径、用户目录或敏感环境变量。

## 3. 技术方案

### 3.1 执行拓扑

```text
单容器，无 Compose / 无 gugu-sandbox
└── gugu-web 容器
    ├── Web / Worker / Gateway
    ├── Shell provider selector（sandbox scope）
    ├── Bubblewrap runner（窄执行入口；无 Docker Socket）
    └── /opt/gugu-shell-rootfs（镜像内、只读、精简工具集）
        └── 每条命令在独立 namespace 中运行

部署了外置 gugu-sandbox
├── gugu-web 容器 ── 受限 Unix Socket ──> gugu-sandbox / sandboxd
└── sandboxd 按现有 Rootless Docker 策略创建短生命周期执行容器
```

两条路径都由一个服务端 provider 选择点接入，不复制 Shell 权限/确认/审计逻辑。自动模式只有在外置服务健康握手成功时选择外置服务；Socket 缺失时使用 Bubblewrap；Socket 存在但坏链路必须显示故障并停用执行。

### 3.2 单容器启动权限与边界

镜像不能自行改变宿主容器创建时的 seccomp/capability 配置。实现前先证明 fnOS 实际运行参数能允许 Bubblewrap 建立所需 namespace/mount；如需运行时权限，只给最小必要项并用真实 `docker inspect`/fnOS 容器详情记录，不采用 `privileged`、宿主 Docker Socket 或无限制 seccomp 关闭作为默认方案。若采用 capability 隔离专用 runner，Web/Worker/Gateway 进程本身不保留该 capability；Bubblewrap 子执行在创建 namespace 后丢弃 capability。

不得把用户可控命令参数直接拼接进 bwrap CLI。执行配置应由固定策略构造 argv，并对每个 bind source 做 ownership、真实路径与 symlink 校验。Bubblewrap 配置失败或内核不支持时不能使用 `--not-a-security-boundary` 继续启动。

### 3.3 配置与发现

新增单一事实源的执行模式配置：`auto`（默认）、`bubblewrap`、`external`、`disabled`。`auto` 只执行 FR-DEPLOY2-002 的握手；`bubblewrap` 强制本地 bwrap；`external` 强制外置 sandboxd；`disabled` 完全不注册/执行 sandbox Shell。`GUGU_SANDBOXD_SOCKET` 只提供外置 Socket 路径，不表示路径存在时可绕过协议握手。实际选择结果为运行时状态，不持久化成跨进程缓存；Socket 变化后通过有界状态刷新更新，不在每条消息动态修改上下文或数据库。

默认 Sandbox 总开关与现有用户权限、scope 决策保持独立；auto 只在服务端选择执行 provider，不扩大调用者权限，不把 provider 能力写入模型提示词。

### 3.4 目录职责与改动范围

```text
backend/agent/sandbox/
  【新增】bubblewrap_executor.py       # 固定 namespace、rootfs、路径与子进程生命周期
  【新增】provider.py                 # auto/external/bubblewrap 选择与状态快照
  【修改】client.py / __init__.py     # 复用现有外置协议并暴露统一 provider
backend/agent/tools/shell.py          # 【修改】sandbox scope 统一 dispatch；system scope 保持分离
backend/app/core/config.py            # 【修改】执行模式、rootfs 与有界探测配置
backend/app/api/v1/sandbox_admin.py   # 【修改】汇报真实 provider 与隔离状态
backend/docker-entrypoint.sh         # 【修改】初始化/探测 Bubblewrap runner，不启动 Docker-in-Docker
Dockerfile                           # 【修改】安装固定来源的 bwrap 与生成精简只读 rootfs
backend/tests/                        # 【修改】执行器、provider、权限边界和自动发现回归
frontend/src/views/Admin/Sandbox/     # 【条件】仅在状态接口改变显示时调整
docker-compose*.yml                  # 【不改】不得将 Compose 设为单容器 Shell 的前置条件
```

`provider.py` 是 sandbox scope 唯一执行器选择边界；`bubblewrap_executor.py` 只负责启动隔离子进程，不重做 Shell 授权、配额、确认或审计。容器入口只做初始化与状态采集，不启动另一个容器管理器。生成的 rootfs 只能由镜像构建流程生成，不在运行中联网下载或覆盖。

## 4. 验证与上线

- 单元测试使用 `tmp_path`、fake Socket 服务和 fake runner；不能读取真实 `Gugu-data/users`、配置文件或真实 Socket。
- `auto` 决策表逐项测 Socket 缺失、健康、拒绝连接、超时、无效 JSON、错误协议、ready=false；只在 Socket 确实不存在时选 Bubblewrap。
- Bubblewrap 集成测试验证：命令可运行；不可见 `/data` 全量、应用 `.env`、Python venv、其他用户目录和宿主进程；本用户工作区权限符合请求；`/tmp` 有界；无网络；无法访问 Docker Socket；退出、取消、超时均回收进程。
- fnOS 真机验收必须使用用户实际的单容器部署流程，无 Compose、无 `gugu-sandbox`、无 Docker Socket，并记录镜像 digest、容器创建安全选项、内核及 Docker 版本。至少跑 `pwd`、`python`、文件读写、超时/取消、用户隔离和越界攻击用例。
- 用一个独立 sandboxd 测试实例验证自动选择 external，并验证该实例故障时不 fallback；不得用真实多用户数据做隔离测试。
- 仅在 Phase 0 的最小权限方案确认后才允许进入构建/部署。发布回滚通过恢复上一镜像与配置，不删除 Shell 用户文件、沙盒目录、数据库或卷。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| fnOS/Docker 的 seccomp、内核 userns 或 mount 策略阻止 Bubblewrap | 单容器镜像内虽有 `bwrap`，Shell 仍不可用 | Phase 0 使用目标机器默认部署做真机证明；只接受最小单容器权限配置；无法由 fnOS 单容器流程配置则停止宣称开箱即用。 |
| 单容器 app 与 Shell 共处同一外层容器 | Bubblewrap 是基础误操作隔离，不等价于独立 Rootless 容器；应用漏洞影响面更大 | 明确目标为个人/可信小群体；不提供恶意租户安全承诺；需要强隔离时部署外置 Rootless sandboxd。 |
| 两条执行器能力不完全相等 | 本地 Bubblewrap 不能天然提供 Docker cgroup 和代理网络能力 | Admin 显示实效限制；本地默认断网；`egress` 仅外置 provider 支持；不伪报等价配额。 |
| Socket 文件存在但服务未就绪或协议不兼容 | 可能误选执行器或静默改变安全属性 | 外置健康握手作为选择条件；Socket 存在但 unhealthy 时拒绝并提示，不回退。 |

待确认事项：无。Bubblewrap 基础隔离边界、auto 发现规则、外置不可用时 fail-closed 和 fnOS 真机硬门均按本 PRD 定案。

## 6. 唯一实施 TODO

### Phase 0：fnOS 可行性硬门

- [ ] `DEPLOY2-001` 在目标 fnOS 默认单容器流程验证 Bubblewrap 所需 user/mount/PID namespace 与 bind mount；验收：不部署 Compose、gugu-sandbox、Docker Socket，记录启动配置、capability/seccomp、内核/daemon 版本和 `bwrap` 实际 smoke 结果。若默认失败，只验证最小单容器权限配置；若 fnOS 无法表达该配置，停止本 PRD 实施并提交产品取舍，不以安装成功替代运行验收。
- [ ] `DEPLOY2-002` 确定本地 Shell rootfs、bubblewrap 版本和发行包来源；验收：镜像内 rootfs 只含批准的 Shell runtime，构建可复现、无运行时下载，bwrap 不使用 setuid/setcap 旧模式。

### Phase 1：Bubblewrap 执行器和最小文件视图

- [ ] `DEPLOY2-003` 实现 Bubblewrap executor 和固定 profile；验收：每次执行拥有独立 mount/user/PID/IPC/UTS/network namespace、只读 runtime rootfs、仅本人目录可写、临时目录限额、无应用凭据和 Docker Socket，隔离失败即拒绝。
- [ ] `DEPLOY2-004` 将 sandbox scope 接到统一执行器接口；验收：Shell 工具的授权、ownership、确认门、审计、配额、输出、超时、取消与权限撤销继续由既有路径负责；system scope 不变，LocalWorkspaceExecutor 不会被 sandbox fallback 调用。
- [ ] `DEPLOY2-005` 补齐进程生命周期与 resource policy；验收：取消/超时/runner 重启会回收整个进程树，运行限制真实可测，未由 Bubblewrap 支持的 Docker cgroup 指标不被宣称已实现。

### Phase 2：外置 sandboxd 自动发现

- [ ] `DEPLOY2-006` 实现 auto/external/bubblewrap/disabled provider 状态机与外置 health handshake；验收：socket 缺失选择 bwrap、兼容健康选择 sandboxd、Socket 存在但不健康/协议错误时拒绝且不 fallback，disabled 完全不执行。
- [ ] `DEPLOY2-007` 接入 Admin 沙盒状态；验收：显示真实 provider、隔离能力、不可用原因与有效资源边界，不泄漏宿主路径/环境变量；开关权限与现有策略一致。

### Phase 3：回归、fnOS 验收和交付

- [ ] `DEPLOY2-008` 完成 sandbox/agent 测试矩阵和跨用户隔离安全回归；验收：路径穿越、符号链接越界、环境/FD 泄漏、宿主进程可见性、网络、超时和取消均覆盖，测试只使用临时目录/fake socket。
- [ ] `DEPLOY2-009` 完成 fnOS 单容器端到端验收与安装说明；验收：不使用 Compose、`gugu-sandbox` 或 Docker Socket 的目标镜像实际运行 Shell；若需单容器 capability，部署说明以最少可执行步骤设置且明确安全影响；外置 sandboxd 发现与故障 fail-closed 另有一组验证结果。
