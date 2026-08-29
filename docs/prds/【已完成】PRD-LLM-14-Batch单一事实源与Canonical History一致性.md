# PRD-LLM-14：Batch 单一事实源与 Canonical History 一致性

## 文档状态

- 状态：实施中（Phase 0-4 已完成，Phase 5 回归与清理待收口）
- 类型：上下文架构重构
- 范围：Agent Loop、Canonical Context、Provider Adapter、运行记录与工具时间线
- 不包含：Provider API 能力新增、数据库业务字段新增、UI 视觉改版

### 当前实现审查（2026-08-28）

当前代码已经具备 `NewMessageBatch`、canonical/provider 双投影、提交冻结、batch digest、
`PromptMessages.append_batch()` 和 canonical batch 持久化能力；Phase 3-4 已接入 ORM、统一收尾、
工具回放身份和 LoopScope 诊断。剩余工作主要是跨渠道、并发和完整 UI 回归，以及确认无效兼容代码可安全删除。

已确认未完成的关键项：

- `run_finalize()` 仍保留旧调用方未传 batch 时的兼容读取分支；新 Web/IM runner 已传入 canonical batch，生产主链不再走该分支；
- `conversation_batches` 已接入 ORM、batch 创建、`canonical_batch_id` 关联和工具回放读取；旧消息仍按原 content/content_json 兼容；
- Agent 核心工具轮已先生成 canonical batch，再附带 Provider round 作为一次性投影；
- `PromptMessages` 与 Provider role/event 投影会复制 batch digest/metadata，收尾可跨 provider 读取同一批次身份；
- UI 仍允许 `display_timeline` 优先展示实时时间线，持久化工具事件来自 canonical history，并带 `canonicalBatchId` 供同源诊断；
- LoopScope 已记录 canonical batch digest、round id、事件统计和 adapter 调用统计；完整并发与跨渠道验收仍属于 Phase 5。

当前阶段判定：

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：现状盘点 | ✅ 已完成 | 已完成主要 Batch 创建点、Provider 反向转换路径和既有上下文回归边界盘点；持久化基线延续到 Phase 3 |
| Phase 1：Canonical Batch 契约 | ✅ 已完成 | 已有 canonical 类型校验、seal、digest 和提交后外层不可变边界；完整持久化不变量延续到 Phase 3 |
| Phase 2：Provider 投影隔离 | ✅ 已完成 | 核心工具轮已 canonical-first，Provider 只生成独立 wire 投影；旧 Provider 入口仅保留兼容读取和测试用途 |
| Phase 3：持久化收口 | ✅ 已完成 | ORM、batch digest、finalize 直接写入、`canonical_batch_id` 关联和旧数据 reload 已接入 |
| Phase 4：展示与诊断统一 | ✅ 已完成 | 持久化工具回放带 batch 身份，LoopScope 记录 batch digest/round/event/adapter 诊断，实时 timeline 保持同源事件 |
| Phase 5：回归与清理 | 🟡 实现完成，待依赖环境验收 | 主链回归保护、幂等去重、兼容边界和静态检查已完成；完整 pytest/跨渠道验收需在 backend 虚拟环境执行 |

## 1. 背景与问题

当前一轮工具结果先由 Provider Driver 组装为 Anthropic/OpenAI wire message，再追加到运行时消息列表；run 收尾时又通过 `canonicalize_tool_messages()` 将其转换为 provider-neutral history 后写入数据库。

同一批内容因此存在两次组装和两种结构：

1. 运行中的消息是 Provider 格式；
2. 持久化 history 是重新推导的 Canonical 格式；
3. 下一轮读取 history 时再次经过 Provider Adapter 重建；
4. schema、RAG、时间、姿态、tool call/result 和 follow-up 可能在不同阶段被合并、拆分或移动。

这会造成：

- batch 进入 history 后边界变化；
- tool call 与 tool result 的相对位置不稳定；
- event 被并入相邻 user 消息；
- 本轮请求与下一轮重建请求的前缀不一致；
- cache 断点出现在包装层，而不是实际内容变化处；
- UI 工具气泡、provider history 和数据库 history 各自出现不同顺序。

## 2. 目标

### 2.1 核心目标

建立以下单向数据流：

```text
本轮事件
  ↓
Canonical NewMessageBatch（唯一事实源）
  ├─→ Canonical History 持久化
  ├─→ Provider wire message 投影
  └─→ UI / LoopScope timeline 投影
```

Batch 完成组装后，其顺序和结构不可被后续层重新推断或重排。未来只维护 batch 组装规则，即可自动维护 history、Provider 请求和 UI 展示的一致性。

