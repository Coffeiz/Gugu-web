# PRD-MCP-1：用户自带 MCP 工具接入

> 状态：全部待实施（方向已定稿：用户自己配置 MCP server，平台只保留基础接入能力；未开始编码）
> 创建：2026-09-13
> 最近更新：2026-09-13
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/capabilities/selector.py`、`backend/agent/loop_drivers.py`、`backend/agent/core.py`、`backend/app/security/`（凭据加密）、`frontend/src/views/`（用户设置页）
> 背景参考：MCP 规范（Model Context Protocol，tools 能力）；`agent/__init__.py` 路线图已预留 mcp Phase；凭据加密先例见 BYOK 主密钥体系（`CREDENTIALS_MASTER_KEY_FILE`）；设置页先例见 `ProfileByokPane`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| MCP 基础接入能力（客户端、工具包装、dispatch 路由） | 🔲 | 未实施 |
| 用户 MCP 配置管理（设置页 CRUD、凭据加密存储） | 🔲 | 未实施 |
| 用户 MCP 工具进入对话（声明、调用、确认门） | 🔲 | 未实施 |
| stdio 本地 server 接入（强制沙盒化） | 🔲 | 未实施，Phase 2 |
| Admin 全局 MCP server 目录 | 🔲 | 明确不做（方向定稿：用户自带，平台不做服务端目录） |

## 1. 背景与目标

咕咕的工具全部是 `builtin` 内置工具（`SkillRegistry` 注册、进程启动时固定）。MCP 生态已提供大量现成工具服务，但每个用户想用的东西不同，平台统一内置既慢又不贴身。方向定稿：**MCP 采用类 BYOK 模式——用户在设置里自己添加 MCP server，自己勾启用；平台只保留基础的 MCP 接入能力**（客户端、工具包装、执行路由、安全边界），不做 Admin 全局 server 目录，不做平台代运营的 MCP 市场。

目标：

- 用户可在设置中维护自己的 MCP server（名称、endpoint、凭据请求头、启用开关、工具白名单、确认模式），保存后其 MCP 工具进入该用户自己的对话（Web 与 IM 均生效）。
- MCP 工具与 builtin 工具走同一条执行契约：schema 校验、参数归一化、调用熔断、结果预算、确认门全部复用，不为 MCP 开第二条执行路径。
- 用户凭据加密存储、不进日志；单个 server 故障只影响该 server，不拖垮 Agent Loop。

明确不做：

- 不做 Admin 全局 MCP server 目录/市场（平台不代配置任何 server）。
- 不接 MCP 的 resources / prompts / sampling 能力，只接 **tools**。
- 不做 MCP server 托管/发布。
- 不改变现有 builtin 工具的注册、快照与 dispatch 语义。

## 2. 功能需求

### FR-MCP-1：用户配置管理

- 用户在设置页维护自己的 MCP server 列表，每个条目包含：名称（用户内唯一，作命名空间）、传输类型（Phase 1 仅 `http`，Phase 2 增 `stdio`）、endpoint URL、可选请求头（如 `Authorization`）、启用开关、超时秒数、工具白名单（为空 = 全部）、确认模式（`auto` / `confirm_all`，默认 `confirm_all`，用户可改 `auto`）。
- 配置存数据库（用户维度表），请求头凭据使用平台凭据主密钥加密落库，任何接口不回显明文。删除 server 级联清掉其工具缓存。
- 数量上限：每用户最多 5 个 server、单 server 最多 32 个工具、每用户可见工具总量最多 64 个；超上限保存/加载被拒并给出人话提示。
- 保留平台总开关 `mcp.enabled`（配置项，默认关）：运维侧一键摘除全部 MCP 工具，用户配置保留。

### FR-MCP-2：工具发现与注册

- 对用户启用的每个 server 惰性调用 `tools/list`，把工具包装为内部 `Tool` 对象：工具名统一前缀 `mcp_<server名>_<原工具名>`，在**该用户范围内**不与 builtin 及其他 server 工具重名；重名或非法名（非 `[a-zA-Z0-9_]`）跳过并记录诊断。
- server 端 `inputSchema` 必须是顶层 `type=object` 的 JSON Schema；不满足则该工具拒载并诊断。schema 中不适配的构造（`$ref`、嵌套 `oneOf`/`anyOf` 等 MiniMax 适配风险点）由消毒层集中降级，规则可单测。
- 工具元数据默认值：`source="mcp"`、`repeat_safe=False`（外部状态不可进熔断白名单）、`mutates=True`（无法证明只读，定时任务不得自动重放含 MCP 调用的轮次）、`description_short` 取 server 描述首行截断到 100 字符。
- 工具声明缓存在进程内，键含用户与配置版本；用户保存配置或 server 重连后失效。同一轮对话内工具集冻结，避免前缀缓存断裂。

### FR-MCP-3：工具执行与对话集成

- 模型调用 `mcp_*` 工具时，dispatch 按 `source="mcp"` 路由到 MCP 管理器，转发 `tools/call`；入参先经过与 builtin 相同的 schema 校验与归一化（含 MiniMax 包装归一化），校验失败不发出网络请求。
- 每次调用带独立超时（server 配置，默认 30s）；超时、连接失败、协议错误一律返回结构化错误 JSON（人话文案），不抛异常打断整轮。
- `confirm_mode=confirm_all`（默认）的 server，其所有工具调用进入既有确认门，确认文案包含 server 名与工具名；定时任务等无人值守场景因无人确认而自然不可用，除非用户在任务里显式授权该工具（沿既有 `authorized_tools` 机制）。
- 工具对该用户全渠道生效（Web、IM）；只能访问自己配置的 server，跨用户不可见。
- 工具返回文本进入上下文前按既有工具结果预算截断。

### FR-MCP-4：安全边界

- 用户提供的 endpoint 属不可信外部请求：强制走既有 URL 安全校验与 egress 策略（含内网地址拒绝，防 SSRF），禁止自动跟随未校验重定向。
- 凭据加密落库（平台主密钥），接口掩码回显；日志经 `logsafe` 脱敏，原始异常只进 `diag_log`，凭据与工具正文不进可见日志。
- MCP 工具描述与返回内容中的注入文本（「忽略之前指令」「直接执行」）无特权：不是确认门凭证，确认凭证永不来自模型或工具文本。

### FR-MCP-5：生命周期

- server 连接与工具列表按 `(user, server)` 惰性获取（首次该用户的轮次组装或调用时），失败不影响其他 server、其他用户与 builtin 工具。
- 单 server 连续失败达到阈值进入退避（60s 内不再外呼），期间返回结构化错误；退避结束自动恢复。用户保存配置立即清缓存重拉。
- server 配置变更、停用、删除即时生效（下一轮对话生效，无需重启进程）。

### FR-MCP-6：可观测

- 用户设置页展示每个 server 的连接状态（正常 / 错误 / 退避中）与载入的工具数。
- 工具调用轨迹（`_log_traj`）与用量统计沿用既有机制，MCP 调用打标 `agent_usage.scenario=mcp`。
- Admin 仅能看到平台级总量统计（启用用户数、server 总数、调用量），不可见用户配置内容与凭据。
- 关键事件（保存/停用/退避/拒载/超限）写可见日志，不含用户内容与凭据。

## 3. 技术方案

### 3.1 核心决策

- **不进主 `SkillRegistry` 快照**：主快照进程级冻结，且 MCP 工具是「按用户动态」的，进全局快照语义不成立。`McpToolManager` 按 `(user_id, server_id)` 持有工具列表，在两处汇入：轮次组装 `ctx.tools` 时按当前用户合并声明；`dispatch` 入口按 `source="mcp"` 路由。主 registry 冻结、重名校验、快照语义零改动。
- **配置走数据库而非 override**：每用户维度 + 凭据加密决定了必须落库（`ai_presets` 的 override 先例只适合全局 Admin 配置）；配置在 DB，backend 与 worker（定时任务）天然读到同一份，无多进程一致性问题。
- **Phase 1 手写最小客户端**：只用到 `initialize` / `tools/list` / `tools/call`，`httpx` 实现 JSON-RPC（streamable HTTP）即可；stdio 留 Phase 2 且强制容器沙盒（用户不可信命令不得宿主直跑）。
- **凭据加密复用平台主密钥体系**（BYOK 同一套 `CREDENTIALS_MASTER_KEY_FILE`），不新造加密机制。

### 3.2 文件树

```text
backend/
├── agent/
│   ├── mcp/                              【新增】MCP 基础接入能力
│   │   ├── __init__.py                   【新增】模块出口，暴露 McpToolManager 单例
│   │   ├── client.py                     【新增】最小 JSON-RPC 客户端（httpx，streamable HTTP）
│   │   ├── manager.py                    【新增】(user, server) 工具缓存、dispatch 路由、退避
│   │   ├── schema_adapter.py             【新增】schema 消毒、命名前缀、数量上限、Tool 包装
│   │   └── models.py                     【新增】McpServerConfig / McpToolMeta 数据类
│   ├── capabilities/
│   │   └── selector.py                   【修改】select 结果按当前用户合并启用中的 MCP 工具名
│   ├── loop_drivers.py                   【修改】ctx.tools 组装处按用户合并 MCP 工具声明
│   └── core.py                           【修改】dispatch 入口按 source=mcp 路由到 manager
├── app/
│   ├── api/v1/
│   │   └── mcp_settings.py               【新增】用户侧 /api/v1/mcp/servers CRUD + 连接测试
│   ├── models/
│   │   └── mcp.py                        【新增】UserMcpServer ORM 模型
│   ├── security/
│   │   └── （复用既有凭据加密模块）        【不改】只新增 mcp 用途的调用方
│   └── core/
│       └── config.py                     【修改】settings 增加 mcp.enabled 总开关与数量上限默认值
├── migrations/versions/
│   └── xxxx_add_user_mcp_servers.py      【生成】Alembic 迁移，只能 alembic 生成/执行
└── tests/
    ├── test_mcp_schema_adapter.py        【新增】消毒、前缀、上限、拒载
    ├── test_mcp_manager_dispatch.py      【新增】FakeMcpServer 桩：路由、超时、退避、确认门、跨用户隔离
    ├── test_mcp_settings_api.py          【新增】CRUD、上限拒绝、凭据掩码、URL 校验
    └── test_mcp_user_tools_e2e.py        【新增】用户配置→对话声明→调用→二轮引用（桩级）
