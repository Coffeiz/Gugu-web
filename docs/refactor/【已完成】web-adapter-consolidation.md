# Web Adapter 与 Runner 统一组装方案

**日期**：2026-08-26  
**状态**：✅ 已完成（Phase 0-6）  
**完成日期**：2026-08-26  
**关联**：Prompt Cache 优化（`OPT-Cache-Assembly-2026-08-19.md`）

## 1. 现状与问题

`agent/core.py` 已提供统一的 `LLMRunner` 工具循环，但 Web 与 IM 仍各自维护一套上下文组装流程。当前已完成模型选择、provider 参数和部分预算元数据的统一，但这只是过渡收口，尚未解决组装层重复。

Phase 4 前，Web `agent/gateway/web.py::_generate_unlocked()` 曾自行执行：

- snapshot / history 读取后的 `fixed_parts`、`history_parts` 构造；
- dynamic tail、当前时间和 RAG 注入；
- Anthropic / OpenAI 消息 assembly；
- sanitize 与上下文布局审计；
- `LLMRunner.run()` 前的请求准备。

上述逻辑同时存在于 `runner.py` 的 `_run_collect_unlocked()` / `_run_stream_unlocked()`；Phase 1-3 已将组装迁移到 `run_context.py`，Phase 4-5 又将收尾迁移到 `run_finalize.py`。历史上的重复实现容易造成：

1. 组装顺序修一边漏另一边，破坏 Prompt Cache 前缀；
2. Web、IM 的 RAG、时间、工具目录和历史清洗行为逐渐分叉；
3. 同一个 provider 在不同渠道出现不同预算、压缩和工具 schema 行为；
4. 代码继续通过局部 helper 增长，而不是减少重复实现。

## 2. 已完成的收口

- `run_collect()` 与 `run_stream()` 都使用 session gate，并在释放 gate 前等待 baseline 提交。
- Web 与 IM 使用统一的 `resolve_run_config()` 解析模型、API 格式和上下文容量。
- Web 已使用 provider 返回的 `context_input` 作为上下文峰值，并记录 `compaction_applied`。
- Web 已补齐当前时间 reminder、能力目录和基础 Shell 过滤。
- IM 非流式路径已经是统一 Runner 生命周期的主要实现。

这些改动不应继续扩展为第三套 Web 专用组装逻辑。

## 3. 目标架构

不让 Web 直接复用 IM 的 `run_stream()` 作为最终入口。Web 使用 SSE/genstream，IM 使用 token/final 事件和平台交互回调，输出协议必须保持独立。

```text
Web / IM / scheduled task
        │
        ├─ 会话与渠道上下文
        ▼
ContextAssembler / PreparedRun
        ├─ snapshot / baseline
        ├─ history
        ├─ dynamic tail / RAG
        ├─ capability context
        ├─ provider message format
        └─ sanitize / layout metadata
        ▼
LLMRunner
        ├─ provider 调用
        ├─ 工具循环
        ├─ usage / compaction 元数据
        └─ baseline 收尾契约
        ▼
Transport Adapter
        ├─ Web SSE / genstream
        ├─ IM token / final / interaction callback
        └─ scheduled task 完整结果
```

目标是统一“上下文组装、工具循环、预算与 baseline 收尾契约”，而不是强行统一 Web 和 IM 的传输协议。

## 4. 组件职责

### ContextAssembler

共享组装层位于 `backend/agent/context/run_context.py`，输出 `PreparedRun`：

- 加载并固定 snapshot、history、RAG、dynamic tail 和 capability context；
- 根据 `source` 选择 IM identity、continuity bridge、proactive lead；Web 场景自然跳过；
- 统一构造 Anthropic / OpenAI 消息；
- 统一执行 sanitize，并返回 fixed prefix、dynamic tail、history 边界元数据；
- 不负责 SSE、IM 发送、标题或前端事件。

### Run Finalizer

共享收尾层位于 `backend/agent/context/run_finalize.py`，由 Web 与 IM 非流式/流式入口共同调用：

