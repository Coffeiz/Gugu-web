# PRD-DEPLOY-2：一体化镜像内置 Rootless 沙盒

> 状态：实施中；以 C9 的内置 sandboxd/runtime bundle 为代码基线，目标改为 app 容器内运行 Rootless Docker；完成构建后由用户导入 fnOS 验收
> 创建：2026-09-27
> 最近更新：2026-09-29
> 关联模块：`Dockerfile`、`backend/docker-entrypoint.sh`、`backend/agent/sandbox/`、`docker-compose.yml`、`docker-compose.prod.yml`、`.github/workflows/docker-release.yml`
> 背景参考：`docs/prds/【已完成】PRD-DEPLOY-1-一体化镜像一键部署.md`、`docs/prds/【已完成】PRD-SHELL-1-工作区Shell沙盒.md`、`docs/superpowers/specs/2026-09-22-offline-sandbox-bundle-design.md`

## 0. 当前基线与目标

C9 已恢复单容器内置 `sandboxd`、逐命令执行容器和镜像 bundle，但原设计要求把宿主 Docker Socket 挂进 app。该依赖在 fnOS 单镜像部署中难以配置，且把宿主 Docker 控制权交给 app。此 PRD 保留 C9 的执行 API、权限检查、确认门、逐命令容器和 runtime bundle，**只将 embedded 模式的 Docker daemon 改为 app 容器内的 Rootless Docker**。

目标部署形态：用户在 fnOS 导入并启动一个 `gugu-web` 镜像，按 fnOS 的“使用高权限执行容器/privileged”选项启动；无需 Compose、宿主 Docker Socket 映射、单独 sandboxd、gugu-sandbox 常驻服务或额外手动配置，即可使用隔离 Shell。空闲时 Docker 中只有 `gugu-web`；执行 Shell 时由其内部 Rootless daemon 临时创建 `gugu-sandbox-*` 子容器，结束后回收。

## 1. 目标、范围与边界

### 1.1 目标

- 一体化镜像携带 Rootless Docker daemon 所需运行时、sandboxd 和本次 app 构建对应的执行镜像/runtime bundle；用户仅导入单个 app 镜像。
- embedded 模式由入口自动启动、探测并监督内部 Rootless daemon 与 sandboxd；不连接、不探测、不挂载宿主 Docker Socket。
- 复用现有 `SandboxdClient`、`SandboxdServer`、`DockerSandboxExecutor` 执行链；Shell/PTY/MCP stdio 仍在逐次创建的子容器中运行，不能回退至 app 容器本机执行。
- 用户数据只挂载授权工作区；执行容器不获得宿主 socket、app 配置、密钥或无关用户数据。
- 分体业务部署保持独立 external `sandboxd` + Rootless Docker 的拓扑；backend/worker/gateway 不接触 Docker API/socket。
- App 每次构建都从同一源码提交构建并打包执行镜像。embedded 用户不单独管理 sandbox 版本；分体部署的独立 sandbox 发布生命周期保留。
- 单用户个人自托管优先开箱可用，不把 cgroup 配额作为运行前置条件；保留应用层并发、超时、输出限制、取消和清理。状态页如无法获得 cgroup 限额，应诚实显示“未设置/不可用”，不得伪报已施加硬限制。

### 1.2 明确不做

- 不依赖、自动挂载或自动发现宿主 Docker Socket；不要求用户编写 Compose 或手动挂 socket 路径。
- 不使用 Bubblewrap；不在 app/worker 进程直接执行用户命令；不使用 `LocalWorkspaceExecutor` 作为故障回退。
- 不声称 privileged app 容器适用于多租户、公网或业务服务器。Rootless 限制的是内部 Docker daemon/执行容器权限，并不能消除外层 privileged app 容器自身的宿主机风险。
- 不把 Rootless daemon 作为第二个常驻 Docker 容器；不要求用户部署或更新独立 sandboxd 容器。
- 不要求 cgroup v1/v2；资源使用受应用层策略管理，不承诺在缺少 cgroup 控制器时具备内核级 CPU/内存硬上限。
- 不改变分体部署的外部 Rootless 要求，不兼容旧 Compose 沙箱拓扑的自动迁移/回滚，也不清理用户数据、宿主镜像或网络。

## 2. 功能需求

### FR-DEPLOY2-001：内置 Rootless daemon 生命周期

