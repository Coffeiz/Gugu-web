# PRD-MCP-1：MCP 工具接入

> 状态：全部待实施（PRD 定稿待评审，未开始编码）
> 创建：2026-09-13
> 最近更新：2026-09-13
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/capabilities/selector.py`、`backend/agent/loop_drivers.py`、`backend/agent/core.py`、`backend/app/api/v1/agent_admin.py`
> 背景参考：MCP 规范（Model Context Protocol，tools 能力）；`agent/__init__.py` 路线图已预留 mcp Phase；进程内子进程协议先例见 RAG TS sidecar 与 sandboxd

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| MCP 远程 server 工具接入（Phase 1） | 🔲 | 未实施 |
| stdio 本地 server 接入与热重载（Phase 2） | 🔲 | 未实施 |
| 每用户自带 MCP 配置（Phase 3） | 🔲 | 未实施，需单独评估凭据隔离 |

## 1. 背景与目标

咕咕的工具全部是 `builtin` 内置工具（`SkillRegistry` 注册、进程启动时固定）。MCP 生态已提供大量现成工具服务（GitHub、浏览器、数据库、各类 SaaS），接入后用户可以让咕咕直接使用这些能力，无需逐个内置开发。`agent/__init__.py` 路线图已把 mcp 列为后续 Phase。

目标：

- Admin 可配置若干 MCP server，勾选启用后，server 提供的 tools 以一等工具身份进入咕咕的工具体系（声明给模型、可被 dispatch 执行、受既有权限与确认门约束）。
- MCP 工具与 builtin 工具走同一条执行契约：schema 校验、参数归一化、调用熔断、结果预算、审计日志全部复用，不为 MCP 开第二条执行路径。
- 单个 MCP server 故障（超时、崩溃、协议错误）只影响该 server 的工具，不拖垮 Agent Loop。

明确不做：

- 不接 MCP 的 resources / prompts / sampling 能力，只接 **tools**。
- 不在本 PRD 范围内做每用户凭据隔离（Phase 3 单独评估）。
- 不做 MCP server 的发布/托管（咕咕只做客户端）。
- 不改变现有 builtin 工具的注册、快照与 dispatch 语义。

## 2. 功能需求

### FR-MCP-1：server 配置管理

- Admin 可维护 MCP server 列表，每个 server 包含：名称（唯一，作命名空间）、传输类型（`http` / `sse`）、endpoint URL、可选请求头（如 `Authorization`）、启用开关、超时秒数、工具白名单（为空 = 全部工具）、确认模式（`auto` / `confirm_all`，默认 `auto`）。
- 配置存储沿用 `ai_presets` 先例：写入 `config.override.json` 的 `mcp_servers` 段，Admin API 读写，修改记录审计日志（`write_log`）。凭据类请求头不在日志、前端响应中回显明文。
- 存在全局开关 `mcp.enabled`（默认关）；关闭时所有 MCP 工具从模型可见集合摘除，配置保留。

### FR-MCP-2：工具发现与注册

- 咕咕对每个启用的 server 调用 `tools/list`，把返回的工具包装为内部 `Tool` 对象：工具名统一加命名空间前缀，格式 `mcp_<server名>_<原工具名>`，与 builtin 工具全局不重名；重名或非法名（非 `[a-zA-Z0-9_]`）跳过该工具并记录诊断。
- server 端 `inputSchema` 必须是顶层 `type=object` 的 JSON Schema；不满足则整个工具拒载并诊断。schema 中注册器不支持的构造（`$ref`、非顶层 `oneOf`/`anyOf` 等已知的 MiniMax 适配风险点）由消毒层降级处理，降级规则集中在一处并可测试。
- 数量上限：单 server 默认最多 32 个工具、全局默认最多 64 个；超出的工具不注册，记录诊断（server 名、被裁剪数量）。上限可在配置中调整，不允许无上限。
- 工具元数据默认值：`source="mcp"`、`repeat_safe=False`（外部状态不可熔断白名单）、`mutates=True`（无法证明只读，按可变更外部状态处理，定时任务不得自动重放含 MCP 调用的轮次）、`description_short` 取自 server 的 `description` 首行并截断到 100 字符。
- 工具声明（description/inputSchema）缓存在进程内；server 重连或手动重载后才刷新。同一轮对话内工具集不变，避免前缀缓存断裂。

### FR-MCP-3：工具执行

- 模型调用 `mcp_*` 工具时，dispatch 按 `source="mcp"` 路由到 MCP 管理器，转发 `tools/call`；入参先经过与 builtin 相同的 schema 校验与归一化（含 MiniMax 包装归一化），任何校验失败不发出网络请求。
- 每次调用带独立超时（server 配置，默认 30s）；超时、连接失败、协议错误一律返回结构化错误 JSON（`{"error": ...}`，文案人话化），不抛异常打断整轮。
- `confirm_mode=confirm_all` 的 server，其所有工具调用进入既有确认门（`confirm.needs_confirmation`），确认文案包含 server 名与工具名。
- 工具返回文本进入上下文前按既有工具结果预算截断；结果内容按不可信文本对待，不得触发任何隐式授权。

### FR-MCP-4：安全边界

- 远程 endpoint 属外部请求：接入既有 URL 安全校验与 egress 策略，禁止自动跟随未校验重定向。
- server 请求头凭据只存配置、只在与该 server 通信时使用；可见日志经 `logsafe` 脱敏，原始异常只进 `diag_log`。
- MCP 工具结果与描述中出现的「直接执行」「忽略之前指令」类注入文本无特权：它们不是确认门的凭证，确认凭证永不来自模型或工具文本（沿既有 LLM Token Relay 规范）。

### FR-MCP-5：生命周期

- server 连接惰性建立（首个工具声明组装或首次调用时），失败不影响其他 server 与 builtin 工具。
- 单 server 连续失败达到阈值后进入退避（如 60s 内不再外呼），期间该 server 工具返回结构化错误；退避结束自动恢复尝试。
- Admin「重载」操作清空该 server 的工具缓存并重新拉取 `tools/list`；重载失败保留旧工具列表并返回错误。

### FR-MCP-6：可观测

- capability 目录（Admin 能力清单）展示 `source=mcp` 的工具及其所属 server。
- 工具调用的耗时、成败进入既有工具调用轨迹（`_log_traj`）；用量统计沿用 `agent_usage.scenario`，MCP 调用打标 `mcp`。
- 关键事件（server 启用/禁用/重载/退避、工具拒载、超限裁剪）写可见日志（不含用户内容与凭据）。

## 3. 技术方案

### 3.1 核心决策

- **不进主 `SkillRegistry` 快照**：主快照进程级冻结（`snapshot()` 首次调用后固定），为动态来源撕开冻结语义风险大。MCP 工具由独立的 `McpToolManager` 持有，在两处汇入：`loop_drivers` 组装 `ctx.tools` 时合并声明；`dispatch` 入口按工具名前缀/`source` 路由。主 registry 的冻结、重名校验、快照语义零改动。
- **Phase 1 手写最小客户端**：MCP tools 能力只用到 `initialize` / `tools/list` / `tools/call` 三个方法，用 `httpx` 实现 JSON-RPC（streamable HTTP）约 200 行，先不引入官方 SDK，避免供应链与依赖体积；Phase 2 stdio 出现真实需求后再评估。
- **配置沿 `ai_presets` 先例**：`config.override.json` 新增 `mcp_servers` 段与 `mcp.enabled`，无 DB 迁移、无新表，回滚即删配置段。

### 3.2 文件树

```text
backend/
├── agent/
│   ├── mcp/                              【新增】MCP 客户端与管理
│   │   ├── __init__.py                   【新增】模块出口，暴露 McpToolManager 单例
│   │   ├── client.py                     【新增】最小 JSON-RPC 客户端（httpx，streamable HTTP/SSE）
│   │   ├── manager.py                    【新增】server 生命周期、工具缓存、dispatch 路由、退避
│   │   ├── schema_adapter.py             【新增】MCP schema 消毒、命名前缀、数量上限、Tool 包装
│   │   └── models.py                     【新增】McpServerConfig / McpToolMeta 数据类
│   ├── capabilities/
│   │   └── selector.py                   【修改】select 结果合并启用中的 MCP 工具名（推荐优先机制不变）
│   ├── loop_drivers.py                   【修改】ctx.tools 组装处合并 MCP 工具声明（声明顺序：builtin 后追加）
│   ├── core.py                           【修改】dispatch 入口按 source 前缀路由到 manager
│   └── tools/
│       └── base.py                       【修改】仅扩展 Tool.source 文档注释（字段已预留，无行为改动）
├── app/
│   ├── api/v1/
│   │   └── agent_admin.py                【修改】新增 /admin/agent/mcp 只读列表 + reload 端点（Phase 1 配置仍手工编辑 override）
│   └── core/
│       └── config.py                     【修改】settings 增加 mcp 段透传（enabled 总开关）
└── tests/
    ├── test_mcp_schema_adapter.py        【新增】消毒、前缀、上限、拒载
    ├── test_mcp_manager_dispatch.py      【新增】FakeMcpServer 桩：执行路由、超时、退避、确认门
    └── test_mcp_admin_api.py             【新增】列表/重载端点与审计
