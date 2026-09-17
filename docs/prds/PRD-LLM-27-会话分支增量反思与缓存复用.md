# PRD-LLM-27：会话分支增量反思与缓存复用

状态：规划中（Phase 0 架构检查已完成）  
负责人：Agent Runtime / Memory  
版本：v1  
创建：2026-09-17

## 1. 背景

当前记忆反思和 Knowledge 反思虽然已经统一使用 `ContextBranch`，但仍然是独立上下文调用：

- `agent/memory/reflection.py` 重新组装画像、行为模式、summary 和本轮对话；
- `agent/knowledge/reflection.py` 先做 Knowledge RAG，再重新组装候选和对话；
- 两者都使用自己的 system prompt，没有复用刚完成的主会话消息序列；
- Web 调度只传用户消息、助手回复和 `session_id`，没有传递主请求实际使用的 system、tools、provider 和 canonical history。

`ContextBranch` 已支持 `history_messages` 追加式调用，会话压缩已经使用该路径。当前需求是将符合条件的记忆反思和 Knowledge 反思改为同一会话的只读增量分支，在原会话消息之后追加反思任务提示词，从而复用主会话的缓存前缀。

## 2. 目标

1. 让 Web/私聊 owner 反思优先复用刚完成的主会话 provider 前缀。
2. 让 Knowledge 反思复用同一主会话前缀，而不是从独立 system prompt 冷启动。
3. 不把内部反思请求或结果写入用户可见聊天历史。
4. 不改变 Memory、Knowledge 的现有输出 schema、去重、权限、写回和 RAG 事件语义。
5. 群聊采用最小复用范围：有实际助手回复的当前群聊回合复用本轮快照；被动消息、成员反思和跨 session 批处理继续走独立上下文。
6. 用 LoopScope 和 AgentUsage 区分“可复用分支”和“独立分支”，验证实际缓存收益，而不是只依赖估算。

## 3. 非目标

- 不把反思提示词加入主会话 canonical history。
- 不让反思结果成为下一轮 Responses API 的 reasoning continuation。
- 不改变 owner 反思阈值、群组游标、Knowledge 自动/明确保存规则。
- 不保证所有 provider 都能跨调用命中缓存；缓存能力由 provider、模型和 API 格式决定。
- 不以“缓存率提升”单独宣称整体费用降低；费用必须同时按 fresh input、cache read、cache write 和 output 统计。

## 4. 现状与问题

| 模块 | 当前行为 | 问题 |
|---|---|---|
| 会话压缩 | 使用主会话消息的追加式 `history_messages` | 可作为目标实现参考 |
| owner Memory 反思 | 独立 `reflection.md` + 拼接画像/对话 | 不能复用主会话前缀 |
| Knowledge 反思 | 独立 `knowledge-reflection.md` + RAG 候选 | 不能复用主会话前缀 |
| Web 调度 | 只传用户消息、助手回复、设置和 session id | 后台任务缺少主请求快照 |
| owner 阈值缓冲 | 多轮累计后一次反思，可能跨 session | 不能无条件使用某一个 session 分支 |
| IM 群/成员反思 | 按 scope、游标和消息窗口批量反思 | 通常不存在单一主会话前缀 |
| `ContextBranch` | 带 `session_id` 时默认使 reasoning state 失效 | 追加式只读分支需要新的状态边界 |

此前统计显示，主聊天缓存率约 90%，Memory/Knowledge 反思缓存率明显偏低。反思调用本身的输入成本有较大优化空间，但由于反思输入量远小于主聊天输入量，不能把反思自身的节省直接等同于全站费用节省 50%。

## 5. 目标架构

