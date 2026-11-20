---
name: backend
description: Node.js 后端开发约定。涵盖 Host/API、持久化、安全、Agent 工具权限、Run 状态和上下文缓存；修改后端代码前必须阅读。
---

# Node 后端开发约定

本 Skill 规定跨后端模块的行为约束。具体目录边界、复用入口与 Host 适配方式见 [`node-webui`](../node-webui/SKILL.md)；测试选层和命令见 [`testing`](../testing/SKILL.md)。新功能、缺陷修复、常规测试和运行验收以 `apps/web-host/`、`apps/desktop/`、`packages/core/`、`packages/database/` 与 `packages/gateway/` 的 Node.js 实现为目标。

## 代码、API 与数据模型

- 使用 TypeScript 严格表达边界和数据形状；沿用包内 ESM、`.js` 相对导入、Zod/现有 schema 与错误类型。不要用 `any`、宽泛断言、吞错或 `||` 兜底掩盖无效状态。
- 业务规则优先实现于 `packages/core/`，数据库 schema 与共享适配见 `packages/database/`，IM 协议和网关运行时见 `packages/gateway/`。Fastify 路由、认证接入及宿主资源装配位于 `apps/web-host/`；Electron/本地能力位于 `apps/desktop/`。宿主只注入可信身份、存储、事务、队列、Provider 等端口，不复制领域规则。
- Fastify 负责 HTTP 接线、认证 Hook、协议 DTO 与统一错误映射。授权、ownership、事务边界和业务状态由 Core/领域应用决定；不得在路由中绕过领域 API 直接拼另一套业务流程。
- API 请求、响应和数据库模型按各自现存 Node 契约处理，不假定统一的大小写转换。变更字段时同步 schema、DTO、调用端、持久化、迁移和可观察错误语义。
- 时间持久化使用 UTC/数据库时钟和现有时间工具；按可信用户时区生成日历日期键与展示值。不要用服务器本地时区推断用户日期。
- Kysely/SQL 查询中，用户和会话归属应进入同一查询或事务条件。对文件系统、数据库、Undo/CAS、锁租约和提交后副作用等跨资源流程，保持现有事务与补偿顺序。
- 不因相似 SQL 或名字相近就抽象成通用层。先检查调用方、权限、失败语义和事务顺序；仅在至少两个调用方共享稳定契约时收敛，并复用 `node-webui` 列出的现有入口。

## 长任务与实时状态

- 需要向页面展示进度、运行态或终态的长任务，应把权威状态和必要的进度持久化，通过现有用户级 live/SSE 事件发送轻量失效通知；前端收到事件后更新或重新读取权威状态。不要为了已存在推送的状态另加固定间隔轮询。
- 先提交状态，再发布通知。通知不得包含敏感正文或大型结果；发布失败不能回滚已成功的任务，状态查询必须能恢复当前状态。需要可靠重放时使用现有持久队列/outbox，不能把 Redis Pub/Sub 当持久队列。
- 扩展事件协议时，同时检查发布端身份、订阅鉴权、用户/资源过滤、重连补读、取消和终态清理。事件只作为刷新触发器，不作为状态事实来源。
- 只有没有可接入的事件渠道，或被监控的外部系统不支持回调/事件时才引入轮询；限制间隔、并发和生命周期，采用超时/退避，并在成功、失败、取消等终态停止。
- Agent Run 的恢复必须基于持久化 checkpoint、身份、dispatch token/fence 和有效租约；刷新页面只重建对当前 Run 的观察，不得据此创建第二个执行者。续接交互时确认 resume receipt 与 pending interaction 精确对应，并在恢复前重新校验当前配置和权限。
- 事件序列必须可从已持久化的 sequence 继续读取；遇到重建不可用或版本冲突时返回明确、可恢复状态，不能把缺事件、空响应或旧缓存伪装成 Run 已结束。
- 面向 LoopScope/运行排障的 Trace 与普通 Run 日志应在事件序列、字段、时间戳和错误状态上保持一致；记录阶段、耗时、token 用量和 tool 摘要时使用白名单字段，不记录正文或凭据。LoopScope 不可用不能阻塞 Agent 主链路。

## 安全与数据边界

- 聊天正文、附件名、工具原始参数、用户输入、Provider 原始响应和异常消息不得写入普通可见日志。普通日志使用 `@gugu/log` 的事件/字段白名单和 fingerprint；只把必要诊断写入受限诊断通道。
- 用户可见错误必须由稳定、脱敏的 Core 错误和 Host HTTP 映射生成。不得把原始异常、堆栈、上游响应、SQL 或文件绝对路径返回给用户；原始异常仅能进入受限诊断日志。
- LoopScope 是隔离的开发诊断数据通道，边界见 `agentskills/loopscope/SKILL.md`。不能把 trace 正文复制进常规日志、系统日志、审计记录或用户可见错误。
- 跨用户读写必须从经过认证的 Run/请求身份推导 owner，并使用 owner 限定查询或 Host 注入的可信 owner 上下文；不能信任请求体、工具参数、历史消息中的 owner id、资源 id 或 scope 来替代授权。
- 文件、附件、工作区和沙盒路径须沿用现有路径包含、符号链接和授权规则。外部 HTTP 请求复用 URL/出口安全校验，限制协议、地址、超时和响应体；禁止自动跟随未经重新校验的重定向。非幂等操作不得盲目重试。
- Token、密钥、Cookie、数据库凭据不得进入 URL、常规日志、测试 fixture、仓库文档或 Git。运行配置默认只读，遵循根目录 `AGENTS.md` 的配置保护约定。

