# PRD-LLM-32：供应商敏感内容拦截与会话恢复

> 状态：方案已确认，待实施
> 创建：2026-10-02
> 最近更新：2026-10-02
> 关联模块：`backend/agent/providers/`、`backend/agent/errors.py`、`backend/agent/run/`、`backend/agent/context/`、`backend/app/models/`、`backend/app/api/v1/agent.py`、`frontend/src/components/common/gugu-chat/`
> 背景参考：`docs/prds/PRD-LLM-29-统一Canonical消息区域与持久化增量.md`、MiniMax Speech-to-Text 错误码文档、MiniMax 文本模型错误码文档

## 0. 代码调查结论

| 项目 | 当前实现 | 对本需求的影响 |
|---|---|---|
| 用户消息保存 | Web 和新 Run 路径均在模型调用前保存用户消息 | Provider 拒绝后原消息仍会在后续历史中出现，这是上下文污染的直接入口 |
| Run 身份 | `ConversationMessage` 已有 `run_id` / `round_id`；常规收尾时才给用户消息补 `run_id` | 失败 Run 可能没有完整、持久的消息归属，需在 Run 开始时建立身份 |
| Canonical 历史 | `MessageArea` 与持久化增量已成为当前架构边界 | 污染排除应作用于 canonical history，再生成 Provider 投影；不能只改 UI 或临时 wire list |
| 历史压缩 | 旧消息仍保留；当前摘要通过 `covers_until_id` 和 session baseline 覆盖旧历史 | 过滤单条消息不够；摘要可能已包含污染轮次，恢复必须回退水位并重建摘要 |
| Provider 推理状态 | 已有统一失效机制，支持 `provider_rejected`、`baseline_changed` 等原因 | 恢复历史时应一并失效跨请求续接状态 |
| 会话 UI | 支持新建会话、加载消息、工具与 assistant 时间线；无现成的单消息撤回或干净历史恢复接口 | 需要新的恢复 API、会话状态和对应操作界面 |
| MiniMax 错误分类 | `minimax.py` 解析供应商错误码；1026/1027 已区分输入/输出敏感检查 | 可扩展为结构化安全分类；不能仅按通用 HTTP 状态判定 |

### 0.1 核心判定边界

MiniMax Speech-to-Text 文档中 HTTP 422 表示音频敏感内容拦截；这不能推导出 MiniMax 文本模型的所有 HTTP 422 都是敏感内容。代码必须结合 Provider、接口/端点和结构化错误码或 `error.type` 分类。未知 4xx、参数错误和普通服务故障不得自动标记为污染 Run。

### 0.2 产品语义

- **污染 Run**：供应商明确判定当前请求的输入、输出或媒体内容触发内容安全拦截的 Run。该标签只存安全分类、供应商和允许记录的错误码等元数据，不复制原始响应正文。
- **撤回本轮**：从当前会话后续模型上下文中排除污染 Run 及其依赖的后续 Run；不等同于物理删除用户消息、附件或工具产生的外部副作用。
- **干净边界**：最早污染 Run 开始前最后一个完整、可恢复的会话历史位置。
- **恢复历史**：把当前会话的有效上下文回退到干净边界并继续使用同一会话；污染后的历史在界面保留并标注为已撤回，不再投影给模型。

## 1. 背景与目标

### 1.1 背景

部分 Provider 会因输入、输出或媒体内容返回明确的内容安全错误。失败的 Run 本身可能没有助手回复，但触发错误的用户消息已提前保存。后续请求继续读取该消息时，Provider 可能再次拒绝，导致用户感觉整个会话都无法继续。

仅把错误作为普通 toast 展示无法恢复上下文；直接删除整段会话又会丢失此前有效历史。历史摘要、工具往返和 Provider 推理续接状态也可能跨越失败边界，因此恢复必须以 Run 为单位，并覆盖持久化与上下文组装两侧。

### 1.2 目标

1. 只对 Provider 明确标记的敏感内容错误建立结构化分类，区分输入、输出和媒体拦截。
2. 让失败 Run 可持久定位，并在会话中显示清楚的供应商拦截提示。
3. 提供“撤回本轮，从污染前历史继续”和“新建会话”两种恢复路径。
4. 恢复时排除最早污染 Run 及其后的依赖历史，处理摘要 baseline、缓存锚点和 Provider 推理状态。
5. 保留原会话记录和用户可见证据；禁止把上游原始错误正文、用户正文或敏感附件内容写入安全诊断元数据。
6. 对 Web、IM 和其他复用统一 Run 生命周期的入口采用同一分类、落库和恢复契约。