frontend/src/
├── views/Profile/ProfileMcpPane.vue      【新增】用户 MCP 设置面板（对齐 ProfileByokPane 先例）
└── services/api.ts                       【修改】新增 mcp settings 接口封装
```

关键边界：

- `agent/tools/base.py` 的 `SkillRegistry` 快照语义、重名校验、builtin 工具定义**明确不改**；MCP 工具不调用 `SkillRegistry.add()`。
- `agent/context/` 压缩与缓存对齐链路**不改**；MCP 声明只是 `ctx.tools` 按用户的追加项。
- `schema_adapter` 是唯一做 schema 降级的地方，规则必须可单测，禁止散落在 manager/client。
- Admin 后台**不新增** MCP 管理页（方向定稿）；仅有平台级总量统计可后续挂进现有用量页，不在本 PRD 范围内单独建页。

### 3.3 数据与隐私边界

- `user_mcp_servers` 表：`user_id` 外键、名称用户内唯一索引、endpoint、传输类型、加密后的 headers、enabled、confirm_mode、超时、白名单 JSON、时间戳；迁移向下兼容（downgrade 删表）。
- 凭据只以密文落库；解密只发生在向该用户的 server 发请求时；Admin 与用户列表接口一律掩码。
- MCP 工具结果按既有工具输出规则进上下文与轨迹，不额外落可见日志。

## 4. 验证与上线

- 单测：`PYTHONPATH=. .venv/bin/pytest tests/test_mcp_schema_adapter.py tests/test_mcp_manager_dispatch.py tests/test_mcp_settings_api.py tests/test_mcp_user_tools_e2e.py`——FakeMcpServer 桩覆盖：消毒降级、拒载、超限、跨用户隔离（A 配的 server B 不可见不可调）、超时结构化错误、退避、confirm_all 进确认门、`mcp.enabled=false` 全量摘除。
- devserver e2e：本地起 echo MCP server，用户在设置页真实配置后走网页对话完成「声明 → 调用 → 二轮引用」，验证停机时人话错误、主对话不受影响；迁移在 devserver `alembic upgrade head` 后执行。
- 灰度与回滚：`mcp.enabled` 平台总开关默认关，发布即安全；出问题关开关即全量摘除；DB 迁移 downgrade 删表回滚。
- 观测：`agent_usage.scenario=mcp` 看调用量/失败率；用户设置页看各 server 状态。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 用户提供恶意 endpoint（SSRF/内网探测） | 内网被打、凭据被诱探 | 强制既有 URL 安全校验 + 内网地址拒绝 + egress 代理 + 禁跟随重定向 |
| 用户凭据泄露 | 用户第三方账号被盗 | 主密钥加密落库、接口掩码、日志脱敏 |
| 工具数量爆炸 → 声明进前缀，上下文膨胀、缓存键变化 | 成本延迟上升 | 每用户 server/工具数量上限；轮内工具集冻结；白名单裁剪 |
| 工具描述/结果注入提示词攻击 | 被诱导执行非预期操作 | 结果按不可信文本 + 预算截断；默认 confirm_all；确认凭证不来自文本 |
| 不可用 server 拖慢对话（超时占轮次时长） | 用户等到超时 | 独立超时 + 退避 + 人话错误；连接状态可见 |
| 手写客户端与规范偏差（streamable HTTP 细节） | 兼容性坑 | 只承诺主流实现；真实 server e2e 验收；必要时再引入官方 SDK |
| 用户在 IM 群聊暴露工具结果给群成员 | 信息越权可见 | 工具结果按既有 IM 消息边界处理，不做群内特殊放宽 |

待确认：

1. `confirm_mode` 默认值本稿取 `confirm_all`（安全侧，用户可改 `auto`）——是否合适？
2. 每用户 5 server / 64 工具的上限量值是否合适（可配置，先给默认）。
3. IM 场景默认开放 MCP 工具，还是先只开 Web、IM 二期再放（本稿按全渠道同步生效）。
4. 平台总开关 `mcp.enabled` 首发默认关、由你择时打开——是否符合预期。

## 6. 唯一实施 TODO

### Phase 1：基础接入能力 + 用户配置（最小可用）

- [ ] `MCP1-001` 实现 `mcp/client.py` 最小 JSON-RPC 客户端（initialize / tools/list / tools/call，streamable HTTP），含超时与结构化错误；验收：对 FakeMcpServer 与真实 echo server 完成 list/call 往返，超时返回 `{"error": ...}` 而非异常。
- [ ] `MCP1-002` 实现 `mcp/schema_adapter.py` 消毒与前缀、上限、Tool 包装（source=mcp、mutates=True、repeat_safe=False）；验收：`test_mcp_schema_adapter.py` 覆盖拒载/降级/裁剪/重名用例全部通过。
- [ ] `MCP1-003` `user_mcp_servers` ORM 模型 + Alembic 迁移 + 凭据加密接入（复用平台主密钥）；验收：`alembic upgrade/downgrade` 往返通过，密文落库、用户内名称唯一索引生效。
- [ ] `MCP1-004` 用户侧 CRUD + 连接测试 API（`/api/v1/mcp/servers`），含 URL 安全校验、上限拒绝、凭据掩码；验收：`test_mcp_settings_api.py` 通过，越权访问他人 server 返回 404。
- [ ] `MCP1-005` 实现 `mcp/manager.py`：按 `(user, server)` 的工具缓存、dispatch 路由、退避、配置失效；验收：`test_mcp_manager_dispatch.py` 通过，跨用户隔离与 server 停机人话错误用例通过。
- [ ] `MCP1-006` 接入 `loop_drivers.py` 按用户声明合并、`core.py` dispatch 路由、selector 合并；验收：用户配置后模型可见 `mcp_*` 工具并完成真实调用二轮对话；关闭 `mcp.enabled` 后从声明消失，未配置用户与 builtin 行为不变。
- [ ] `MCP1-007` 设置页 `ProfileMcpPane`（对齐 BYOK 面板交互与主题契约）：列表、表单、连接状态、掩码回显；验收：devserver 5173 实测保存→对话可用→停机提示人话错误全链路，i18n 键齐、原生弹窗零使用。
- [ ] `MCP1-008` devserver e2e + 故障演练（停机、超时、删配置即时摘除）；验收：按 §4 场景实测通过，结论记录 devlog。

### Phase 2：stdio 本地 server（强制沙盒化）

- [ ] `MCP1-009` stdio 传输客户端：子进程在 rootless docker 沙盒内运行（沿 Dockerfile.sandbox 设施），宿主零直跑；含空闲回收、崩溃重启上限；验收：stdio echo server 在 devserver 沙盒内全链路可用，僵尸进程可回收，宿主文件系统不可见。
- [ ] `MCP1-010` server 连接状态细览与手动「重新连接」；验收：设置页可触发重连并反映最新工具列表。

### Phase 3：体验增强（按需）

- [ ] `MCP1-011` 常用 server 连接模板（预填 endpoint/参数结构，凭据仍用户自填）；验收：模板仅生成配置草稿，不内置任何平台凭据。
- [ ] `MCP1-012` 用户级调用配额与用量展示（scenario=mcp 已打标，补页面呈现）；验收：用量页可见 MCP 分类统计。