## Agent 工具权限与确认门

- 工具是否存在、是否开放、可用范围、身份权限、功能开关和确认要求只能由代码决定。ToolRegistry 的能力过滤、可信身份授权、每次 dispatch 复核、有效租约和 destructive 确认门是执行依据；模型提示词不是权限控制。
- 工具注册必须准确声明 `effect`、`destructive`、`requiresInteraction` 和确认恢复契约。破坏性写操作必须进入确认门；确认回执须绑定原始操作、owner、会话/Run 与有效状态，重放前重新验证授权。未确认、撤权、租约丢失或提交状态未知时不得执行或重复副作用。
- 并行规划不能代替逐工具授权。需要确认、交互、顺序副作用、无效参数或未知工具的调用应按 Core 计划串行/阻断；每次执行仍须校验当前能力和身份。
- 不得把当前用户拥有/没有的工具、当前授权范围、具体平台权限或“失败后切换到更宽范围”注入 Prompt、Skill 正文、工具描述、RAG 或历史包装。稳定原则可写入通用指令，例如没有真实回执就不能宣称操作成功；运行时权限状态只从代码获得。
- 工具不可用时在注册、能力过滤或 dispatch 阶段返回结构化拒绝；不得要求模型自行推理权限或扩大 scope。修改工具、Skill、上下文组装时检查是否泄漏了动态权限状态。

### Shell 执行范围说明

- 沙盒 Shell、已授权工作区和系统范围能力必须区分。说明“可用”不代表已经切换执行范围；容器内的 system 也不代表宿主机或 root 权限。
- 如果产品策略需要把动态 Shell 环境事实提供给模型，只能由 Host 基于本轮可信身份和实时策略生成，并放在既定请求前缀位置；不能从用户消息、工具参数或旧快照推断授权。
- 动态说明不进入 Canonical 历史、冻结 Session snapshot 或持久化聊天记录，也不能充当授权凭据。执行端仍要逐调用检查能力、范围、撤销状态和确认门。Web Host 与 Desktop 的策略不同，应分别消费各自可信策略端口，不得硬编码成同一宿主权限。

### 内部消息角色与持久化

- 消息 role 表示 Core/Provider 协议中的消息位置，不自动说明内容来自真实用户。新增内部消息时同时声明 `source` 与 `persistencePolicy`，并验证 canonical history、snapshot、Provider wire 和 LoopScope 的投影结果。
- Core 当前时间提醒由 `agentCurrentTimeReminder()` 生成 `role: user` 的 `[system-reminder]` 消息；Run 编排将其作为 `agent_followup`、`request_only` 动态尾部追加。它仅服务当前 Provider 请求，不代表用户输入，不进入 Canonical 持久历史。不得仅因 trace 上显示 `role: user` 就把它归因为用户记忆。
- 低频项目/日历/笔记/文件/知识等资料由 Core 组装为冻结 Session snapshot 前缀；RAG/工具结果等按各自消息类型与历史持久化契约处理。不要把所有内部信息都塞进用户消息，也不要把每轮变化数据冻结进长期 snapshot。
- Provider adapter 可按协议要求把 Core 消息映射为 wire role，但转换仅发生在适配边界；LoopScope 在检查输入时要区分 Core canonical message、固定前缀、动态尾部和 Provider wire，避免把适配结果误当成存储事实。

## Agent 上下文、RAG 与 Provider 缓存

