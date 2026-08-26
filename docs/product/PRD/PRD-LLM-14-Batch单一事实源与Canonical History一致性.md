# PRD-LLM-14：Batch 单一事实源与 Canonical History 一致性

## 文档状态

- 状态：待实施
- 类型：上下文架构重构
- 范围：Agent Loop、Canonical Context、Provider Adapter、运行记录与工具时间线
- 不包含：Provider API 能力新增、数据库业务字段新增、UI 视觉改版

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

### Phase 0：现状盘点

- [ ] 列出所有 `NewMessageBatch` 创建点和输入结构；
- [ ] 标记所有 Provider wire → canonical 的反向转换路径；
- [ ] 记录 batch append 后仍会修改 history 的调用点；
- [ ] 建立当前顺序和 digest 的基线测试。

### Phase 1：Canonical Batch 契约

- [ ] 统一 `NewMessageBatch` 的 message/block 类型；
- [ ] 增加 batch 提交前冻结和 digest；
- [ ] 让姿态、时间、当前用户、RAG、schema、skill、tool call/result 在提交前完成排序；
- [ ] 禁止 batch 提交后修改其消息对象。

### Phase 2：Provider 投影隔离

- [ ] 将 OpenAI/Anthropic wire 组装收敛为只读 adapter；
- [ ] 增加 canonical → Provider 的 round-trip 测试；
- [ ] 验证 adapter 不会污染 canonical batch；
- [ ] 清理 Provider-specific history 持久化分支。

### Phase 3：持久化收口

- [ ] 修改 `finalize_run()` 直接写入 canonical batch；
- [ ] 删除二次 `canonicalize_tool_messages()` 持久化路径；
- [ ] 验证 tool call/result、schema 和事件顺序在 reload 后完全一致；
- [ ] 验证 baseline/压缩只裁剪 batch，不改变 batch 内部顺序。

### Phase 4：展示与诊断统一

- [ ] UI 工具气泡从 canonical batch 派生；
- [ ] LoopScope round/tool 记录使用稳定 `round_id` 和 `tool_call_id`；
- [ ] 增加 batch digest、history digest、provider projection digest 对照日志；
- [ ] 清理展示层的补合并和猜测逻辑。

### Phase 5：回归与清理

- [ ] Web、QQ 群聊、QQ 私聊、飞书、微信分别验证；
- [ ] 覆盖无工具、单工具、多工具、工具确认、工具报错重试和多 round；
- [ ] 覆盖 schema 获取、skill 加载、RAG、时间 reminder 和压缩重试；
- [ ] 删除确认无引用的旧 helper 和兼容分支；
- [ ] 完成 `git diff --check`、后端测试和 provider history 测试。

## 7. 验收标准

1. 同一 batch 在运行时、数据库、下一轮 reload 和 UI 展示中的 canonical 顺序一致。
2. Provider 切换只改变 wire projection，不改变 canonical history digest。
3. tool call/result 永不被拆散或重新排序。
4. schema、RAG、时间、姿态等事件不会在 finalize 或 reload 时移动到其他位置。
5. 本轮与下一轮的 cache 断点只由真实新增内容导致，不由包装结构变化导致。
6. finalize 不再执行 Provider wire → canonical 的二次反推。
7. 同一 session 并发场景下，batch 按 session gate 顺序提交，不出现交叉写入。
8. 不新增业务侧重复的 history、timeline 或 Provider 组装实现。

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