```text
主会话 provider 请求
  ├─ 主 system prompt
  ├─ 主 tools / MCP tools
  ├─ canonical history
  ├─ 当前用户消息、工具轮次、助手回复
  └─ provider-only dynamic tail

只读分支快照（同一主前缀上先后运行的 sibling branch）
  ├─ 复用同一 provider/model/API format
  ├─ 复用主 system prompt、tools 和稳定消息前缀
  ├─ 追加 assistant 最终回复 + 临时 user 任务
  │    ├─ Memory 反思分支（Web / 私聊 / 有回复的群聊 owner 回合）
  │    └─ Knowledge 反思分支（仅当 Memory 分支产出候选；不继承 Memory 的 JSON 输出）
  └─ 分支结果不进入聊天历史，经领域 writer 写回

分支结果
  ├─ Memory writer：profile/pattern/daily/summary
  └─ Knowledge writer：create/update/conflict/ignore + RAG index event
```

反思分支是“会话语义上的 fork”，不是第二条可见会话，也不是 Responses API 的续接链。分支完成后必须丢弃临时消息，只保留经过领域校验的写回结果。

## 6. 设计方案

### 6.1 主会话快照

主请求完成时，在后台调度前捕获只读快照，至少包含：

- `system_prompt`：主请求最终使用的静态 system prompt；
- provider、模型、API 格式和相关生成参数；
- provider-ready 的 canonical conversation 消息序列；
- 主请求最终助手回复和已完成的工具轮次；
- 完整 tools 声明，包括当前请求实际使用的 MCP tools；
- `session_id`、主 `run_id`、会话 revision 和消息边界；
- 快照是否包含附件、工具结果、RAG 或其它敏感内容的安全标记。

快照只能作为进程内后台任务的短生命周期输入，不能把完整 provider 消息、工具参数、请求头或凭据写入 Redis、数据库、日志或 LoopScope 正文。若必须跨 worker 传递，应只传引用和可验证 revision，并从受权限保护的事实源重新构建。

**执行拓扑必须先钉死（Phase 1 第一项）**。现状是双路径（见 `_queue_owner_reflection` / `_drain_owner_reflection_buffer`）：

- **内联冲刷**：工具回合在主请求进程内 `rpush` 后立即 drain——同进程，可携带进程内快照；
- **worker 扫描冲刷**：idle zset 由 worker 进程扫描 drain——跨进程，进程内快照不可达，只能降级 standalone。

因此快照的传播范围按路径区分：内联冲刷路径允许把快照作为进程内参数传递（不落 Redis）；worker 扫描路径一律 standalone，不改造 Redis 队列载荷、不新增跨进程快照通道。凡「缓冲多回合合并后跨 session」「服务重启恢复」「worker 扫描」的任务都走 §6.5 的独立路径。

### 6.2 追加式分支

复用会话压缩已经验证的追加式能力，不新增 `ReflectionBranch`、`KnowledgeBranch` 或第二套 provider 调用器。实现上只允许有一个公共追加入口：

- `ContextBranch.run()` 负责统一分支生命周期、重试、结果分类和用量记录；
- `provider_runner.complete_messages()` 负责把原消息序列和末尾任务消息提交给 provider；
- 压缩现有的 `_branch_prefix_history()` 前缀准备逻辑应提炼为通用 helper，由压缩和反思共同调用；
- Memory、Knowledge 和群聊只负责准备各自的 delta、输出校验和 writer。

目标输入仍然是：

```text
stable_system = 主会话 system_prompt
history_messages = 主会话 provider-ready conversation
tools = 主请求实际使用的 tools
delta = 分支任务前缀 + 本次反思所需动态数据
```

分支任务提示词必须放在末尾追加消息中，而不是替换 system prompt。Memory 和 Knowledge 的专用规则仍由各自领域模块加载，但作为末尾任务内容发送，以保留主会话 system 前缀。

**delta 与 canonical history 的边界（前缀不断裂的硬约束）**。目标回合内容的两半位置天然不同：`user_msg` 与工具轮次已在主请求输入里（是 `history_messages` 前缀的末尾部分，不重复追加）；`assistant_reply` 是主请求输出、不在输入序列里，由分支在前缀之后追加。provider 前缀缓存按「与已缓存序列的最长公共逐字节前缀」命中——**尾部追加不影响前缀命中**，断裂只来自修改（中间插入、改写既有消息、混入每轮变化内容）。因此：