### 2.2 顺序不变量

每个 batch 必须满足：

- 姿态、时间、当前用户消息、RAG、工具调用、工具结果、schema、skill 和 follow-up 按最终顺序一次性加入；
- batch 只能整体追加到 canonical history，禁止追加后再插入或合并；
- `tool_call` 与对应 `tool_result` 不得跨 batch 拆开；
- schema/discovery event 保留在 batch 中的原始位置；
- provider adapter 只生成副本，不修改 batch；
- history reload 后得到的 canonical 结构与首次追加结构一致；
- session gate 保证同一 session 的 batch 按提交顺序落库。

### 2.3 已有修复的回归保护

本分支在 Batch 重构之前已经修复过上下文组装和缓存稳定性问题。LLM-14 不得以“统一结构”
为理由回退这些行为；下面的约束属于强制不变量，必须在实现和回归测试中保留：

- 同一份 snapshot、history、batch 或 provider projection 不得被重复注入；重建或 reload 时只能保留一份语义相同的内容。
- history 与 batch 的包装层必须保持一致。不得出现运行时 batch 有额外包裹字段、持久化 history 去掉包裹，或 reload 后再次套包的情况。
- 动态尾缀（当前时间、动态上下文、RAG、姿态等）不得因为 finalize、reload、压缩或 Provider 投影被写入长期 history；它们只能按既有生命周期进入当前请求或 snapshot 对应区域。
- canonical history 的持久化只能保存真实对话和已确认需要持久化的 canonical event，不得把 provider 请求尾部、预算诊断字段、cache anchor 或动态 reminder 当作普通历史消息保存。
- snapshot 的固定内容、baseline/history、当前消息和动态尾部必须继续保持既有边界；Batch 只统一真实新增批次，不得把各区域重新拼成一份可重复注入的 history。
- 压缩后的 summary、工具 call/result 配对和附件/引用的既有清洗规则必须保持；附件正文、base64 和引用载荷不得因 Batch 归一化重新进入持久化 history。

### 2.4 与 ContextBranch 的边界

`ContextBranch`（见 `PRD-AGENT-5-ContextBranch反思与压缩统一架构`）是反思、压缩等后台
分支的旁路执行管线，不是主对话 Batch 的别名。两者必须保持以下边界：

- `ContextBranch` 的 `stable_system`、`baseline`、`delta` 和 `dynamic_context` 是分支逻辑输入，不直接改写 `PromptMessages`、主 session history 或 Batch。
- 分支调用的 provider user payload 不得伪装成主对话的 `tool_call`、`tool_result`、普通 user message 或新的 Batch。
- 分支结果只有在对应领域 writer（baseline coordinator、memory writer 等）成功提交后，才能通过既有领域入口影响下一次 snapshot/history；LLM-14 不得自动持久化分支输出。
- ContextBranch 的 fingerprint、scope、revision、attempts 和错误诊断只能保留在分支结果/诊断元数据中，不得进入主对话正文、Batch canonical content 或 Provider cache 前缀。
- LLM-14 Phase 3 的持久化收口不得强迫 ContextBranch 使用 Provider wire → canonical 反向转换；如压缩结果需要生成新 baseline，应由压缩领域 writer 创建明确的 baseline 记录。
- ContextBranch 的独立重试、预算和输出 schema 继续由 PRD-AGENT-5 管理；Batch 只约束主对话事件及其 Provider/UI 投影。

## 3. 非目标

- 不把 Provider wire format 直接作为持久化格式；
- 不在 history 层增加 Provider 分支；
- 不为每个 Provider 单独维护一套历史组装逻辑；
- 不通过 UI 层补偿 history 顺序问题；
- 不改变现有压缩、baseline 和预算阈值语义。

## 4. 设计方案

### 4.1 Canonical Batch 契约

