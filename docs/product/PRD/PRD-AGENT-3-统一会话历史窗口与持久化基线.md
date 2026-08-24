# PRD-AGENT-3：统一会话历史窗口与持久化基线

## 状态

执行中（2026-08-24）

## 背景

当前 Web、私聊和群聊都已经具备 `baseline_message_id`、会话 snapshot 和持久化 summary，但历史读取、checkpoint 调度没有完全统一：

- 部分入口在 `baseline=0` 时会读取会话的全部数据库消息；
- Web 入口曾有“最近消息 + token 预算”窗口，统一历史改造后该保护被移除；
- Web 生成收尾未稳定调用持久化 checkpoint；
- 群聊全量接收消息，最容易在持久化压缩完成前触发 inline compaction；
- inline compaction 只修改当前 run 的内存消息，不会自动推进 baseline，导致下一轮重复压缩并破坏 Round 1 cache 前缀。

## 目标

1. Web、私聊、群聊、微信、飞书和定时任务统一使用同一套历史读取窗口。
2. `baseline=0` 时也不能无限读取数据库历史。
3. 持久化压缩成功后，summary 与新的 baseline 在同一事务中提交。
4. 保留现有 summary、baseline、snapshot TTL 和 inline compaction 策略，不改变其语义。
5. 让 inline compaction 成为当前请求的最后安全兜底，而不是每轮常态路径。
6. 让稳定会话的历史前缀保持确定性，提升跨 run cache 命中率。

## 非目标

- 不按渠道重新设计多套压缩算法；
- 不把动态对话 summary 写入稳定 snapshot；
- 不删除数据库中的旧消息；
- 不把一次读取窗口裁剪直接当作永久 baseline；
- 不改变 summary 的提示词、模型路由和滚动合并格式。

## 统一数据流

```text
请求开始
  → 等待上一轮 checkpoint
  → 读取 summary + baseline 之后的历史
  → 按统一 history_budget 选取最近完整消息单元
  → 组装 snapshot / 工具 / 动态消息
  → core 精确预算检查
  → 必要时执行一次 inline compaction 或确定性截断
  → 完成响应并持久化本轮消息
  → 所有入口调度 checkpoint
  → summary + baseline 原子提交
```

## 详细设计

### 1. 统一历史读取

由 `agent.context.session_history` 提供统一入口，入口参数包括：

- `session_id`；
- `baseline_message_id`；
- 实际模型 `context_tokens`；
- 固定上下文预留 token；
- 最大读取条数安全上限。

读取预算按以下方式计算：

```text
模型上下文上限
- system prompt
- snapshot / 群记忆
- 工具 schema
- 当前消息与动态尾部
- 安全余量
= history_budget
```

读取结果必须：

- 始终保留最新 summary；
- 只选择 baseline 之后的消息；
- 从最新消息向前选择，再恢复时间正序；
- 将 tool call 与对应 tool result 作为不可拆分单元；
- 使用条数上限保护数据库读取，避免异常会话造成无界查询。

读取窗口只负责本轮保护，不推进 baseline。

### 2. 持久化 checkpoint

所有生成入口在成功持久化本轮消息后调用同一个 `schedule_checkpoint` API。后台任务：

1. 按真实 `history_budget` 判断是否需要压缩；
2. 读取 baseline 之后的完整数据库历史；
3. 生成或滚动合并 summary；
4. 在同一数据库事务中删除旧 summary、写入新 summary、推进 `baseline_message_id` 和 hash；
5. 提交后刷新 snapshot 的历史边界。

checkpoint 失败不得影响已经完成的响应，但必须记录受限诊断日志；下一轮仍由读取窗口和 core 预算守卫保护。

### 3. inline compaction

现有 inline compaction 保持不变：

- 只处理当前 run 内存中的消息；
- 最多尝试一次；
- 压缩后仍超预算时执行确定性截断；
- 不直接推进 baseline；
- 不直接修改稳定 snapshot。

只有持久化 checkpoint 才能让压缩结果跨 run 生效。

### 4. snapshot 边界

snapshot 继续保存稳定上下文和历史 baseline 元数据，但不保存不断变化的对话正文 summary。summary 通过历史入口单独置于固定上下文区，避免动态内容污染稳定 cache 前缀。

## 验收标准

- Web、私聊和群聊调用同一历史读取实现；
- 新会话 `baseline=0` 时，历史读取仍受 token 和条数上限保护；
- Web 生成结束后能调度 checkpoint；
- checkpoint 成功后下一轮的 `baseline_message_id` 大于被压缩消息的最大 id；
- 下一轮不再重复读取已压缩旧消息；
- tool call/tool result 不会被窗口拆开；
- checkpoint 失败有日志且不影响当前响应；
- 长群会话的 Round 1 不再每轮生成不同 inline summary；
- 现有 summary、snapshot TTL、provider history 清理和 inline compaction 测试继续通过。

## 实施阶段

- [x] Phase 0：确认 Web 旧窗口、当前 baseline 读取和群聊重复压缩根因；
- [x] Phase 1：实现统一历史读取窗口与原子工具轮选择；
- [x] Phase 2：补齐 Web checkpoint，并统一所有入口调度；
- [x] Phase 3：增加 checkpoint 错误日志和回归测试；
- [ ] Phase 4：在 LoopScope 对比长群会话的 Round 1 cache、输入 token 和压缩次数。