### 1.3 非目标

- 不自行审查、重写或推断用户文本是否违规；分类事实来自 Provider 明确错误契约。
- 不因普通网络错误、限流、无效参数、余额不足或未知 422 自动污染会话。
- 不自动改写敏感输入后重试，也不自动重复调用已被内容安全拒绝的请求。
- 不物理删除原会话消息、附件或文件；真正的数据删除仍走独立删除流程。
- 不回滚已执行的文件、消息发送、数据库修改或其他工具副作用。
- 不改变会话历史压缩的一般触发阈值和策略。

## 2. 用户流程

### 2.1 Provider 拦截

1. 用户发送消息，系统照常创建用户消息和附件关联，并为本次执行创建稳定 `run_id`。
2. Provider 返回已知的内容安全错误后，错误分类器生成结构化 `safety_classification`；Run 以 `provider_blocked` 终态落库。
3. 前端在该轮显示供应商拦截提示，告知本轮未能继续，并提供：
   - **撤回本轮，从之前历史继续**：需要统一确认弹窗；确认后恢复同一会话到干净边界。
   - **新建会话**：创建空白会话，不携带被拦截消息及原会话历史。
4. 用户可关闭提示稍后处理；该会话保持“需要恢复”的状态，不能默默将污染历史当作正常上下文继续发送。

### 2.2 恢复到干净历史

1. 定位当前会话最早的 `provider_blocked` Run。
2. 将该 Run 及其后的 Run 标为从当前上下文分支撤回；后续 Run 视为依赖污染上下文，即使其本身曾成功完成。
3. 保留这些消息和时间线用于查看，在消息/Run 元数据上标明“已从上下文撤回”。
4. 删除当前压缩摘要或重建到干净边界；重置 session baseline/hash 和对应快照中的历史水位。
5. 失效 Provider reasoning state、缓存锚点和任何绑定旧 baseline 的续接数据。
6. 后续新消息从干净边界继续进入同一会话；用户此前发送的污染内容不再进入模型请求。

### 2.3 重复污染与历史会话

- 一个会话可存在多个被标记 Run；恢复总是从最早污染 Run 之前的干净边界开始，统一撤回其后的依赖后缀。
- 会话状态持续展示恢复入口，避免用户错过首次错误卡后无法恢复。
- 对部署此功能之前产生的历史消息，不根据文本、错误文案或相似度推测污染状态；仅处理有可信 Run 标记的记录。

## 3. 功能需求

### FR-LLM32-01：供应商安全错误分类

Provider adapter 返回与普通错误分离的结构化安全标签：

| 字段 | 说明 |
|---|---|
| `category` | `sensitive_input`、`sensitive_output`、`sensitive_media` |
| `provider` | 受控 Provider 标识，例如 `minimax` |
| `provider_code` | 规范化后的供应商错误码；未知时为空 |
| `endpoint_kind` | `chat`、`responses`、`anthropic_messages`、`speech_to_text` 等受控枚举 |
| `diagnostic_id` | 可选的本地诊断编号，不包含正文 |

分类规则：

- MiniMax 文本输入/输出拦截分别以已确认的 1026/1027 错误码分类。
- MiniMax HTTP 422 只在经验证的 Speech-to-Text 端点契约中分类为 `sensitive_media`；其他端点仅凭状态码不得分类。
- Provider 未返回明确且可信的安全标签时，继续走普通 Provider 错误，不显示“敏感内容”结论，也不污染 Run。
- `errors.py` 负责跨 Provider 的稳定错误展示契约；供应商码和端点知识留在对应 Provider adapter，不建立供应商专属码到通用层的硬编码表。
- 错误响应正文只用于进程内解析；可见错误和日志遵守脱敏约束。

### FR-LLM32-02：稳定 Run 身份与状态

每个有用户输入的会话 Run 在第一次模型调用前获得稳定 ID，并原子关联触发消息。Web、IM、定时任务和续接入口不得在网关、Runner、Provider 之间各自生成互不相同的持久 Run 身份。

Run 至少具有以下终态之一：

- `completed`
- `cancelled`
- `failed`
- `provider_blocked`
- `withdrawn_from_context`

建议以独立 `ConversationRun` 记录承载状态，而不是把供应商错误结构塞进消息正文。记录至少包括：`session_id`、稳定 `run_id`、`trigger_message_id`、状态、安全分类、Provider、受控错误码、开始/结束时间、`depends_on` 或可计算的会话顺序边界。运行记录不得保存用户正文、附件内容或原始 Provider body。

