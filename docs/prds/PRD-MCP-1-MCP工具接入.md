# PRD-MCP-1：用户自带 MCP 工具接入

> 状态：Phase 1/2 代码已完成，真实 devserver/容器 e2e 待验收；MCP 用户配置已从个人设置迁移到技能页 `/skills/mcp`；Phase 3 已完成 MCP 用量展示，连接模板与用户级配额待按需实施；平台级官方 MCP 暂缓（默认接什么未定）
> 创建：2026-09-13
> 最近更新：2026-09-16
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/capabilities/selector.py`、`backend/agent/loop_drivers.py`、`backend/agent/core.py`、`backend/app/security/`（凭据加密）、`frontend/src/views/Skills/`（技能页 MCP 子页面）
> 背景参考：MCP 规范（Model Context Protocol，tools 能力）；`agent/__init__.py` 路线图已预留 mcp Phase；凭据加密先例见 BYOK 主密钥体系（`CREDENTIALS_MASTER_KEY_FILE`）；表单交互先例见 `ProfileByokPane`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| MCP 基础接入能力（客户端、工具包装、dispatch 路由） | ✅ | 已完成并有单测 |
| 用户 MCP 配置管理（技能页 CRUD、凭据加密存储） | ✅ | 已完成；入口为 `/skills/mcp`，不再放在个人设置 |
| 用户 MCP 工具进入对话（声明、调用、确认门） | ✅ | 已完成；桩级二轮链路通过 |
| stdio 本地 server 接入（强制沙盒化） | 🟡 | 代码、协议测试、容器参数测试完成；真实 devserver 容器 e2e 待验收 |
| 咕咕自助管理 MCP 配置（`manage_mcp_servers` 工具 + ask_user 密文通道） | ✅ | 已完成；真实 IM/Web 场景待验收 |
| 平台级官方 MCP（Admin 配置、全体用户可用） | ⏸️ | 暂缓：默认接什么未定；数据模型与合并逻辑预留 `scope=platform` 扩展位，Admin 总开关与总量统计能力保留 |

## 1. 背景与目标

咕咕的工具全部是 `builtin` 内置工具（`SkillRegistry` 注册、进程启动时固定）。MCP 生态已提供大量现成工具服务，但每个用户想用的东西不同，平台统一内置既慢又不贴身。方向定稿：**MCP 采用类 BYOK 模式——用户在技能页的 MCP 子页面自己添加 MCP server，自己勾启用；平台只保留基础的 MCP 接入能力**（客户端、工具包装、执行路由、安全边界），不做 Admin 全局 server 目录，不做平台代运营的 MCP 市场。

目标：

- 用户可在技能页的 MCP 子页面维护自己的 MCP server（名称、endpoint、凭据槽位、启用开关、工具白名单、确认模式），保存后其 MCP 工具进入该用户自己的对话（Web 与 IM 均生效）。
- MCP 工具与 builtin 工具走同一条执行契约：schema 校验、参数归一化、调用熔断、结果预算、确认门全部复用，不为 MCP 开第二条执行路径。
- 用户凭据加密存储、不进日志；单个 server 故障只影响该 server，不拖垮 Agent Loop。

明确不做（本期）：

- 平台级官方 MCP 目录**暂缓**：默认接什么还没想好，本期不实现、不做 UI；但 Admin 能力保留（`mcp.enabled` 总开关、总量统计），数据模型与工具合并逻辑预留平台级来源扩展位，选型定案后可平滑补上。
- 不接 MCP 的 resources / prompts / sampling 能力，只接 **tools**。
- 不做 MCP server 托管/发布。
- 不改变现有 builtin 工具的注册、快照与 dispatch 语义。

## 2. 功能需求

### FR-MCP-1：用户配置管理

- 用户在技能页的 MCP 子页面维护自己的 MCP server 列表，每个条目包含：名称（用户内唯一，作命名空间）、传输类型（Phase 1 仅 `http`，Phase 2 增 `stdio`）、endpoint URL、可选凭据槽位（可注入 header 或 query）、启用开关、超时秒数、工具白名单（为空 = 全部）、确认模式（`auto` / `confirm_all`，默认 `confirm_all`，用户可改 `auto`）。个人设置不再提供 MCP 配置入口。
- 配置存数据库（用户维度表），凭据值使用平台凭据主密钥加密落库。**编辑视图对 owner 明文回显**（产品定稿 2026-09-17：只在传输与落库加密，前端可见可改；凭据值不出现在日志与模型上下文）。删除 server 级联清掉其工具缓存。
- 数量上限：每用户最多 10 个 server、单 server 最多 64 个工具；不设置每用户 MCP 工具总量上限。超出 server 或单 server 工具上限时拒绝保存/加载并给出人话提示。
- 配置模型带 `scope` 字段：本期只实现 `scope=user`（用户自己维护）；`scope=platform`（Admin 维护、全体用户可用）仅预留字段与合并分支，不做 UI、不写入数据。
- 保留平台总开关 `mcp.enabled`（配置项，默认开）：运维侧一键摘除全部 MCP 工具，用户配置保留；关闭时 Admin 能力页、技能页和路由统一隐藏 MCP 入口。

### FR-MCP-2：工具发现与注册

- 对用户启用的每个 server 惰性调用 `tools/list`，把工具包装为内部 `Tool` 对象：工具名统一前缀 `mcp_<server命名空间>_<原工具名>`，在**该用户范围内**不与 builtin 及其他 server 工具重名；用户可见的 server 名称支持中文、字母、数字和下划线，内部命名空间转换为 ASCII 拼音/罗马音；原工具名仍按 Provider 的 `[a-zA-Z0-9_]` 约束校验，重名或非法名跳过并记录诊断。
- server 端 `inputSchema` 必须是顶层 `type=object` 的 JSON Schema；不满足则该工具拒载并诊断。schema 中不适配的构造（`$ref`、嵌套 `oneOf`/`anyOf` 等 MiniMax 适配风险点）由消毒层集中降级，规则可单测。
 - 工具元数据默认值：`source="mcp"`、`repeat_safe=False`（外部状态不可进熔断白名单）、`mutates=True`（无法证明只读，定时任务不得自动重放含 MCP 调用的轮次）、`description_short` 取 server 描述首行截断到 100 字符。
 - 描述双轨：server 提供的**完整原始描述**仅发给 Provider（工具契约，不截断）；目录/RAG/能力摘要只消费 `description_short`，不把长描述带进检索语料。
 - 单 server 命中的工具数超过上限时**整个 server 拒绝加载**并提示配置工具白名单，不做静默裁剪；与 builtin 工具重名的声明同样跳过并诊断。
 - 工具声明缓存在进程内，键含用户与配置版本（`updated_at` 比对，可发现其他 worker 保存的新配置）；用户保存配置或 server 重连后失效。同一轮对话内工具集冻结，避免前缀缓存断裂。

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

- server 连接与工具列表按 `(user, server)` 惰性获取（首次该用户的轮次组装或调用时），失败不影响其他 server、其他用户与 builtin 工具；装载期任何异常（DB 不可用等）一律降级为空集，绝不阻断主对话。
- 单 server 连续失败达到阈值进入退避（60s 内不再外呼），期间返回结构化错误；退避结束自动恢复。用户保存配置立即清缓存重拉。
- stdio server 的子进程常驻并按空闲时长回收（默认 300s，可配）；单次调用崩溃自动重启并有次数上限；宿主零直跑，一律经 sandboxd 在容器内执行。
- server 配置变更、停用、删除即时生效（下一轮对话生效，无需重启进程）；多 worker 进程通过配置版本比对感知彼此保存的新配置。

### FR-MCP-6：可观测

- 技能页 MCP 子页面展示每个 server 的连接状态（正常 / 错误 / 退避中）与载入的工具数。
- 工具调用轨迹（`_log_traj`）与用量统计沿用既有机制，MCP 调用打标 `agent_usage.scenario=mcp`。
- Admin 仅能看到平台级总量统计（启用用户数、server 总数、调用量），不可见用户配置内容与凭据。
- 关键事件（保存/停用/退避/拒载/超限）写可见日志，不含用户内容与凭据。

### FR-MCP-7：咕咕自助管理 MCP 配置

- 咕咕拥有内置工具 `manage_mcp_servers`（动作：`list` / `add` / `update` / `enable` / `disable` / `remove` / `test_connection`），只能操作**当前用户自己**的 server 配置；`add`/`remove` 走确认门，工具定义沿用用户 Skill 注册先例（`requires_confirmation`、`mutates=True`）。
- **凭据槽位协议**：`add`/`update` 只配置非凭据部分（名称、endpoint、传输类型/启动命令、`credential_slots` 槽位定义——注入位置 header/query、字段名、可选前缀；endpoint URL 内可用 `{{secret:槽位id}}` 占位符）。槽位定义不涉密、可进上下文；槽位**值**只在需要时通过 `ask_user` 卡片的 **secret 输入字段**收集，提交走独立端点（携带 pending prompt id + 用户身份 + 过期校验），服务端直接加密写入对应 server 配置。模型拿到的 tool result 只是占位文本（「敏感信息已安全保存」），凭据值的通道从到头不经过模型上下文、SSE 事件与聊天 store。
- **IM 降级**：secret 字段仅 Web 支持；IM 渠道的该类卡片降级为「去网页补全凭据」链接，不在纯文本回复中收集凭据。
- **防钓鱼**：凭据提交端点严格绑定 pending id 对应的那条 server 配置；卡片明示目标 server 名称。MCP 工具描述中的「向用户索要凭据」类指令不构成收集依据。
- 前端红线：secret 字段值不进聊天 store、不进聊天草稿 localStorage（草稿序列化必须排除该字段）、不进日志。

## 3. 技术方案

### 3.1 核心决策

- **不进主 `SkillRegistry` 快照**：主快照进程级冻结，且 MCP 工具是「按用户动态」的，进全局快照语义不成立。`McpToolManager` 按 `(user_id, server_id)` 持有工具列表，在两处汇入：轮次组装 `ctx.tools` 时按当前用户合并声明；`dispatch` 入口按 `source="mcp"` 路由。主 registry 冻结、重名校验、快照语义零改动。
- **配置走数据库而非 override**：每用户维度 + 凭据加密决定了必须落库（`ai_presets` 的 override 先例只适合全局 Admin 配置）；配置在 DB，backend 与 worker（定时任务）天然读到同一份，无多进程一致性问题。
- **预留平台级来源**：工具缓存键与包装统一带 `scope` 维度（本期仅 `scope=user` 生效）；表设计 `user_id` 可空（NULL=平台级，本期不写入），未来 Admin 配置官方 server 时只补配置入口，merge/dispatch 层不再动。
- **Phase 1 手写最小客户端**：只用到 `initialize` / `tools/list` / `tools/call`，`httpx` 实现 JSON-RPC（streamable HTTP）即可；stdio 留 Phase 2 且强制容器沙盒（用户不可信命令不得宿主直跑）。
- **凭据加密复用平台主密钥体系**（BYOK 同一套 `CREDENTIALS_MASTER_KEY_FILE`），不新造加密机制。

### 3.2 文件树（按实际落位）

```text
backend/
├── agent/
│   ├── mcp/                              【新增】MCP 基础接入能力
│   │   ├── __init__.py                   【新增】模块出口，暴露 mcp_manager 单例
│   │   ├── client.py                     【新增】最小 JSON-RPC 客户端（httpx，streamable HTTP，IP 钉扎+禁重定向）
│   │   ├── stdio_client.py               【新增】stdio 传输客户端（经 sandboxd Unix socket，容器内运行）
│   │   ├── credentials.py                【新增】凭据槽位协议：normalize_slots / secret_fields / assemble_credentials / legacy 迁移
│   │   ├── manager.py                    【新增】(user, server) 运行时缓存、dispatch 路由、退避、stdio 空闲回收与重启上限
│   │   ├── schema_adapter.py             【新增】schema 消毒、命名前缀（server 段转拼音）、拒载规则、Tool 包装
│   │   └── models.py                     【新增】McpServerConfig / McpToolMeta 数据类
│   ├── sandbox/
│   │   └── stdio.py                      【新增】sandboxd stdio 句柄（SandboxdStdioClient/Handle/Unavailable）
│   ├── runner.py                         【修改】run 边界装载 dynamic_tools（MCP 工具），装载异常降级空集
│   ├── scheduled_execution.py            【修改】定时任务同样装载 MCP（授权工具过滤），usage scenario=mcp 打标
│   ├── capabilities/
│   │   ├── index.py / injector.py        【修改】能力目录合并 MCP 工具与计数
│   │   └── selector.py                   【修改】select 结果按当前用户合并启用中的 MCP 工具名
│   ├── loop_drivers.py                   【修改】prepare/update_tools 接受 tool_snapshot，声明合并 MCP 工具
│   ├── core.py                           【修改】dispatch 入口按 source=mcp 路由到 manager
│   └── tools/
│       ├── mcp.py                        【新增】manage_mcp_servers 工具（list/add/update/enable/disable/remove/test_connection，确认门）
│       ├── base.py                       【修改】ToolRegistrySnapshot 支持 snapshot_with_extras（run 边界合并动态工具）
│       ├── meta.py                       【修改】ask_user 增加 secret 输入字段类型（值不进上下文）
│       └── tool_contract.py              【修改】新增 unwrap_arguments_wrapper（兼容 {"arguments":{...}} 包装）
├── app/
│   ├── api/v1/
│   │   ├── mcp_settings.py               【新增】/api/v1/mcp/status 与 /mcp/servers CRUD、test_connection、reconnect、tools 列表
│   │   └── agent.py                      【修改】POST /api/v1/interactions/{prompt_id}/secrets 独立凭据提交端点（pending prompt 绑定）
│   ├── models/
│   │   └── mcp.py                        【新增】UserMcpServer ORM 模型（endpoint/凭据信封加密 + legacy 双轨字段）
│   ├── services/
│   │   ├── mcp_credentials.py            【新增】secret prompt → MCP 凭据槽位的业务消费（绑定 server 归属与过期校验）
│   │   └── secret_prompts.py             【新增】通用 secret_fields 协议校验与安全完成标记
│   └── core/
│       ├── config.py                     【修改】settings 增加 McpSettings（总开关、上限、退避、stdio 空闲/重启参数）
│       ├── pinned_http.py                【新增】IP 钉扎 httpx transport（自 web.py 上提共享）
│       └── url_security.py               【不改】resolve_pinned_ip 每跳校验
├── alembic/versions/
│   └── 20260916000001_add_user_mcp_servers.py 【生成】Alembic 迁移（downgrade 删表）
└── tests/
    ├── test_mcp_client.py                【新增】streamable HTTP 往返、SSE、会话、超时/重定向/协议错误
    ├── test_mcp_stdio.py                 【新增】sandboxd JSONL 往返、断 socket、空闲回收重连
    ├── test_mcp_credentials.py           【新增】槽位校验、装配、legacy 迁移
    ├── test_mcp_schema_adapter.py        【新增】消毒、前缀、拒载、Tool 包装
    ├── test_mcp_manager_dispatch.py      【新增】路由、超时、退避、确认门、跨用户隔离、超限拒载
    ├── test_mcp_settings_api.py          【新增】CRUD、上限拒绝、凭据掩码、URL 校验、secret 通道
    └── test_mcp_user_tools_e2e.py        【新增】用户配置→对话声明→调用→二轮引用（桩级）