```

关键边界：

- `agent/tools/base.py` 的 `SkillRegistry` 快照语义、重名校验、既有 builtin 工具定义**明确不改**；MCP 工具不调用 `SkillRegistry.add()`。
- `agent/context/` 压缩、缓存对齐链路**不改**；MCP 工具声明只是 `ctx.tools` 的追加项。
- `schema_adapter` 是唯一允许做 schema 降级的地方，降级规则必须可单测，禁止散落在 manager/client。

### 3.3 数据与隐私边界

- `mcp_servers` 配置段属于 Admin 运行配置，受「用户运行配置保护」约束：Agent/测试不得擅自改写，写入走 Admin API 并审计。
- server 请求头（凭据）在 Admin API 响应中只返回掩码（如 `Bearer ***`）；诊断日志输出 endpoint 与 server 名，不输出 headers 与工具正文。
- MCP 工具结果属于工具输出，按既有工具结果规则进上下文与轨迹，不额外落可见日志。

## 4. 验证与上线

- 单测：`PYTHONPATH=. .venv/bin/pytest tests/test_mcp_schema_adapter.py tests/test_mcp_manager_dispatch.py tests/test_mcp_admin_api.py`——FakeMcpServer 进程内桩覆盖：消毒降级、前缀重名拒载、超限裁剪、执行路由、超时结构化错误、退避、confirm_all 进确认门、配置关闭后工具从 `ctx.tools` 摘除。
- devserver e2e：真连一个本地起的 echo MCP server（streamable HTTP），走网页对话完成一次「声明 → 调用 → 结构化结果 → 二轮引用」，并验证 server 停机时工具返回人话错误、主对话不受影响。
- 灰度开关：`mcp.enabled` 总开关 + per-server `enabled`；默认全关，发布即安全。
- 观测：工具轨迹与 `agent_usage.scenario=mcp` 看调用量/失败率；诊断看拒载与退避事件。
- 回滚：关闭 `mcp.enabled` 即全部摘除；无 DB 迁移，配置段可整段删除。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 第三方 schema 不合 Draft 2020-12 或含注册器不支持构造 | 工具载入失败、调用格式错乱 | 消毒层集中降级 + 拒载诊断；沿用 MiniMax 归一化层兜格式 |
| 工具数量爆炸 → 声明进前缀，上下文膨胀、跨 run 缓存键变化 | 成本与延迟上升 | 单 server/全局数量上限；同一轮内工具集冻结；白名单裁剪 |
| 工具描述/结果注入提示词攻击 | 被诱导执行非预期操作 | 结果按不可信文本 + 预算截断；confirm_all 模式；确认凭证不来自文本 |
| MCP server 不可用/超时 | 用户看到失败 | 结构化错误人话化 + 退避；单 server 故障隔离 |
| 凭据泄漏（headers 进日志/响应） | 安全事件 | 复用 logsafe/redaction；Admin 响应掩码；审计覆盖配置写操作 |
| 手写客户端与规范偏差（SSE/streamable 细节） | 兼容性坑 | Phase 1 只承诺 streamable HTTP 主流实现；真实 server e2e 验收；必要时再引入官方 SDK |

待确认：

1. 工具命名前缀 `mcp_<server>_<tool>`（本稿采用）vs 双下划线 `mcp__<server>__<tool>`（Anthropic 惯例）——影响污染兜底与展示宽度。
2. `confirm_mode` 默认值：本稿取 `auto`（不额外确认），是否首版就默认 `confirm_all` 更稳？
3. Phase 1 是否需要 Admin 可视编辑页，还是「手工编辑 override + 页面只读 + 重载按钮」即可（本稿按后者）。
4. Phase 2 stdio 是否强制容器沙盒化（rootless docker 设施现成），还是允许宿主直跑 + 白名单命令。
5. Phase 3（每用户 MCP）是否立项，若立项需与 BYOK 凭据体系统一设计。

## 6. 唯一实施 TODO

### Phase 1：远程 HTTP server 接入（最小可用）

- [ ] `MCP1-001` 实现 `mcp/client.py` 最小 JSON-RPC 客户端（initialize / tools/list / tools/call，streamable HTTP），含超时与结构化错误；验收：对 FakeMcpServer 与真实 echo server 完成 list/call 往返，超时返回 `{"error": ...}` 而非异常。
- [ ] `MCP1-002` 实现 `mcp/schema_adapter.py` 消毒与前缀、上限、Tool 包装（source=mcp、mutates=True、repeat_safe=False）；验收：`test_mcp_schema_adapter.py` 覆盖拒载/降级/裁剪/重名用例，全部通过。
- [ ] `MCP1-003` 实现 `mcp/manager.py`：配置读取（`config.override.json` 的 `mcp.enabled`/`mcp_servers`）、工具缓存、dispatch 路由、退避；验收：`test_mcp_manager_dispatch.py` 通过，server 停机时返回人话错误且不影响 builtin 工具调用。
- [ ] `MCP1-004` 接入 `loop_drivers.py` 声明合并与 `core.py` dispatch 路由、selector 合并；验收：开启配置后模型可见 `mcp_*` 工具并完成真实调用二轮对话，关闭 `mcp.enabled` 后从声明中消失且既有工具行为不变（回归：`tests/test_capability_registry.py` 除既有计数钉外全绿）。
- [ ] `MCP1-005` Admin 只读列表 + reload 端点与审计日志；验收：`test_mcp_admin_api.py` 通过，重载失败保留旧工具列表。
- [ ] `MCP1-006` devserver e2e（真实 echo server 全链路 + 故障演练）；验收：按 §4 场景在 devserver 5173 实测通过，结论记录到 devlog。

### Phase 2：stdio 本地 server 与管理体验

- [ ] `MCP1-007` stdio 传输客户端（子进程管理、空闲回收、崩溃重启上限），沙盒化方案按待确认 4 定案后实现；验收：stdio echo server 在 devserver 全链路可用，僵尸进程可回收。
- [ ] `MCP1-008` Admin 可视编辑页（server CRUD、白名单勾选、确认模式、凭据掩码回显），拆分进 Admin Agent 页组件规范；验收：配置写入走原子替换 + 审计，凭据不明文回显。
- [ ] `MCP1-009` 配置变更热重载（保存即生效，无需重启进程）；验收：改动 server 列表后不重启 backend，工具集按新配置生效。

### Phase 3：每用户 MCP（需先立项评估）

- [ ] `MCP1-010` 每用户 MCP 配置与凭据隔离方案设计（与 BYOK 体系对齐），输出独立评估结论后再进入实施；验收：评估结论包含凭据存储、加密、调度与配额边界，用户确认后才开工。
