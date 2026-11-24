# Agent 目录职责

本目录承载跨 Host 的 Agent 运行能力，职责分层沿用旧 Python `backend/agent/README.md`。公开入口为 `@gugu/core/agent`，平台端口由 Web Host 和 Desktop 装配。

## 运行与依赖方向

```text
Web / Desktop / IM / 定时触发
        ↓ 可信身份、数据读取、工具与投递端口
runtime.ts（接入所需 scenes/ 自定义规则）
        ↓ 已授权的上下文、工具与运行策略
context/ + runner.ts + core.ts
        ↓ 执行、确认、持久化与恢复
providers/ + tools/ + interactions/ + run/
        ↓ 已提交的运行结果
Host 事件与平台投递
```

入口验证本轮来源和作用域。默认 Runtime 通过共用端口组装已授权、已启用的数据与能力。场景只提供特定运行或渠道需要的上下文、权限、提示词和输出约束。通用运行层维护生命周期与安全执行门。Host 处理协议、数据库和实际投递。新场景遵循 [scenes/README.md](scenes/README.md) 的组装约定。

工具领域分组与执行规范见 [tools/README.md](tools/README.md)，Markdown Skill 注册与加载规范见 [skills/README.md](skills/README.md)。工具按领域模块集中定义，Host 使用领域组注册；Prompt Skill 独立读取 Markdown 头部注册，两者不能混为权限来源。

| 位置 | Python 职责参照 | 当前实现 |
| --- | --- | --- |
| `runtime.ts` | Runner 与 Provider Runtime 组合；持久 Chat、调度 Worker 与恢复扫描组合 | Host 注入身份关联的上下文、Provider binding、授权、持久化、取消、通知及执行端口，并显式启停。摘要和反思可复用同一 Provider 绑定。 |
| `chat-service.ts` | Chat Run 生命周期用例 | 跨端 start/resume/cancel/reconstruction 编排；事件投影、认证 owner、持久事件和 dispatch 由 Host 注入。 |
| `runner.ts` | `runner.py` | 组合可信运行准备、上下文、执行器和回复策略。 |
| `core.ts` | `core.py` / 模型循环 | Provider 轮次、工具派发、运行推进和事件提交。 |
| `models.ts`、`ports.ts` | 模型与依赖契约 | 运行状态、事件和显式注入的领域端口。 |
| `scenes/` | IM、定时、问候与反思 | 特定场景组装、数据与工具可见性、渠道策略。 |
| `capabilities/` | 工具目录与声明 | 基于已授权定义投影工具目录、Schema 和模型工具声明。 |
| `context/` | `context/` | 来源读取契约、片段编译、能力与会话快照、通用提示词格式化、预算和压缩；`compaction-runtime.ts` 管理同一 Run 的 Provider 摘要能力、惰性初始化与失败重试；Host 只注入已授权数据、模型绑定和工具 schema。 |
| `context/history/`、`context/messages/` | 历史与消息处理 | Canonical 历史、排序、图片读取适配、媒体清理与提及；附件快照编码位于 `context/snapshot-codec.ts`。 |
| `run/` | `run/` 与运行收口 | 生命周期、取消、终结、流消费、背压、可信 Run 工具绑定和加密编码。调度执行依赖 Host 队列、来源校验和租约。`reconstruct.ts` 核对检查点、授权版本和 Provider 作用域，按持久会话快照重建固定请求前缀并校验指纹，管理运行资源释放。`event-stream.ts` 从提交序号有序重放并响应 Host 唤醒。Host 持久校验交互收据后随恢复租约提供 resolution，Harness 核对 pending interaction 绑定。 |
| `interactions/` | `interactions/` | 提示与动作 schema、等待队列、动作/文本/凭据消费及恢复协调。事务、权限查询、命令副作用与一次性确认码兑换经可信 Host 端口执行。 |
| `memory/` | `memory/`、反思 | 记忆能力与反思执行。反思输入投影由对应场景定义。 |
| `subagent/` | 子任务委派 | 委派生命周期、结果与恢复，以及子 Agent 专属配置。 |
| `rag/`、`knowledge/` | 检索与知识 | 召回、索引和知识资源能力。场景决定当前运行是否接入。 |
| `providers/` | `providers/` | Provider 注册、协议、媒体与调用适配。 |
| `tools/` | `tools/` | 通用注册、参数校验、消费实时授权结果、确认和可复用工具实现。场景的白名单和渠道限制由 `scenes/` 定义。 |
| `skills/` | `skills/` | Skill 注册和加载，沿用 Markdown 头部元数据注册约定。 |
| `sessions/` | 会话应用查询 | 会话列表、刷新、待处理队列、交互查询、工具事件详情与状态标签。 |
| `config/` | 运行配置与凭据元数据 | 有效配置覆盖与 BYOK 列表；身份和真实凭据由 Host 注入。 |
| `commands/` | 指令定义 | 可供入口展示的指令菜单。 |
| `executor/` | 执行边界 | 共用沙盒能力契约；Host 提供真实执行后端。 |