embedded 入口启动时，在专用非 root 服务账号下启动镜像内的 Rootless Docker daemon，使用私有 `HOME`、持久 Docker data-root 和仅容器内可访问的 Unix socket（默认 `/run/user/1000/docker.sock`）。daemon 不监听 TCP。随后由独立 supervisor 启动 `sandboxd`；daemon 或 manager 失败只令 Shell 未就绪，不应重启 Web/数据库。容器停止时依次停止 sandboxd、Rootless daemon，并清理由本次生命周期产生的临时资源。

daemon 不可用、初始化条件不满足或 privileged 前置条件缺失时：Admin 明确显示当前管理模式、Rootless 状态和可操作原因；Shell fail-closed；不连接宿主 daemon、不本机执行、不暗中降级为 Rootful。

### FR-DEPLOY2-002：Rootless 运行时与构建 bundle

最终一体化 app 镜像需包含可审计、版本固定的 `dockerd-rootless`、`rootlesskit`、`newuidmap/newgidmap`、`slirp4netns`（或经验证的等价用户态网络驱动）、overlay/fuse 所需组件及其运行库。构建阶段必须验证版本、架构和依赖闭合；不能从未固定 tag 的在线镜像复制可执行文件。优先采用 Docker 官方 Rootless 发行资产/官方构建产物，并记录来源、版本、校验和与许可证。

每次一体化 app 构建从同一源码提交构建执行镜像，跑 smoke 与安全扫描后生成归档/manifest，最终 app 携带该 bundle。首次启动或内部 daemon 缺少镜像时，仅从校验通过的本地归档导入；摘要、image ID、架构不匹配时拒绝 Shell，不在线 pull 替代镜像。导入必须可重入，状态目录损坏要清楚报错，不能清空 `/data` 中其他内容。

### FR-DEPLOY2-003：路径、UID 映射与用户数据隔离

Rootless daemon 和 app 位于同一个外层容器文件系统视图，因此执行容器的 bind source 使用 app 容器内的绝对路径（授权根默认为 `/data/users`），不得再调用 `docker inspect <outer-container>` 反查宿主机 bind 路径。内部 daemon 用户只获得穿越 `/data` 与授权 `/data/users` 子路径所需的 ACL，不递归扩权整个数据卷。执行器只接收经过所有权和路径策略校验的授权根，不能接收模型提供的 host path 或 Docker 参数。

专用 Rootless 用户需具有受控的 subordinate UID/GID 映射；映射准备必须幂等、范围固定并限制在外层容器内。需验证 NAS bind mount、旧数据 owner/ACL、文件新建/编辑/删除以及升级重启后的可访问性。无法满足 UID/GID 映射或挂载语义时保持 Shell 未就绪，不得放宽为 Rootful 子容器或递归修改整个 `/data` 权限。

### FR-DEPLOY2-004：fnOS 启动前置条件与产品说明

单容器安装只要求导入镜像、配置端口、挂载持久 `/data`（`/config` 按现有部署约定）并在 fnOS UI 选择“使用高权限执行容器/privileged”。不需要选择 sock 文件或配置 Docker 环境变量。镜像不得含宿主 socket volume 或 `DOCKER_HOST=unix:///var/run/docker.sock` 默认值。README、quick-deploy、Admin 状态和 fnOS 测试说明均须明确：privileged 是外层容器运行前置条件；Rootless Docker 在其内部运行；这属于可信个人单用户部署，不能作为多租户安全部署建议。

若 Docker API 可检测到外层未授予 Rootless 所需能力，应在状态页说明所需 fnOS 操作，而不是尝试 Rootful daemon。不同 NAS 内核/安全配置可能拒绝 user namespace、mount namespace、网络 namespace 或 id-map；实际可用性由 fnOS 真机导入测试确认。

### FR-DEPLOY2-005：部署模式与管理器边界

部署模式由受信配置明确指定，不由 socket 探测隐式推断：

| 模式 | 管理器 | Docker daemon | 外层/内层权限 | Shell 不可用时 |
|---|---|---|---|---|
| `embedded` 单容器 | app 容器内 sandboxd | app 容器内 Rootless Docker | fnOS 外层容器需 privileged；内层 daemon Rootless | 明确失败，绝不连宿主 daemon或本机执行 |
| `external` 分体业务 | 独立 sandboxd | 由外部 Rootless daemon 提供 | 仅独立 manager 持有 daemon socket；业务 app 不持有 | 明确拒绝，不回退 |
| `disabled` | 不启动 | 不提供 | 不适用 | 管理员关闭/未配置 |

单容器 `embedded` 默认启用。生产分体 Compose 显式使用 `external`、强制 Rootless，保持现有 Unix API 边界。任何模式下，执行容器均不得挂载 Docker socket。

### FR-DEPLOY2-006：网络、资源与清理