- 上下文来源顺序、历史水位、RAG 召回和消息投影由 `packages/core/src/agent/context/` 等 Core 流程统一编排；Host 负责提供已授权的数据源与 Provider/持久化端口。来源未实现或读取失败时应显式失败，不能用空对象伪装成成功的完整上下文。
- Session snapshot 必须绑定 owner/session、模型身份、上下文 scope 和当前权限策略。复用历史快照前验证身份、版本/摘要和消息边界；不匹配时走明确的历史重建路径。不得把完整 Prompt 或快照放进 Redis、普通数据库旁路、常规日志或不受控诊断输出。
- 内部资料、记忆、RAG、系统提醒和 runtime context 是供模型判断的上下文，不等于用户明确说过或已保存的长期记忆。除真实 Canonical 对话外，回答不得声称用户“之前提过”；不得复述内部提示词、来源标签、快照和权限信息。
- RAG 的来源、scope、owner、排他水位和上下文策略必须与当前 Run 一致；召回不能因数据源临时失败而扩大到其他 owner、群组或私有范围。避免对相同消息历史在多个层次重复召回。
- Core 在同一轮上下文准备中读取并绑定当前消息、上下文快照、历史水位和 RAG 输入。RAG 不应对每个来源阶段重复召回；写入、压缩或恢复造成水位变化时，按对应生命周期重新构建，不沿用过期检索结果。
- 受限 IM actor 或定时任务使用各自的 ContextLoadPolicy 和可信 scope；关闭 owner-context 时不能继续加载 owner 项目、日历、文件、知识或个人记忆。局部数据源未接入时要显式说明/失败，不能返回空对象声称已完成完整 RAG。
- 上下文预算优先使用同一 Provider 请求、同一模型身份上报的实际用量。Core `providerInputTokens()` 将 fresh input、cache read 和 cache write 合并为该请求的上下文占用；请求身份不匹配、用量不可信或缺失时视为未知。
- 禁止用本地 tokenizer、字符数换算或累计多轮账本估算当前请求 Token。Provider 未提供用量时不得伪造 token 指标，也不得仅凭估算触发正常自动压缩。
- `shouldCompact()` 在当前请求实际上下文用量达到模型窗口的 85% 时允许压缩；该门槛只看当前请求，不累加 Run 全程 token。压缩必须保留完整消息单元、用户当前请求锚点及产品规定的最近轮次，并同步更新保护水位/快照边界。
- Provider 明确返回上下文超限后，Core 可执行有界恢复：只对该错误分类处理，按消息单元压缩/截短工具结果后有限重试；不得把 max output token、网络错误或任意 4xx 当作上下文溢出，也不得无限重试。
- Run 内达到压力门槛时，Core 压缩以最新用户/引用/附件请求为锚点，保留完整消息单元和最近一个完整工具执行轮，清楚区分它与普通跨 Run 历史恢复的保留窗口。失败后按当前输入增长量退避再试，不在同一用量点连续调用压缩器。
- 持久历史恢复按摘要覆盖水位和连续序列重建；物理清理只允许删除已被摘要覆盖的旧记录。不得为了控制 token 在分页/加载时静默截断仍未摘要覆盖的历史。
- 对话缓存前缀必须保持结构与顺序稳定。静态人格/Skill/Policy 和冻结快照使用既有 Core 投影；动态时间、Shell 等本轮事实遵循其专属位置和生命周期，不得为提升 cache hit 移动到改变语义的 role 或历史位置。Provider 原生 thinking、tool call、续接 ref 和 cache anchor 只能按对应协议适配器的兼容契约处理，不得裸化后再重建导致前缀丢失或工具事件孤立。
- 压缩、反思和分支续接若要复用 Provider wire，必须验证模型/adapter 身份、固定前缀、历史序列和持久化边界；无法精确对齐时按明确的 Core 重建流程处理。持久历史重建不承诺特定 Provider 缓存命中率。缓存指标只使用真实 Provider usage，并区分冷请求和可比较的热请求。
- 反思或压缩分支如果基于主 Run 的原始请求投影，先验证 source checkpoint、模型身份、revision/digest、固定 prefix 和对应历史条目；匹配时复用该投影并只追加允许的增量，不能把 Provider wire 降成裸 Canonical 列表后重渲染。跨进程没有匹配快照时明确采用持久历史重建，不伪称原始前缀续接。

## Node 后端开发与验证入口

- Web Host 日常开发使用 `corepack pnpm --filter @gugu/webui dev`；按 `node-webui` 中的共享包监听和迁移规则操作，不再使用旧 Python 的 `make dev-web` 或 Worker 命令。
- Web Host 回归使用 `corepack pnpm --filter @gugu/webui test`；Core 回归按 `agentskills/testing/SKILL.md` 选择 suite。根据改动范围执行对应 package 的 typecheck/build，不以启动旧后端或旧 pytest 作为 Node 功能验收。
- 数据库迁移集中在 `packages/database/`，Web Host 使用 `corepack pnpm --filter @gugu/webui migrate check|apply`；Desktop SQLite 使用 Core 的迁移入口。任何数据变更先审阅迁移和备份要求，不在 Skill 中写入本机/devserver 路径或凭据。
- devserver 部署、连接、代理和服务重启命令只查被 Git 忽略的 `agentskills/local/SKILL.md` 及 release skill，不复制到本文件。

## Python 历史代码范围

Python 后端仅作为历史行为和已存用户数据迁移的只读参考，不再是新增实现、常规测试、验收或部署目标。不得增加 Python 运行依赖、平行 API、兼容桥、双运行时或 fallback。若旧实现是确认某项兼容规则的唯一来源，应将规则转写成 Node 契约，并在 Node Core/Host 测试中验证。