- delta（`assistant_reply` + 反思任务消息，含标记包裹的原文引用）必须在分支本地拼接为临时普通列表：`list(history_messages) + [assistant_reply, task]`，直接交给 `provider_runner.complete_messages()`；
- delta **禁止**走 `PromptMessages.append_batch()` 等 canonical 追加路径——该路径会封存 canonical batch、计算 `batch_digest` 并经 `_sync_backing()` 写回 backing，等价于把反思内容写进主会话事实源；
- delta 里引用的原文一律取 Redis 队列载荷中的组装前原文，不得从 history 消息中反抠（history 中的 user 消息可能叠有组装层 system-reminder 等每轮变化内容）；`user_msg` 既在前缀末尾，delta 允许只下指令不重贴全文；
- 该边界作为共享 helper 的契约条款固化：`_branch_prefix_history()` 提炼（见下）后的 helper 必须保证输出是脱离 canonical 簿记的普通列表，压缩与反思共用同一纪律。

实现时必须区分 `PromptMessages.conversation` 和 `dynamic_tail`：不能简单把整个 `PromptMessages` 列表摊平后重放。动态尾缀是否纳入分支，必须按照主 provider 的实际缓存边界决定；内部时间 reminder 等每轮变化内容不能无意中破坏稳定前缀。

### 6.3 Memory 反思

符合以下条件时使用会话追加分支：

- 反思来源能定位到刚完成的单一 session；
- 主请求和反思使用同一 provider、模型及 API 格式；
- 主请求快照仍在有效 revision 内；
- 当前反思输入属于该 session 的 owner/private 对话边界，或属于本轮确实产生助手回复的群聊 owner 回合。

反思 prompt 继续要求输出现有 JSON schema，但不再把主会话正文重新复制成独立输入。现有 profile、pattern、daily、summary、perception、feedback 和 Knowledge candidate 的解析与写回逻辑保持不变。

如果 owner 阈值缓冲包含多轮消息，不新增复杂的群聊批处理逻辑：

- 当前回合有主请求快照且为内联冲刷路径：直接使用本回合快照做一次追加式反思；
- 没有单一主请求快照、缓冲跨 session、或冲刷来自 worker 扫描路径：继续使用现有独立批处理反思，不强行拼接会话。

### 6.4 Knowledge 反思

Knowledge 反思仍然只有在 Memory 反思产生明确候选时触发：

1. Memory 分支返回 `knowledge_candidate`；
2. 调用 Knowledge RAG 获取候选条目；
3. Knowledge 分支复用同一主会话快照，末尾追加 Knowledge 反思任务和 RAG 候选；
4. 继续执行现有 `normalize_operations`、去重、冲突、保存和 `RagIndexUpdated` 事件。

Memory 和 Knowledge 是两个共享主前缀的 sibling branch，不把 Memory JSON 输出追加为 Knowledge 的会话历史。这样可以避免内部 schema 相互污染，并让 Knowledge 的候选变化只影响末尾动态 delta。

### 6.5 群聊与独立反思边界

群聊只做一层简单判断，不重构现有群组游标、scope 或批处理模型：

- 群主在一次正常群聊回复结束后，沿用主请求快照走与私聊相同的 Memory 追加分支；
- 群成员、群级记忆、被动群消息和没有助手回复的记录，继续走现有 scope snapshot + message batch 路径；
- 群主反思缓冲如果没有可对应的单一主请求快照，直接走独立批处理，不做跨 session 合并。

以下场景不做会话追加复用：

- 群成员或群级 scope 的反思任务；
- 被动群消息或没有助手回复的记录；
- 跨 session 的阈值批处理；
- 服务重启后从游标恢复的历史任务；
- 主快照缺失、过期、revision 不一致或 provider 已切换的任务。