frontend/src/
├── views/Skills/
│   ├── index.vue                         【修改】技能页承载 MCP 子页面（/skills/mcp）
│   ├── McpServersView.vue                【新增】MCP server 管理子页面
│   ├── SkillsHome.vue                    【新增】技能列表子页面
│   └── components/
│       ├── McpCard.vue                   【新增】MCP server 卡片（状态、工具数、重连）
│       ├── McpServerFormModal.vue        【新增】HTTP/stdio 表单与凭据槽位编辑
│       └── mcp-types.ts                  【新增】MCP 配置类型
├── components/common/gugu-chat/
│   ├── GuguChatInteraction.vue           【修改】ask_user 卡片渲染 secret 密码框并走独立提交端点
│   ├── chatTypes.ts                      【修改】interaction 协议增加 secret 字段类型
│   └── composables/useChatConversation.ts【修改】聊天草稿序列化排除 secret 字段
└── services/api.ts                       【修改】新增 mcp settings 接口封装
```

关键边界：

- `agent/tools/base.py` 的 `SkillRegistry` 快照语义、重名校验、builtin 工具定义**明确不改**；MCP 工具不调用 `SkillRegistry.add()`。
- `agent/context/` 压缩与缓存对齐链路**不改**；MCP 声明只是 `ctx.tools` 按用户的追加项。
- `schema_adapter` 是唯一做 schema 降级的地方，规则必须可单测，禁止散落在 manager/client。
- Admin 后台本期**不新增** MCP 管理页（平台级选型未定，暂缓不等于移除）；本期 Admin 能力=总开关 + 用量总量统计，平台级来源的扩展位见 3.1，选型定案后补配置入口即可。

### 3.3 数据与隐私边界

- `user_mcp_servers` 表：`user_id` 可空外键（NULL=平台级来源，本期不写入）、名称在所属 scope 内唯一、endpoint、传输类型、凭据槽位与加密凭据、`scope`、enabled、confirm_mode、超时、白名单 JSON、时间戳；历史 headers/query 密文字段仅用于迁移期读取；迁移向下兼容（downgrade 删表）。
- 凭据只以密文落库；编辑视图对 owner 明文回显供修改（仅本人鉴权可见），对话 secret 通道与日志、模型上下文不出现明文；Admin 侧只见聚合统计，不可见用户配置内容与凭据。
- MCP 工具结果按既有工具输出规则进上下文与轨迹，不额外落可见日志。

## 4. 验证与上线

- 单测：`PYTHONPATH=. .venv/bin/pytest tests/test_mcp_client.py tests/test_mcp_credentials.py tests/test_mcp_schema_adapter.py tests/test_mcp_manager_dispatch.py tests/test_mcp_settings_api.py tests/test_mcp_user_tools_e2e.py tests/test_mcp_stdio.py`——FakeMcpServer 桩覆盖：消毒降级、拒载、超限、跨用户隔离（A 配的 server B 不可见不可调）、超时结构化错误、退避、confirm_all 进确认门、`mcp.enabled=false` 全量摘除；stdio 覆盖 sandboxd JSONL 往返、断 socket、无 TTY 的固定容器边界与空闲回收后重连。
- devserver e2e：待执行。需本地起 HTTP/stdio echo MCP server，用户在技能页 MCP 子页面真实配置后走网页对话完成「声明 → 调用 → 二轮引用」，并验证停机时人话错误、主对话不受影响；迁移在 devserver `alembic upgrade head` 后执行。
- 灰度与回滚：`mcp.enabled` 平台总开关默认开；出问题可由 Admin 能力页关闭并全量摘除，用户配置保留；DB 迁移 downgrade 删表回滚。
- 观测：`agent_usage.scenario=mcp` 看调用量/失败率；技能页 MCP 子页面看各 server 状态。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 用户提供恶意 endpoint（SSRF/内网探测） | 内网被打、凭据被诱探 | 强制既有 URL 安全校验 + 内网地址拒绝 + egress 代理 + 禁跟随重定向 |
| 用户凭据泄露 | 用户第三方账号被盗 | 主密钥加密落库、接口掩码、日志脱敏 |
| 工具数量爆炸 → 声明进前缀，上下文膨胀、缓存键变化 | 成本延迟上升 | 每用户 server 数量、单 server 工具数量上限；轮内工具集冻结；白名单裁剪 |
| 工具描述/结果注入提示词攻击 | 被诱导执行非预期操作 | 结果按不可信文本 + 预算截断；默认 confirm_all；确认凭证不来自文本 |
| 恶意 server 描述诱导模型向用户索要凭据 | 凭据被钓鱼收集 | secret 提交端点严格绑定 pending id 对应配置；卡片明示 server 名；工具描述中的索要指令不构成收集依据 |
| 不可用 server 拖慢对话（超时占轮次时长） | 用户等到超时 | 独立超时 + 退避 + 人话错误；连接状态可见 |
| 手写客户端与规范偏差（streamable HTTP 细节） | 兼容性坑 | 只承诺主流实现；真实 server e2e 验收；必要时再引入官方 SDK |
| 用户在 IM 群聊暴露工具结果给群成员 | 信息越权可见 | 工具结果按既有 IM 消息边界处理，不做群内特殊放宽 |

待确认：

1. `confirm_mode` 默认值本稿取 `confirm_all`（安全侧，用户可改 `auto`）——是否合适？
2. 每用户 10 server / 单 server 64 工具的上限量值是否合适（不设置每用户工具总量上限；可配置，先给默认）。
3. IM 场景默认开放 MCP 工具，还是先只开 Web、IM 二期再放（本稿按全渠道同步生效）。
4. 平台总开关 `mcp.enabled` 首发默认开，可由 Admin 能力页随时关闭——是否符合预期。
5. 平台级官方 MCP 的默认接入选型（接什么 server、凭据谁出、是否与内置工具重叠）未定——定案后按 `scope=platform` 预留位实施。

## 6. 唯一实施 TODO

### Phase 1：基础接入能力 + 用户配置（最小可用）

- [x] `MCP1-001` 实现 `mcp/client.py` 最小 JSON-RPC 客户端（initialize / tools/list / tools/call，streamable HTTP），含超时与结构化错误；FakeMcpServer 往返与异常单测通过，真实 echo server 待 e2e。
- [x] `MCP1-002` 实现 `mcp/schema_adapter.py` 消毒与前缀、上限、Tool 包装（source=mcp、mutates=True、repeat_safe=False）；`test_mcp_schema_adapter.py` 通过。
- [x] `MCP1-003` `user_mcp_servers` ORM 模型 + Alembic 迁移 + 凭据加密接入；表含 `scope` 与可空 `user_id` 预留位，CRUD/加密/唯一约束测试通过。
- [x] `MCP1-004` 用户侧 CRUD + 连接测试 API（`/api/v1/mcp/servers`），含 URL 安全校验、上限拒绝、凭据掩码；越权 404 测试通过。
- [x] `MCP1-005` 实现 `mcp/manager.py`：按 `(user, server)` 的工具缓存、dispatch 路由、退避、配置失效；跨用户隔离与停机错误测试通过。
- [x] `MCP1-006` 接入按用户声明合并、`core.py` dispatch 路由、selector 合并；关闭 `mcp.enabled` 后从声明消失，桩级二轮链路通过。
- [x] `MCP1-007` 技能页 MCP 子页面 `/skills/mcp`：列表、HTTP/stdio 表单、连接状态、凭据掩码；已从个人设置移除 MCP 导航；i18n 静态扫描、前端类型检查通过，真实页面链路待 e2e。
- [ ] `MCP1-008` devserver e2e + 故障演练（停机、超时、删配置即时摘除）；代码与桩级测试完成，真实 5173/迁移/echo server 验收待执行。

### Phase 2：stdio 本地 server 与对话式管理

- [ ] `MCP1-009` stdio 传输客户端：已实现 sandboxd + rootless Docker、空闲回收、崩溃重启上限；协议/参数/回收单测通过，真实 devserver 沙盒 e2e 待执行。
- [x] `MCP1-010` server 连接状态细览与手动「重新连接」；技能页 MCP 子页面已可触发重连并反映最新工具列表。
- [x] `MCP1-014` `manage_mcp_servers` 工具（list/add/enable/disable/remove/test_connection，确认门，仅当前用户 scope）；已覆盖 HTTP/stdio 连接测试与安全边界，真实对话 e2e 待执行。
- [x] `MCP1-015` ask_user secret 字段类型 + 独立凭据提交端点 + 占位 tool result；Web 密文通道、IM 链接降级、聊天草稿排除 secret 已实现，凭据值不进入响应与测试断言。

### Phase 3：体验增强与平台级预留（按需）

- [ ] `MCP1-011` 常用 server 连接模板；暂未实施，需先确定首发支持的常用 server，避免把未经确认的 endpoint/命令写入产品。
- [~] `MCP1-012` 用户级调用配额与用量展示；已完成 `scenario=mcp` 打标、Admin 分类统计及平台聚合数字展示；用户级配额策略与设置项待定。
- [ ] `MCP1-013` 平台级官方 MCP（`scope=platform`）；前置条件“官方默认接什么”未定，当前仅保留数据模型/合并扩展位及总开关/聚合统计。