`network=none` 必须在内部 Rootless daemon 上无外网；受控 egress 必须经现有代理策略，不可静默连接默认网络。Rootless 网络驱动不支持所需网络策略时，对该 profile fail-closed。保留逐命令隔离、非 root 执行 UID、只读 rootfs、drop capabilities、no-new-privileges、路径授权、应用层并发限制、超时、取消、输出上限和带 Gugu 标签的临时容器回收。若具体内核能力不受支持，状态/文档应报告限制；不得在测试未通过时宣称等价隔离。

无 cgroup 不影响管理器启动；资源控制 UI/API 不得将“配置值”误报为“内核已强制”。本期不实现宿主级/内核级资源硬上限。

## 3. 目标拓扑

```text
fnOS / Docker（用户导入单一 gugu-web 镜像；外层选择 privileged）
└── gugu-web（唯一常驻容器）
    ├── Web / Worker / Gateway / PostgreSQL / Redis
    ├── dockerd-rootless（专用非 root UID；私有 socket/data-root）
    ├── sandboxd（窄 Unix API，仅调用内部 daemon）
    └── idle: 无 shell 子容器
        active shell: 内部 daemon 创建 gugu-sandbox-*，结束回收
```

不挂宿主 `/var/run/docker.sock`，不额外常驻 sandboxd 容器，不用 Compose。执行器和 `sandboxd` 协议继续复用 C9 实现。内部 Rootless daemon 的 socket 位于 app 私有运行目录，不能进入执行容器。

## 4. 技术约束

- 容器内 `DOCKER_HOST` 只在 embedded sandbox manager 子进程环境中指向内部 Rootless socket；不能让 app 全局环境意外选择外层 socket。
- Rootless daemon 持久数据位于单独可配置目录（默认 `/data/sandbox-rootless`），不与 PostgreSQL/Redis/user files 混用。该目录只包含 daemon 元数据、缓存和导入的镜像，不作为执行容器的用户挂载源。
- `docker_container_storage_root()` 的“宿主反查”仅可用于 external 模式；embedded 模式直接使用授权的容器内 `/data/users` 路径。
- 首次启动不应在无交互时进行无界下载；sandbox images 从 app 内只读 bundle 导入。Rootless daemon 包随 app 镜像分发。
- 入口和管理器启动失败可降级为 Web 可用、Shell 不可用；运行 Shell 必须经真实内部 Rootless daemon readiness 和准确镜像校验。
- 单容器 privileged 外层属于高信任部署：应用自身漏洞风险不由 Rootless 子 daemon 消除。个人单管理员用途是明确产品边界。

## 5. 文件范围与职责

```text
Dockerfile                                        【修改】固定来源安装 Rootless Docker runtime 和工具依赖
backend/docker-entrypoint.sh                     【修改】启动/停止内部 Rootless daemon，再托管 sandboxd
backend/scripts/runtime/                          【新增/修改】daemon bootstrap、ready 等待、持久目录/用户映射初始化
backend/agent/sandbox/docker_runtime.py          【修改】embedded socket、状态探测、Rootless readiness
backend/agent/sandbox/sandboxd.py                 【修改】embedded 容器内路径，不反查外层宿主 mount
backend/agent/sandbox/docker.py                   【条件】Rootless bind/UID 映射修正
backend/agent/sandbox/bundle_runtime.py           【修改】通过内部 Rootless daemon 导入并验证 bundle
backend/app/api/v1/sandbox_admin.py               【修改】准确报告 embedded Rootless 与 privileged 前置条件
frontend/src/views/Admin/Sandbox/                 【条件】呈现无 privileged/daemon 的明确状态，不误报 Rootful fallback
Dockerfile.sandbox-bundle、scripts/release/       【修改】app/sandbox 同提交构建、内嵌 bundle、离线候选包
.github/workflows/docker-release.yml              【修改】最终单镜像含 Rootless 运行时和同轮已扫描 bundle
docker-compose.yml / docker-compose.offline.yml   【修改】默认 app 不挂 host socket；Compose 不拥有 embedded daemon
 docker-compose.prod.yml                           【保持】external 分体部署继续独立 Rootless
 docs/quick-deploy*.md、README*.md                 【修改】fnOS privileged 单镜像说明及信任边界
 backend/tests/test_unified_image_sandbox_boundary.py 【修改】禁止 host socket、验证内部 daemon 拓扑
 backend/tests/test_docker_runtime.py、test_bundle_runtime.py 【修改】Rootless socket / readiness / bundle
 backend/tests/                                   【新增】bootstrap 生命周期、映射和 fail-closed 回归
```

