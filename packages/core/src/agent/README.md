# Agent 目录职责

本目录沿用 Python `backend/agent/README.md` 的模块职责。2.0 直接修改实现和调用方，不保留旧目录、旧包导出或兼容转发层。公开入口为 `@gugu/core/agent`。

工具领域分组与执行规范见 [tools/README.md](tools/README.md)，Markdown Skill 注册与加载规范见 [skills/README.md](skills/README.md)。工具按领域模块集中定义，Host 使用领域组注册；Prompt Skill 独立读取 Markdown 头部注册，两者不能混为权限来源。

| 位置 | Python 职责参照 | 当前实现 |
| --- | --- | --- |
| `runtime.ts` | Runner 与 Provider Runtime 组合 | 可复用 Agent Runtime 入口；Host 注入身份关联的上下文、Provider binding、授权、持久化、取消和执行端口。 |
| `runner.ts` | `runner.py` | 组合可信运行准备、上下文、执行器和回复策略。 |
| `core.ts` | `core.py` / 模型循环 | Provider 轮次、工具派发、运行推进和事件提交。 |
| `models.ts`、`ports.ts` | 模型与依赖契约 | 运行状态、事件和显式注入的领域端口。 |
| `context/` | `context/` | 上下文来源、能力快照、组装、预算和压缩。 |
| `context/history/`、`context/messages/` | 历史与消息处理 | Canonical 历史、排序、图片读取适配、媒体清理与提及；附件快照编码位于 `context/snapshot-codec.ts`。 |
| `run/` | `run/` 与运行收口 | 生命周期、取消、终结、流消费、背压及 Run 加密编码。 |
| `interactions/` | `interactions/` | 提示与动作 schema、等待队列、确认回执消费及恢复协调。 |
| `memory/` | `memory/`、反思 | 反思快照、反思输入和记忆能力。 |
| `providers/` | `providers/` | Provider 注册、协议、媒体与调用适配。 |
| `tools/` | `tools/` | 工具注册、参数校验、权限、确认和可复用工具实现。 |
| `skills/` | `skills/` | Skill 注册和加载，沿用 Markdown 头部元数据注册约定。 |
| `sessions/` | 会话应用查询 | 会话列表、刷新、待处理队列、交互查询、工具事件详情与状态标签。 |
| `config/` | 运行配置与凭据元数据 | 有效配置覆盖与 BYOK 列表；身份和真实凭据由 Host 注入。 |
| `commands/` | 指令定义 | 可供入口展示的指令菜单。 |
| `executor/` | 执行边界 | 共用沙盒能力契约；Host 提供真实执行后端。 |

标题、摘要和后台会话生命周期应按 Python `conversation/` 的职责独立实现。当前没有为尚未迁入的生命周期业务创建空目录或占位实现。`knowledge/` 等领域能力继续保留独立边界。

Web/SSE、IM 平台入口、身份、凭据、数据库连接及实际执行后端由 Host 装配。Core 不反向依赖 Host，不以目录整理为由引入平台或数据库依赖。

测试按职责位于 `tests/agent/{context,core,run,interactions}/`，反思行为仍由对应上下文行为用例保护。目录移动保持原业务断言，同步更新 suite、测试元数据及 Python 行为映射；不将重整计为新增工具迁移或平台验收。

## 草案、测试与公共入口

生产目录不放设计草案、SQL 审查材料或合同测试。相关说明与未安装的 SQL 草案放在 `docs/refactor/agent/`，正式交互 schema 放在 `interactions/`，合同测试放在 `tests/agent/interactions/` 并纳入显式 suites 清单。会话 SQL 草案测试只验证隔离临时库，不证明升级器已完成。

公开导出按领域提供：会话能力为 `@gugu/core/agent-sessions`，配置为 `@gugu/core/agent/config`；Run 编码、历史图片后端、消息处理和指令菜单由各自显式子路径提供。会话入口不转发这些其他领域实现。数据库事务借用统一使用 `@gugu/core/data` 的 `withBorrowedPostgresQuery`，不保留 Agent 专属转发或别名。