标题、摘要和后台会话生命周期应按 Python `conversation/` 的职责独立实现。当前没有为尚未迁入的生命周期业务创建空目录或占位实现。`knowledge/` 等领域能力继续保留独立边界。

Web/SSE、IM 平台入口、身份、凭据、数据库连接及实际执行后端由 Host 装配。可移植的 `@gugu/core/agent` 入口加载 Run、Provider 编排与上下文规则。需要 Node、Kysely 或存储契约的 RAG、知识、记忆和持久交互用例由 Host 通过各自的 Core 子路径显式装配。摘要工具 schema 由当前 Run 的可信 Host 读取，Core 管理预算门控、初始化复用和失败重试。Chat 和定时任务共用 Core 的运行用量汇总。

Runtime 所有权明确归 Core：`createAgentRuntime`、`createAgentDispatchRuntime`、Chat 生命周期、Runner/模型循环、dispatch worker/supervisor、Run 重建、事件重放及交互恢复状态机都在本目录实现。Skill frontmatter 解析、Markdown 头部注册、单 Run 的内置/用户 Skill 组合、owner/来源复验也归 Core；Host 只提供可信租约 owner、正式用户 Skill 目录/正文读取和安全指纹端口。Web Host 的生命周期、Reconstructor 和持久 Runtime 模块只把可信身份、当前租约、Provider/工具绑定、PostgreSQL/Redis 端口及 HTTP/SSE 投影接到这些 Core 契约；生命周期状态转换、checkpoint/恢复校验、事件顺序和取消规则的变更应落在 Core。Host 保留数据库/平台专属查询、协议投影与进程启停，不复制第二份 Agent Runtime。

跨 Host 的 Agent 运行观测由 `AgentObservationPort` 作为可选通用端口从 Core Runner 和 ProviderRuntime 发出。Core 负责真实生命周期、上下文快照、Provider 实际请求 body、Provider 返回用量及工具调用事实；Host 注入诊断接收方和传输。Core 不依赖 LoopScope、HTTP、数据库或平台鉴权，观测接收失败不得改变执行、持久化或取消行为。

测试按职责位于 `tests/agent/{context,core,run,interactions}/`，反思行为仍由对应上下文行为用例保护。目录移动保持原业务断言，同步更新 suite、测试元数据及 Python 行为映射；不将重整计为新增工具迁移或平台验收。

## 草案、测试与公共入口

生产目录不放设计草案、SQL 审查材料或合同测试。相关说明与未安装的 SQL 草案放在 `docs/refactor/agent/`，正式交互 schema 放在 `interactions/`，合同测试放在 `tests/agent/interactions/` 并纳入显式 suites 清单。会话 SQL 草案测试只验证隔离临时库，不证明升级器已完成。

公开导出按领域提供：会话能力为 `@gugu/core/agent-sessions`，配置为 `@gugu/core/agent/config`；Run 编码、历史图片后端、消息处理和指令菜单由各自显式子路径提供。会话入口不转发这些其他领域实现。数据库事务借用统一使用 `@gugu/core/data` 的 `withBorrowedPostgresQuery`，不保留 Agent 专属转发或别名。