所有本 Run 的 canonical messages、工具结果、展示 timeline 和用户消息都可通过稳定 Run ID 归属。旧消息缺少 Run ID 时保持兼容，不自动猜测补标。

### FR-LLM32-03：Run 错误终态一致性

- 用户取消时，维持现有“保存已完成轮次和已生成部分回复”的语义。
- Provider 内容安全拒绝和其他生成错误不得把错误文案、不完整 assistant 回复或未完成工具调用写成成功历史。
- 已提前保存的 user message 仍与 Run 关联；只有明确恢复操作后才从有效上下文分支排除。
- Web 与新 Run/IM 入口调用同一个 Run 状态收尾契约，区分取消、普通错误和 Provider 内容安全拒绝。
- 被拒绝请求不自动重试；错误事件仍返回统一可国际化文案和安全分类字段。

### FR-LLM32-04：会话污染状态和发送守卫

- Session API 返回是否存在尚未恢复的污染 Run、最早污染 Run 标识和可用恢复动作；不返回敏感正文或供应商原始响应。
- 会话存在未恢复污染时，前端显示持久状态提示。
- 默认阻止继续向该污染上下文追加普通消息，提示用户先恢复干净历史或新建会话；避免再次发送已知会被拒绝的上下文。
- 若业务决定允许用户显式继续污染分支，必须作为单独的产品决策和显式确认，不允许静默放行。

### FR-LLM32-05：从干净边界恢复同一会话

恢复动作以最早污染 Run 为起点，撤回其后的完整消息后缀，不在工具调用/结果中间截断。后缀中的用户消息、assistant 轮次、工具 canonical messages、结果、文件卡片和 timeline 都必须使用同一上下文状态。

恢复事务必须：

1. 验证 session 归属，并确认没有活跃 Run、排队 Run 或 baseline 压缩任务；否则返回冲突错误，不做部分更新。
2. 锁定 Session 并计算干净边界，使用 compare-and-swap 或等价并发检查，避免与压缩、消息追加或另一恢复动作竞态。
3. 将污染 Run 及后续依赖 Run 标为 `withdrawn_from_context`，不物理删除原始消息。
4. 删除或重建包含污染内容的当前 summary；重置 baseline watermark/hash 与 snapshot history watermark，使下次历史读取从干净前缀重建。
5. 在同一恢复提交中使 Provider reasoning state 失效，并清理 session context 中旧 `provider_cache_anchor` 等基于旧历史的状态。
6. 返回恢复前后边界、撤回 Run 数和受影响消息数；不回显具体内容。
7. 对重复请求幂等；失败时保持原会话状态完整。

### FR-LLM32-06：新建空白会话

- 错误卡和会话污染提示提供“新建会话”。
- 新会话不继承污染会话的消息、summary、RAG 历史、provider continuation state 或缓存锚点。
- 工作区、模型选择等是否继承沿用现有新建会话产品语义；不得因为恢复功能额外复制敏感上下文。

### FR-LLM32-07：可见状态与国际化

- Provider 明确标记后显示“此消息被 {provider} 判定为敏感内容，本轮未继续生成”，按语言环境提供 zh-CN、ja-JP、en-US 文案。
- 允许展示已知错误码或诊断编号，禁止展示上游原始错误 body。
- 已撤回后缀的气泡保留并添加“已从模型上下文撤回”状态；工具卡不显示为当前 Run 正在执行。
- 恢复是影响当前会话上下文的操作，使用统一 `ConfirmDialog`，明确告知会排除最早污染轮次及其后的历史，但不会撤销工具副作用。
- 支持取消确认；取消后会话污染状态不变。

## 4. 数据与上下文设计

### 4.1 Run 状态记录

建议新增 `conversation_runs` 表作为 Run 身份和终态事实源，而非只扩展 UI timeline：

| 字段 | 约束/用途 |
|---|---|
| `id` | 主键 |
| `session_id` | 会话外键及查询索引 |
| `run_id` | 稳定 ID；同一会话唯一 |
| `trigger_message_id` | 触发该 Run 的用户消息；允许系统型 Run 为空 |
| `status` | Run 生命周期终态 |
| `safety_category` | 可空；仅受控分类枚举 |
| `provider` / `provider_code` / `endpoint_kind` | 可空、脱敏的供应商诊断字段 |
| `context_state` | `included` / `withdrawn` |
| `started_at` / `finished_at` | 排序及僵尸 Run 恢复 |
| `sequence` 或 `depends_on_run_id` | 稳定表示会话 Run 顺序与依赖；不能仅按时间戳猜测边界 |