- 按同一顺序写入 RAG block、canonical tool turn、assistant 回复；
- 统一配额封顶和 `AgentUsage` 字段；
- 统一 trim 与 `schedule_baseline_update`，携带 provider 的 `context_input` 和 `compaction_applied`；
- 处理 Web 会话删除竞态：跳过孤儿消息但保留可归属的用量记录。

Transport adapter 不再自行拼装持久化消息或再次调度 baseline。

### LLMRunner

- 消费 `PreparedRun`；
- 负责 provider 调用、工具循环、交互回调；
- 返回文本、工具事件、usage、context_input、compaction_applied；
- 只通过统一收尾流程提交 baseline，不感知 Web/IM 发送方式。

### Transport Adapter

- Web：负责 genstream、SSE、断线续看、流式去重和 Web 事件推送；
- IM：负责 token/final 事件、平台按钮/交互回调和渠道发送；
- 定时任务：负责完整结果发送；
- 不得重新组装上下文或自行计算预算。

### 渠道独有逻辑

以下逻辑保留在渠道适配层或会话创建层：

- Web greeting 首条消息落库；
- Web SSE/genstream 和后台任务；
- IM identity、群成员信息、continuity bridge、proactive lead；
- IM 平台交互和发送格式。

## 5. 实施计划

1. **Phase 0（已完成）**：统一模型配置、provider 参数、上下文峰值和压缩元数据。
2. **Phase 1（已完成）**：新增 `ContextAssembler` / `PreparedRun`，统一固定段、历史、RAG、动态尾部、时间和 provider 消息组装。
3. **Phase 2（已完成）**：`run_collect()` 与 `run_stream()` 均消费共享组装结果。
4. **Phase 3（已完成）**：Web `_generate_unlocked()` 消费共享组装结果，SSE/genstream、去重和断线续看保持在 Web transport 层。
5. **Phase 4（已完成）**：统一 usage、compaction、baseline、消息持久化的 `run_finalize` 收尾契约。
6. **Phase 5（已完成）**：删除 Web/IM 旧持久化与 baseline 调度块，保留 SSE、IM 交互、标题/总结等渠道差异。
7. **Phase 6（已完成）**：补充收尾契约测试，完成全量后端回归、编译检查和缓存边界审查。

## 6. 风险与约束

- 不能把 Web 直接改成调用 IM `run_stream()`，否则会混淆输出协议和后台任务生命周期。
- Web 的 MiniMax 多轮文本去重只属于 Transport Adapter，不能进入通用 assembly。
- greeting 必须在 Web 会话创建阶段落库，不能作为固定 system 内容重复注入。
- IM identity、群记忆和 proactive 内容只能按渠道策略注入，不得污染 Web snapshot。
- 删除旧实现前必须保留 Web/IM 两条路径的组装快照和 tool schema 回归测试。

## 7. 验收标准

1. Web、IM 使用同一套 `ContextAssembler`；定时任务仍保留无 session 的轻量组装适配器，但复用相同的 provider 配置和消息布局约定。
2. 修改组装顺序、RAG、时间 reminder 或工具目录只需改一处。
3. 相同输入下，固定段、历史段和动态段边界一致，缓存断点可解释。
4. usage、`context_input`、`compaction_applied` 和 baseline 收尾契约一致。
5. Web/IM 的传输、交互、去重和 greeting 等渠道特有行为保持不变。
6. 全量后端测试通过（1515 passed），新增 `tests/test_run_finalize.py` 覆盖 Web/IM 共用的收尾契约，并复用现有 core-loop/provider/cache 前缀回归测试；定时任务路径保留既有回归测试。

## 8. 完成结论

Phase 0-6 已全部落地。Web 与 IM 的上下文组装、provider 运行配置、工具循环和 run 收尾契约已经统一；渠道差异仅保留在传输、交互和会话入口层。后续如需扩展，应在共享 ContextAssembler 或 Run Finalizer 中修改，避免重新引入渠道侧重复实现。