## 6. 执行 TODO 与 Phase

### Phase 0：内部 Rootless 能力门

- [x] `DEPLOY2-000` 将 PRD 目标切换至单容器内置 Rootless Docker；本文档为后续实施依据。
- [x] `DEPLOY2-001` 固定运行时来源为 Debian Trixie 仓库签名包（`docker.io`、`docker-cli`、`rootlesskit`、`slirp4netns`、`fuse-overlayfs`、`uidmap`），构建时记录实际包版本并验证运行库闭合；不从未固定 tag 的第三方镜像复制二进制。
- [x] `DEPLOY2-002` 在临时测试环境复现“外层 privileged + 内部 Rootless daemon”：校验无宿主 socket、daemon 报告 Rootless、network=none 子容器执行、容器内路径 bind mount 可读写；记录运行内核能力限制。不得将未经验证的能力标为完成。

### Phase 1：单镜像 daemon 集成

- [x] `DEPLOY2-010` 将 Rootless runtime 纳入 Dockerfile，验证架构、依赖、可执行文件和镜像体积；不引入 Bubblewrap、不引用浮动镜像 tag。
- [x] `DEPLOY2-011` 实现专用 Rootless 用户、固定 subordinate UID/GID、持久 daemon 数据目录、内部 Unix socket 与启动等待/健康检查；重启幂等、停止时有序清理。
- [x] `DEPLOY2-012` embedded manager 只连接内部 Rootless socket；删除 embedded 路径中对宿主 socket 的默认、fallback 和 inspect 反查；external 模式逻辑保持独立。
- [x] `DEPLOY2-013` 修正 embedded `/data/users` bind source 与 Rootless 文件映射；覆盖既有 owner/ACL、文件创建/编辑/删除和重启，不递归放宽整个 `/data`。

### Phase 2：产品状态、网络与隔离验收

- [ ] `DEPLOY2-020` Admin 显示 embedded Rootless daemon、Shell runtime、镜像 bundle 和 privileged 前置失败原因；缺少能力时 fail-closed，不声称 cgroup 硬限额。
- [ ] `DEPLOY2-021` 内部 daemon 实测 `network=none` 与受控 egress；代理/驱动未就绪时拒绝 egress；检查内层执行容器看不到 daemon socket。
- [ ] `DEPLOY2-022` 回归逐命令执行、PTY、MCP stdio、并发、取消、超时、输出限制、标签清理，以及外部 Rootless Compose 模式。

### Phase 3：测试、文档及设计复查

- [x] `DEPLOY2-030` 定向 pytest、构建/manifest 脚本测试、compose 配置检查通过；列明无法在本机验证的真实内核能力。
- [x] `DEPLOY2-031` 更新 README、quick-deploy、Dockerfile 注释、Admin 文案和 CHANGELOG，统一说明 fnOS 外层 privileged、内层 Rootless、个人信任边界、无 cgroup 硬保证。
- [x] `DEPLOY2-032` 逐条对照本 PRD 检查实现与测试：不存在宿主 socket 默认/探测/挂载；embedded/external 责任边界一致；网络策略和数据权限无静默降级。记录偏差，先修复再构建。

### Phase 4：devserver 构建 fnOS 导入包

- [x] `DEPLOY2-040` 在 devserver 按仓库 local skill 同步后的代码构建唯一候选镜像；检查 Docker context、磁盘余量、tag 不冲突，不清理用户数据或运行中的服务。
- [x] `DEPLOY2-041` 导出**未压缩 `.tar`** 到 `<devserver用户目录>`，验证 tar 可列举、导入结构完整、记录 SHA-256 / 镜像 ID / 大小；不覆盖已有文件、不生成 `.tar.gz`。
- [x] `DEPLOY2-042` 将 tar 路径、校验信息、fnOS privileged 部署步骤和未完成的真机验收项交给用户。fnOS 实测由用户导入后完成，不把未实测宣称成已通过。

#### 2026-09-29 devserver 冒烟记录