这些场景继续使用现有 scope snapshot + message batch 的 `ContextBranch` 路径，不改变游标、锁、幂等和失败重试语义。群聊 owner 的追加分支只复用已有压缩分支能力，不额外建立群聊专用分支实现。

### 6.6 Reasoning state 边界

追加式只读分支不得修改主会话的 reasoning continuation state。`ContextBranch` 当前“带 session id 即失效 reasoning state”的行为需要拆分为：

- `standalone`：独立分支，允许建立状态边界并失效旧 continuation；
- `append_reuse`：只读 sibling branch，记录 usage/session 归属，但不修改主 continuation。

分支响应不能被当作主会话下一轮的 Responses API continuation。主会话后续请求仍以原 canonical history 和原 reasoning state 为准。

### 6.7 Provider 兼容与回退

**第一关是 provider/模型的前缀缓存能力，其次才是输入一致性**。追加式会把反思输入放大到整个主会话历史：对支持跨调用前缀缓存的 provider（DeepSeek、显式 cache_control 的 OpenAI/Anthropic 兼容系）这是净收益；对**不跨调用缓存**的 provider（MiniMax 实测如此），append_reuse 意味着反思按全新 input 计费整个历史，比独立反思更贵。因此：

- 维护「provider/模型/API format → 跨调用前缀缓存能力」白名单（以真实 A/B 实测为准，不凭文档推断）；
- 不在白名单内的组合一律 standalone，即使输入完全一致也不走 append_reuse；
- 白名单组合在运行中实测缓存率持续低于阈值时，自动摘出白名单并记录原因。

以下输入一致时才标记为 `cache_reuse_eligible`（仅对白名单内组合有意义）：

- provider 和模型一致；
- API 协议格式一致；
- system prompt 字节内容一致；
- tools schema 和工具顺序一致；
- history 消息角色、块结构和顺序一致；
- provider 要求的 thinking、generation、cache-control 参数一致。

不满足时不伪造缓存复用成功：记录原因并回落到独立反思调用。回落不能影响 Memory/Knowledge 的业务结果，也不能改变主会话。

## 7. 数据、并发与安全约束

- 主会话快照是只读对象，反思不能修改 `PromptMessages`、canonical history 或 session baseline。
- 反思写回仍由 Memory/Knowledge writer 负责，保留现有 CAS、cursor、锁和幂等保护。
- 主会话继续生成时，旧快照结果不能覆盖更新后的 Memory、Knowledge 或 summary；写回前必须校验 scope/session revision。
- 反思失败、快照过期或 provider 超时不得删除待处理消息，不得清空旧记忆。
- 日志只记录 branch mode、provider/model 指纹、revision、usage、cache 命中和失败原因；不得记录聊天正文、附件名、MCP 请求头或工具参数。
- RAG revision 事件只在 Knowledge 实际写入后发送，不能因为分支创建或候选忽略而发送。

## 8. 观测与验收指标

### 8.1 运行指标

新增脱敏字段：

- `branch_mode`: `append_reuse` / `standalone`；
- `cache_reuse_eligible`: 是否满足复用条件；
- `cache_reuse_reason`: 未复用原因枚举；
- `source_run_id`、`session_revision`；
- `shared_prefix_tokens_estimate`；
- provider 返回的 `tokens_in`、`cache_read`、`cache_write`、`tokens_out`。

LoopScope 必须能按 `chat`、`reflection`、`knowledge`、`compaction` 区分调用，并能关联主 run 与反思 branch，但不展示正文。

### 8.2 功能验收