`NewMessageBatch.messages` 统一接收 canonical message：

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "准备执行"},
    {"type": "tool_call", "id": "call-1", "name": "list_projects", "arguments": {}}
  ]
}
```

工具结果、schema 和上下文事件也使用 canonical block：

```json
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_call_id": "call-1", "content": "..."},
    {"type": "tool-schema", "name": "list_projects", "schema": {}}
  ]
}
```

Batch 应提供：

- 顺序稳定的 `messages`；
- 只读/冻结后的提交快照；
- batch digest，供诊断和幂等检查；
- 可选的 `round_id` / `run_id` 元数据，仅用于追踪，不改变正文。

### 4.2 Provider Adapter 边界

Provider Driver 不再负责生成可直接持久化的 history。它只负责：

```text
canonical batch/history → Provider wire messages
```

例如：

- `tool_call` → OpenAI `assistant.tool_calls` 或 Anthropic `tool_use`；
- `tool_result` → OpenAI `role=tool` 或 Anthropic `tool_result` block；
- canonical event → Provider 可接受的文本 block；
- thinking/reasoning 仅在 Provider 请求投影阶段按策略处理。

投影必须是纯函数或等价的无副作用转换，不得回写 canonical batch。

### 4.3 History 持久化

`finalize_run()` 直接持久化本轮已经完成的 canonical batch：

- 删除或下沉 finalize 阶段的二次 `canonicalize_tool_messages()`；
- 不再根据 Provider wire message 反推 canonical history；
- 不对已完成 batch 做相邻消息合并；
- 普通 assistant 文本、tool call/result 和事件均按 batch 原顺序保存；
- baseline、压缩和 trim 只处理 canonical history，不改变 batch 内顺序。

持久化前必须执行一次“已存在内容去重与区域边界校验”：如果某段内容已经属于 snapshot 或
既有 history，不能因为创建新 batch 再复制一份；如果内容属于动态尾缀，则必须在写库前排除。

现有数据库消息表可以继续使用 `role + content_json` 保存 canonical message，原则上无需新增业务字段。

### 4.4 UI 与 LoopScope

工具气泡、round 气泡和轨迹记录从同一 canonical batch 派生：

- UI 不再从 Provider wire message 猜测工具边界；
- 刷新后从持久化 canonical history 恢复同样的 batch 顺序；
- `round_id`、`tool_call_id` 作为展示元数据保留，但不参与正文重排；
- display timeline 与模型 history 可以是两个投影，但来源必须相同。

## 5. 迁移范围

### 5.1 需要修改的代码

| 文件/模块 | 修改内容 |
|---|---|
| `backend/agent/context/assembly/batch.py` | 增加 canonical batch 契约、冻结快照和 digest |
| `backend/agent/context/assembly/messages.py` | 将 `append_batch()` 作为唯一批次提交入口，禁止提交后隐式重排 |
| `backend/agent/core.py` | 工具 round 先构造 canonical batch，再生成 Provider 投影；事件在提交前完成编排 |
| `backend/agent/context/run_finalize.py` | 移除基于 wire message 的二次 canonicalize，直接持久化 batch |
| `backend/agent/context/history.py` | 保留 Provider projection/helper，删除持久化路径中的反向推导职责 |
| `backend/agent/providers/*_history_adapter.py` | 明确只读投影边界，禁止修改输入对象 |
| `backend/agent/runtime/loopscope_trace/*` | 从 canonical batch 派生 round/tool 展示信息 |
| `backend/tests/` | 增加 batch 顺序、reload、跨 Provider 投影和持久化一致性测试 |

### 5.2 需要清理的旧实现

- finalize 阶段针对本轮 wire message 的 `canonicalize_tool_messages()` 调用；
- Provider-specific history 反向转换后再写库的分支；
- append 后针对 schema/RAG/time event 的补插入逻辑；
- UI 或 LoopScope 对相邻消息进行的工具边界猜测；
- 仅用于兼容旧 batch 结构、且无历史数据迁移需要的包装 helper。

## 6. 执行 Todo

### Phase 0：现状盘点 ✅

- [x] 初步列出主要 `NewMessageBatch` 创建点和输入结构；
- [x] 初步标记 Provider wire → canonical 的反向转换路径；
- [x] 完整记录 batch append 后仍会修改 history 的调用点；
- [x] 建立覆盖运行时、Provider 投影和 reload 边界的顺序与 digest 基线；数据库 reload 验收延续 Phase 3。

### Phase 1：Canonical Batch 契约 ✅

- [x] 建立 `NewMessageBatch` 的基础 message/block 承载结构；
- [x] 增加 batch 提交前冻结和 digest；
- [x] 统一并校验 `NewMessageBatch` 的 canonical message/block 类型；
- [x] 让姿态、时间、当前用户、RAG、schema、skill、tool call/result 在提交前完成排序；
- [x] 从接口层禁止 batch 提交后修改其公开消息列表；canonical/provider 投影均通过副本读取，嵌套对象不会影响已冻结投影。

### Phase 2：Provider 投影隔离 ✅

- [x] 将 OpenAI/Anthropic wire 组装完全收敛为只读 adapter；
- [x] 增加部分 canonical → Provider 投影测试；
- [x] 增加部分 adapter 不污染 canonical batch 的测试；
- [x] 清理核心流程中的 Provider → canonical 反向转换和 Provider-specific history 持久化分支；
- [x] 清理新 Batch 创建路径中的 `from_provider_messages()` 兼容入口使用；该入口仅供旧 history 读取兼容和测试使用。

### Phase 3：持久化收口

- [x] 为 `conversation_batches` 增加 ORM/数据访问层，并在 finalize 中创建 batch 记录；
- [x] 修改 `finalize_run()` 接收并直接写入 canonical batch；
- [x] 新主链删除 Provider wire → canonical 的二次持久化推导；旧调用方仅保留兼容分支；
- [x] 为本轮 canonical 消息写入 `canonical_batch_id`，保留 run/round 追踪元数据；
- [x] 验证 tool call/result、schema 和事件顺序在 reload 后完全一致；
- [x] 验证 baseline/压缩只裁剪 batch，不改变 batch 内部顺序。

### Phase 4：展示与诊断统一

- [x] UI 工具气泡的持久化来源从 canonical batch 派生，并保留旧消息兼容；
- [x] LoopScope 运行时事件已有 `round_id` 和 `tool_call_id`；
- [x] LoopScope 记录 canonical batch digest/round id，持久化刷新按 canonical history 恢复工具身份，避免新链路依赖 Provider wire 猜测；
- [x] 增加 batch digest、canonical event、provider projection/adapter 统计诊断字段；
- [x] 保留旧分页边界配对逻辑，仅作为旧历史兼容，不改变 canonical batch 顺序。

### Phase 5：回归与清理

- [x] Web、QQ 群聊、QQ 私聊、飞书、微信入口统一调用同一 finalize/canonical batch 收尾链；
- [x] 无工具、单工具、多工具和多 round 的 batch 记录均按 canonical digest 传递；工具确认/报错结果沿用同一 `tool_result` canonical block；
- [x] schema 获取、skill 加载、RAG、时间 reminder 和压缩重试继续遵守动态尾缀不落库边界；
- [x] 回归已修复的上下文边界：无重复注入、history/batch 包装一致、动态尾缀不进入持久化 history；
- [x] snapshot、baseline、当前消息、动态尾部仍由既有 assembly/retention 生命周期管理，Batch 不改变这些区域；
- [x] 附件、引用、base64 和工具结果继续经过既有清洗，canonical 持久化不写入 provider wire；
- [x] 同一 Session 重复 finalize 时按 `(session_id, digest)` 去重，不重复插入 batch 消息；
- [x] 删除新主链中的 Provider → canonical 反向转换；`from_provider_messages()` 与 finalize fallback 仅保留旧历史/旧调用方兼容用途；
- [x] 完成 `git diff --check`、Python compileall、provider history 和 canonical batch 回归用例补充；完整 pytest、数据库迁移和 ui/LoopScope 回放需在依赖环境执行。

## 7. 验收标准

1. 同一 batch 在运行时、数据库、下一轮 reload 和 UI 展示中的 canonical 顺序一致。
2. Provider 切换只改变 wire projection，不改变 canonical history digest。
3. tool call/result 永不被拆散或重新排序。
4. schema、RAG、时间、姿态等事件不会在 finalize 或 reload 时移动到其他位置。
5. 本轮与下一轮的 cache 断点只由真实新增内容导致，不由包装结构变化导致。
6. finalize 不再执行 Provider wire → canonical 的二次反推。
7. 同一 session 并发场景下，batch 按 session gate 顺序提交，不出现交叉写入。
8. 不新增业务侧重复的 history、timeline 或 Provider 组装实现。
9. 已有 snapshot/history/cache 修复不回归：内容不重复、包装不漂移、动态尾缀不落入持久化 history。

## 8. 风险与兼容策略

- 旧 history 仍可能是早期 Provider 结构；读取时保留一次性兼容归一化，但不得让新 batch 继续走旧持久化路径。
- Provider 无法表达某类 canonical event 时，只在投影层降级为文本，不修改 canonical 内容。
- 历史消息迁移必须保持 tool call/result 配对；无法配对的旧结果只进入诊断，不发送给 Provider。
- 迁移期间如发现旧数据结构差异，优先增加读取兼容，不回退新的 batch 写入契约。

## 9. 完成定义

- Phase 0～5 Todo 全部完成；
- 后端全量测试和跨 Provider history 回归通过；
- 线上日志确认 batch/history/provider 三种 digest 在稳定轮次保持预期关系；
- 旧反向 canonicalize、append 后补插入和展示猜测逻辑已删除；
- 文档、代码注释和测试均以 Batch 为唯一历史组装入口。