约束：

- 每个 session 内 `run_id` 唯一；状态转换只允许从 active 到一个终态，恢复操作允许 `included → withdrawn`。
- 运行记录与用户消息在开始事务中关联；provider 错误事件到达后原子更新终态和安全元数据。
- 对迁移前数据允许无 Run 记录；对其行为保持原样。

### 4.2 历史投影

- 数据库保留完整展示记录；canonical history loader 只恢复 `context_state=included` 的消息/Run。
- 恢复会排除 earliest blocked run 之后的依赖后缀，而非从 canonical 消息列表中孤立删除一条 user row。
- 历史消息顺序、tool call/result 原子配对和 batch digest 必须在排除完整 Run 后仍有效。
- 污染发生在当前 baseline 覆盖范围内时，先撤销基于旧 summary 的 baseline，再从保留的原始消息构造干净 history。旧消息虽保留，但 summary 不可继续代表污染范围。
- 正常压缩在恢复后的 clean history 上重新执行；不得复用包含被撤回 Run 的摘要。

### 4.3 附件与副作用

- 附件在 UI 中可继续查看；被撤回 Run 的附件不得再次作为模型输入。
- 本 PRD 不删除附件字节；如果用户要求永久删除附件内容，需要另外走附件删除与存储引用计数规则。
- 已执行成功的工具副作用不会由上下文撤回操作逆转。恢复确认文案必须表达这一点；可能产生业务影响的工具输出仍可在原记录中查看。

## 5. 接口建议

### 5.1 会话消息响应扩展

消息或 timeline API 为每条记录返回 Run 状态摘要：

```json
{
  "runId": "...",
  "runStatus": "provider_blocked",
  "safetyCategory": "sensitive_input",
  "contextState": "included"
}
```

Session 摘要增加：

```json
{
  "contextRecovery": {
    "required": true,
    "earliestBlockedRunId": "...",
    "excludedRunCount": 0
  }
}
```

字段为受控元数据，不返回敏感错误正文。

### 5.2 恢复接口

建议新增显式端点：

```http
POST /api/v1/agent/sessions/{session_id}/recover-context
```

请求体：

```json
{
  "strategy": "rewind_before_earliest_blocked_run",
  "expected_context_revision": 12
}
```

成功响应至少包含 `session_id`、恢复前后 context revision、`rewound_before_run_id`、撤回 Run 数和受影响消息数。请求重复提交应幂等；revision 不匹配或存在活跃 Run 时返回可读冲突，不做半完成更新。

“新建会话”继续调用既有会话创建流程，不把原 session ID 或 provider 状态复制进新会话。

## 6. 建议实施阶段

### Phase 0：错误分类契约

- 审核每个目标 Provider 的文本、Responses、Anthropic-compatible、语音端点错误码来源。
- MiniMax 的 1026/1027 与 Speech-to-Text 422 分开验证；修正状态码通用映射造成的误报风险。
- 定义 Provider adapter → `LLMErrorPresentation` → SSE/IM/UI 的类型和分类映射。
- 验收：未知 422、参数 422、限流和网络错误都不会被识别成敏感内容。

### Phase 1：Run 身份与终态持久化

- 增加稳定 Run ID 生命周期和 `ConversationRun` 持久记录。
- Web、新 Run、IM/后台执行的开始、正常完成、取消、普通失败、Provider 拦截共用状态迁移入口。
- 将触发用户消息和 Run 在调用模型前关联；补齐错误路径 ID。
- 验收：每条消息/工具事件可归属；同一错误在 Web/IM 展示一致；错误文案不进入 canonical history。

### Phase 2：污染后缀恢复

- 加入 session context recovery 状态、owner-checked 恢复 API 和并发版本检查。
- Loader/Canonical projection 按 `context_state` 过滤整个撤回后缀。
- 恢复 summary baseline、session snapshot、provider continuation state 和 cache anchor。
- 验收：未压缩、已压缩、summary 覆盖污染 Run、活动工具往返、重复恢复和并发恢复均能保持干净边界与幂等。

### Phase 3：聊天 UI

- 错误卡片与会话级恢复提示、确认弹窗、已撤回标记和新建会话按钮。
- 完成 zh-CN/ja-JP/en-US 文案和键盘/取消路径。
- 验收：刷新、分页、切换会话、增量事件后污染和撤回状态一致。

### Phase 4：渐进启用

