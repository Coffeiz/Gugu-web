# Node 终端 Shell 命令生产接线

## 范围

将 `POST /api/v1/terminals/{terminal_id}/input` 与 `POST /api/v1/terminals/{terminal_id}/cancel/{request_id}` 接入 Web Host 生产组合。此切片只实现一次性 Shell 命令；交互 PTY 的创建、重开、重置、终止和 WebSocket attach 仍需独立生命周期。

## 调用链

- `main.ts` 将终端命令 runtime 注入 `createApp`。Fastify 认证后按用户身份调用 Host 服务；缺少 Redis 时命令和取消接口返回 503。
- Core 按 owner 读取终端、会话、工作区和 Shell 权限事实；提交 running/result 事件并维护终端序号。
- Host 将活动租约和取消标记放在 Redis；工作区路径只通过 owner 限定数据库查询解析，并使用 Local 目录句柄固定挂载。
- MXC 执行器负责命令运行；缺失平台支持时拒绝执行，不回退到宿主进程。运行时配置要求 egress 时，Host 只接受既有的本机回环 HTTP(S) 代理，并使用 MXC Bubblewrap 的代理专用策略；当前没有 Node Host 本机代理生命周期，外部/旧 Docker 代理地址仍不支持。

## Python 基线与 TDD

核对 `backend/app/api/v1/terminals.py` 的 `terminal_input`、`_run_terminal_command`、`cancel_terminal_command`，以及 `backend/agent/terminal/access.py` 的 `pty_access`/`authorize_operation`。`backend/tests/terminal/test_terminal_access.py` 覆盖无会话 owner 的 Shell 输入权限，`test_terminal_confirm_input.py` 覆盖无确认码执行、有效确认码兑换和无效确认码阻断。本机没有 `backend/.venv/bin/pytest`，因此只完成源码对照，没有声称 Python pytest 等价通过。

新增受控 egress 回归先失败：管理员配置了有效回环代理时，终端仍被无条件拒绝。实现后，Host 运行配置将 `sandbox.egress_proxy_url` 规范化并限制到 `localhost/127.0.0.1`、无凭据和查询参数；代理专用 MXC 请求继续声明 `egress.default=deny`、拒绝 ingress，并只设置 `network.runtimeConfig.networkProxy`。MXC adapter 自身也拒绝远端代理和带凭据代理。没有代理、代理格式错误或 Bubblewrap `proxyEnforcement` 未就绪时，Shell readiness/执行保持拒绝。请求级 `network=egress` 在全局 profile 未允许时继续拒绝，不以请求 DTO 开放网络。

MXC 官方 Bubblewrap 文档明确代理专用模式只允许 loopback endpoint，命令网络在私有 namespace 中执行，代理负责目标域名解析；远端 endpoint、直接规则与 proxy-only 组合均不适用。因此旧 Docker 网络中的代理地址不能直接透传为 MXC endpoint，Node 也尚未提供本机回环转发服务。

## 验证与限制

- Node 终端命令、Shell 配置与 MXC 策略定向回归：24 通过、1 个 Linux 目录句柄用例在 macOS 跳过。测试覆盖 egress loopback 配置消费、远端/凭据代理拒绝、代理专用 spawn 请求保持 deny-by-default，以及配置缺失/能力缺失时 fail-closed。
- `@gugu/sandbox` typecheck、Web Host production TypeScript build 检查通过。Web Host 全量 typecheck 仍被其他并行测试类型错误阻断；Node 核心测试 runner 当前也因并行修改后的 `packages/core/tests/suites.json` 与磁盘测试发现清单不一致而无法启动，因此未声称 Core vitest 套件通过。
- Python 基线已核对 `backend/app/api/v1/terminals.py`、`backend/agent/tools/shell.py`、`backend/agent/sandbox/docker_runtime.py` 与 `backend/tests/terminal/test_terminal_access.py`、`backend/tests/terminal/test_terminal_confirm_input.py`；本机无 pytest 模块，devserver Mutagen 会话配置指向另一工作树，未 flush 或远程冒充验证。
- 对 Web Host 执行全量 `tsc --noEmit` 仍有并行未提交文件与测试的既有类型诊断；按 `src/main.ts` 和终端 runtime 源文件筛选后，本切片没有诊断。其他文件上的全量检查失败不计为本切片全绿。
- 生产入口代码已接通，但没有接真实 PostgreSQL、Redis、Linux MXC Bubblewrap 或 Host 回环代理服务；当前本机 macOS 只验证了发给 SDK 的请求策略，未执行沙盒命令。未测试 Docker、外部服务或真实部署。sandbox admin egress config/validate API 仍未接，远端 Docker proxy 的 host-local 转发器也仍缺。