- 外层 Docker 使用 `--privileged` 启动单个候选 app 容器；只绑定临时 `/data`、`/config`，没有挂载宿主 Docker Socket，也没有启动外部 `sandboxd` 容器。
- 内部 daemon `SecurityOptions` 含 `name=rootless`，RootlessKit 使用 `slirp4netns`，Docker API 只监听 `/run/user/1000/docker.sock`。首次 sandboxd 状态探测校验并导入 schema v2 bundle 后，沙盒与 egress-proxy 两张镜像均可用。
- 实际 sandboxd `execute` RPC 与 `network=none` 子容器 shell 均通过；执行身份为 UID/GID 65532。对 `/data/users` 下的临时授权目录完成 bind mount 读写；外层容器重启后健康检查恢复，bundle 镜像仍可使用。
- 构建时验证运行时包版本：`docker.io` / `docker-cli` `26.1.5+dfsg1-9+deb13u1`、`rootlesskit` `2.0.2-2+b9`、`slirp4netns` `1.2.1-1.1`、`fuse-overlayfs` `1.14-1+b1`、`uidmap` `1:4.17.4-2`。候选镜像平台为 `linux/amd64`，镜像 `Size` 为 1,488,515,770 字节。
- 已导出 `<devserver用户目录>/gugu-web-fnos-rootless-poc-20260929.tar`，未压缩，1,488,567,808 字节；SHA-256：`6c9da98a2d0a36d2eddf61822c6e4c41c74ad0a15e23f39c8665e144b0eca501`；镜像 ID：`sha256:f706f4cf9e9596dce93c73a200606582a33fd8e5d159264db4223b03771b9871`。tar 包含单一 `coffeiz/gugu-web:rootless-poc-20260929` repo tag，成员完整可列举。
- devserver 测试内核为 `7.0.0-31-generic`，Docker 报告 cgroup v2、`CgroupDriver=none`；这不是 fnOS 内核验证，也不提供 cgroup 硬限额结论。
- 尚未完成：fnOS 真机导入/启动；受控 egress 网络端到端；PTY、MCP stdio、并发/取消/超时等全套运行回归。它们保持为未完成验收，不因本次 shell 冒烟通过而推定通过。

## 7. 验收方案

- 单容器无 Compose、无宿主 Docker Socket、无额外 sandboxd：启动后 Admin 显示内置 daemon Rootless ready；idle 时宿主只看到 gugu-web 容器。
- 通过 Shell 和 PTY 执行固定无害命令，确认仅在临时 `gugu-sandbox-*` 中运行；读写授权工作区成功，其他用户/系统路径拒绝；退出后容器清理，daemon 重启后镜像与数据状态可恢复。
- 从执行容器检查 `/run/gugu-rootless/docker.sock`、宿主 socket、`/data/postgres`、`/data/redis`、其他用户目录和 `/config` 均不可访问。
- privileged 未开启、user namespace/id-map 不可用、Rootless daemon 起不来、manifest 不符：Web 保持可用，Shell 显示诊断状态，不能 Rootful fallback、本机 fallback 或宿主 socket fallback。
- 网络 `none` 无外网；egress 只能访问受控代理允许的目标。目标 NAS 内核不能实现该策略时，不得报告通过。
- 无 cgroup 环境仍可执行，但 UI/API 不得声称 CPU/内存/PID 内核硬限制已生效；现有应用并发/超时/输出限制仍生效。
- 分体部署 backend/worker/gateway 不持 daemon socket；external manager 必须 Rootless；Rootful external 被拒绝。
- 最终 tar 与通过检查的候选 app image ID 一致；最终由用户在 fnOS 真机验证 userns、privileged、挂载、Shell、网络与重启持久性。

## 8. 风险与已定决策

| 风险 | 影响 | 对策 |
|---|---|---|
| fnOS privileged app 容器 | 外层 app 被攻破后宿主风险高；内部 Rootless 不能消除此风险 | 面向可信个人单管理员；醒目说明，不建议多租户/公网/业务服务器 |
| NAS 内核/面板未开放 user namespaces 或必要 syscall | 内部 Rootless daemon 无法启动，Shell 不可用 | 先做 privileged Rootless POC；状态明确报告缺失能力；不 Rootful 降级 |
| Rootless bind mount UID/GID 映射 | 文件可能无法读写或出现映射 owner | 固定映射设计，真实覆盖 fnOS bind mount 与既有数据权限；权限失败 fail-closed |
| Rootless 网络策略支持度不同 | egress 隔离可能比普通 Docker 更受限 | 对 none/egress 分别实测；不满足即关闭对应 profile，不放通默认网络 |
| 内置 daemon 和镜像增大 app | 下载与磁盘占用上升 | 体积增量接受并量化；版本、摘要、架构可复核；不重复打包 runtime |
| 无 cgroup 控制器 | 缺少内核级硬资源上限 | 明确不作为启动条件；只承诺实际仍工作的应用层限制 |

已定决策：单容器优先开箱易用，不依赖 Compose/宿主 Docker Socket；外层 privileged、内层 Rootless Docker；不考虑 Bubblewrap 和 cgroup；个人自托管可接受该信任等级；分体业务部署继续使用独立 Rootless sandboxd。