- Memory 反思输出与现有 schema、字段边界和写回结果一致（含 profile、pattern、daily、summary、perception、feedback、knowledge_candidate 全部字段）；
- Knowledge 反思的 create/update/conflict/ignore、去重和索引事件行为不变；
- 反思请求和结果不出现在用户聊天历史、canonical batch 或下一轮普通上下文中；
- 同一会话并发生成时，旧分支不能覆盖新结果；
- 主会话 Responses reasoning state 不因追加反思而失效；
- provider 切换、快照过期、快照缺失和分支超时都能安全回落；
- 群组、成员、跨 session 批处理仍能按原游标完成。

### 8.3 缓存验收

- 缓存率门槛按 provider 分层，与 §6.7 白名单对齐，避免对无缓存 provider 设不可达目标：
  - **门槛组**（实测支持跨调用前缀缓存的 provider，如 DeepSeek、显式 cache_control 的 OpenAI/Anthropic 兼容系）：连续暖会话中符合条件的反思分支应稳定复用主会话前缀，目标缓存率 85% 以上，重点 provider 90% 以上；
  - **豁免组**（MiniMax 等实测不跨调用缓存的 provider）：不设缓存率门槛，只验证功能正确性与回落标记（`cache_reuse_reason` 应如实记录 provider 能力原因）；
- 门槛组至少覆盖无工具、普通工具和 MCP 工具三种消息序列；
- 门槛组至少覆盖 OpenAI 兼容协议和 Anthropic 协议；
- 缓存口径不可观测的 provider 归入豁免组，不强行设门槛；
- append_reuse 与 standalone 的同内容对照（各自 fresh input tokens）必须计入费用报告，用于验证白名单决策本身；
- 费用报告必须同时给出反思调用自身和全站总量两个口径，不能只报告缓存率百分点。

## 9. 实施计划

### Phase 0：基线与边界（已完成）

- [x] 确认 `ContextBranch.history_messages` 已存在，且当前仅压缩路径使用追加式调用。
- [x] 确认 Memory/Knowledge 反思仍是独立 system + delta 组装。
- [x] 确认 Web/IM 调度当前没有传递 provider-ready 主会话快照。
- [x] 统计主聊天、Memory、Knowledge 和 compaction 的 usage/cache 基线。
- [x] 确认 owner 单 session 与批处理/群组反思必须分流。

### Phase 1：快照与公共追加入口（已完成，2026-09-18）

- [x] 钉死反思执行拓扑：内联冲刷与 worker 扫描双路径的进程归属，确定允许携带快照的路径清单（见 §6.1）。快照只存捕获进程（`reflection_snapshot.py` 进程内登记，无 Redis/DB 依赖），worker 扫描查无快照自然回落 standalone。
- [x] 定义只读主会话快照结构和有效 revision：`ReflectionSnapshot`（user+session 键、system_prompt、ai 配置、tools、canonical history 含末尾 assistant 回复、digest revision、TTL 15min/LRU 64 条）。
- [x] 为 `ContextBranch` 增加 `append_reuse` 状态边界，避免误失效 reasoning state（`BranchInput.branch_mode`，只读分支跳过 invalidate）。
- [x] 将压缩的 `_branch_prefix_history()` 前缀准备逻辑提炼为共享 helper（`prefix_history.render_branch_prefix`），压缩已改调用；反思在 Phase 2 接入。
- [x] 建立 provider/模型前缀缓存能力白名单及运行中自动摘出机制（§6.7 第一关）：deepseek/openai/anthropic 默认准入，minimax/qwen/未知默认关闭；ReuseMissTracker 连续零命中摘出+冷却恢复。A/B 实测数据随 Phase 2 链路接入后补录。
- [x] 统一 provider-ready history、tools 和生成参数的捕获方式：`loop/machine.py` 成功收尾处捕获（ctx.tools + 消息容器 + 最终回复），不新增反思专用追加执行器。
- [x] 增加快照过期、provider 切换、dynamic tail 和敏感字段测试（`tests/test_reflection_snapshot.py` 14 条；敏感边界以「快照模块无 Redis/DB 依赖 + 日志无正文」锚定）。