- 先启用有明确 Provider 码且覆盖充分的 MiniMax 分类；其他供应商仍按普通错误处理。
- 观察误标率、恢复冲突、provider continuation invalidation 和摘要重建指标。
- 根据供应商官方错误契约逐家扩大 allowlist；没有可信错误结构的供应商不启用自动污染判定。

## 7. 测试与验收矩阵

| 场景 | 预期 |
|---|---|
| MiniMax 文本输入敏感错误 1026 | Run 标记 `provider_blocked/sensitive_input`，显示错误卡，不自动重试 |
| MiniMax 文本输出敏感错误 1027 | Run 标记 `provider_blocked/sensitive_output`，错误正文和不完整输出不入 canonical history |
| MiniMax Speech-to-Text 422 | 仅在语音端点识别为 `sensitive_media` |
| MiniMax 文本 Chat 422，无安全错误码/type | 普通 Provider 请求错误，不污染 Run |
| 其他供应商未知 422 | 普通 Provider 错误，不污染 Run |
| 网络、429、余额不足、无效参数 | 不污染 Run，既有错误反馈保持有效 |
| provider error 前已有已完成 tool round | 未完成往返不落库；已提交副作用不撤销，并在恢复提示中说明 |
| 首轮敏感错误后恢复 | 用户消息和错误卡仍可查看；下轮模型请求不包含此 Run |
| 多个敏感 Run | 恢复从最早污染 Run 前开始，污染 Run 及其后依赖后缀全部撤回 |
| summary 已覆盖最早污染 Run | 恢复不再发送旧 summary；从安全边界重建并重置 baseline/hash |
| Provider continuation 已存在 | 恢复后状态失效，不再续接旧 Response/推理状态 |
| 已撤回消息仍有附件 | UI 保留记录，模型 projection 不含附件内容或媒体块 |
| 会话归属错误 | 返回 404/拒绝恢复，不泄露其它用户会话存在性 |
| 活跃 Run、队列或 compaction 竞态 | 返回冲突或等待明确终态；不可部分回退 |
| 恢复请求重放 | 幂等，不重复标记、不重复重置摘要 |
| 日志/i18n/SSE | 不包含原始用户正文、附件名、上游 body 或凭据；三种语言均有明确恢复提示 |

## 8. 风险与决策

| 风险/问题 | 对策或建议 |
|---|---|
| 只标单条消息，摘要仍携带原内容 | 从 earliest blocked Run 建立完整后缀边界，废弃旧 summary 并重建 baseline |
| 失败 Run 没稳定 ID | 在模型调用前分配统一 Run ID，并与 user message 原子关联 |
| Provider 状态码误判 | 分类要求 Provider+endpoint+明确码/type；禁止全局按 422 匹配 |
| 工具副作用仍存在 | “撤回上下文”不承诺业务回滚，确认文案说明已执行副作用不撤销 |
| 回退期间存在并发压缩/发送 | 锁 session、检查 context revision 与执行状态，失败不部分提交 |
| 敏感正文继续存储在历史 DB | 本能力只阻止后续模型上下文使用；如产品要求物理清除，另立数据删除需求 |
| 复制会话会复制附件、引用和消息关系 | 首选同 session 软撤回后缀，避免分叉复制语义；新建会话保持空白 |

### 已确认决策

1. **恢复在同一 session 内完成**：污染 Run 及其后缀从模型上下文撤回；原消息保留并在界面标记，不物理删除。
2. **污染标记后阻止继续发送**：用户必须先恢复干净历史或新建会话，避免把已知污染上下文再次发给 Provider。
3. **不提供永久删除污染正文/附件**：本 PRD 只处理上下文隔离；物理删除需单独评审附件引用计数、审计与存储清理。
4. **保留受影响的工具事件展示**：工具调用和结果仍可查看，并标记“已撤回上下文”；明确这不会回滚已经执行的副作用。

## 9. TODO

- [x] LLM32-001 状态：方案已确认。同一会话后缀撤回，消息保留但退出模型上下文。
- [ ] LLM32-002 状态：待实施。冻结 Provider/endpoint 安全错误分类 allowlist，纠正 MiniMax 通用 422 误分类边界。
- [ ] LLM32-003 状态：待实施。新增稳定 Run 身份和终态事实源，贯通 Web、IM 与后台入口。
- [ ] LLM32-004 状态：待实施。实现最早污染边界恢复、summary/baseline 重建和 Provider 状态失效。
- [ ] LLM32-005 状态：待实施。实现会话恢复提示、确认交互、撤回状态展示和 i18n。
- [ ] LLM32-006 状态：待实施。覆盖错误分类、压缩竞态、工具往返、附件隔离和跨入口一致性验收。