### Phase 2：owner Memory 反思

- [ ] Web/私聊 owner 反思接入公共追加分支。
- [ ] 有实际助手回复的群聊 owner 回合复用同一公共追加分支；无快照的群聊任务保留独立批处理。
- [ ] 保持原 Memory writer、事件、锁、重试和失败语义。
- [ ] 完成 LoopScope 主 run/branch 关联和 provider A/B 验证。

### Phase 3：Knowledge 反思

- [ ] Knowledge 候选触发后复用同一主会话快照。
- [ ] 保持 Knowledge RAG 候选、操作校验、写入和索引事件不变。
- [ ] 验证 Memory/Knowledge sibling branch 不互相污染上下文。

### Phase 4：批处理与上线收口

- [ ] 核对群组、成员、延迟恢复和跨 session 任务的独立路径。
- [ ] 完成 provider 差异、超时、重试、并发和回落回归。
- [ ] 对比反思自身成本与全站成本，记录到 `docs/reports/OPT-Cache-Strategy-*.md`。
- [ ] 更新相关 PRD、devlog 和运行观测字段。
- [ ] **清理被追加分支替代的旧代码与提示词**（硬性要求）：owner 单 session 反思路径切换到 append_reuse 后，删除其原有的独立输入组装代码（画像/行为模式/summary/对话拼接）与对应的独立反思提示词文件，不得与新路径长期并存形成两套维护面；提示词内容若仍需复用，改为末尾任务消息引用同一份来源，不允许两份副本漂移。群成员、群级 scope 和跨 session 批处理仍使用独立路径与提示词，这部分不清理——清理边界以「只被新路径替代」为准。

## 10. 主要风险

| 风险 | 处理方式 |
|---|---|
| system/tools/参数不一致导致缓存全 miss | 捕获主请求实际 provider 参数，按条件标记 eligible，并做真实 A/B |
| 延迟反思使用了过期会话 | 保存 session revision，写回前校验；失效则独立回落 |
| 分支破坏 Responses reasoning state | `append_reuse` 与 standalone 明确分离，分支不接管主 continuation |
| 反思内容污染聊天历史 | 分支消息只读、只存在短生命周期快照，禁止进入 canonical writer |
| 群聊批处理无法映射单 session | 保持 scope batch 路径，不强行套用追加式分支 |
| 只看缓存率误判成本收益 | 同时统计 fresh/cache-read/cache-write/output 和调用量 |
| 无缓存 provider 走 append_reuse 导致反思成本反而上涨 | §6.7 白名单作为 eligible 第一关，不满足一律 standalone；运行中实测缓存率不达标自动摘出 |
| 快照携带工具结果中的敏感内容 | 不持久化完整快照，日志脱敏，按现有 provider 安全边界过滤 |

## 11. 关联文档

- [`PRD-AGENT-5-ContextBranch反思与压缩统一架构.md`](./【已完成】PRD-AGENT-5-ContextBranch反思与压缩统一架构.md)
- [`PRD-LLM-8-Prompt-Caching优化.md`](./【已完成】PRD-LLM-8-Prompt-Caching优化.md)
- [`PRD-LLM-14-Batch单一事实源与Canonical History一致性.md`](./【已完成】PRD-LLM-14-Batch单一事实源与Canonical History一致性.md)
- [`PRD-LLM-23-跨Provider推理状态持久化与续接.md`](./【已完成】PRD-LLM-23-跨Provider推理状态持久化与续接.md)
- [`PRD-LLM-25-AgentLoop核心职责拆分与模块化重构.md`](./PRD-LLM-25-AgentLoop核心职责拆分与模块化重构.md)——Phase 2 的快照捕获钩子落在 `loop/machine.py` 轮次收尾处，不得破坏 LLM-25 的模块边界
- [`PRD-KNOWLEDGE-1-统一知识系统.md`](./【已完成】PRD-KNOWLEDGE-1-统一知识系统.md)
