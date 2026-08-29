# Agent 可靠性与恢复

> 本文描述当前 Agent 在消息不丢失、不重复、不乱序和可恢复方面的实现。可靠性不是对所有异常统一重试，而是根据操作是否产生副作用选择 ack、重试、补偿或失败收束。

## 1. 可靠性目标

一次 Agent 请求至少要满足：

1. 入站消息有明确的接收、处理和确认边界；进程崩溃后可以恢复未确认消息。
2. 同一会话内消息保序，不因不同 bot、群聊/私聊或不同用户共用锁而串线。
3. 模型和工具的多 Round 状态可继续、可取消、可失败收束，不能只留下“正在处理”。
4. 有副作用的工具和平台发送不能因为网络不确定而盲目重复执行。
5. 压缩、反思、RAG 和后台任务失败时，不破坏 canonical history，也不伪造完成状态。
6. 服务重启时先停止接收，再等待正在运行的任务释放资源，避免半条回复、未归还连接和孤儿任务。

## 2. 消息处理可靠性

```text
平台 Gateway
    -> Redis Stream XADD
    -> worker XREADGROUP
    -> 幂等去重
    -> 会话防抖 / 锁
    -> Agent Loop
    -> 出站发送
    -> ACK
```

### 2.1 Redis Stream

`backend/app/core/redis.py` 提供 IM 入站 Stream 的统一操作：

- 使用 consumer group 消费新消息；消息处理完成后才 `XACK`。
- worker 每轮优先 `XAUTOCLAIM` 超过 60 秒未确认的 pending 消息，再消费新消息。
- worker 崩溃、任务异常或进程被终止时，未 ack 消息会留在 pending，交给后续 consumer 恢复。
- consumer 使用稳定名称，旧 consumer 只有在无 pending 且空闲超过 30 分钟时才清理。
- Stream 保留长度是基础设施容量控制，不等于业务历史；消息一旦落库，后续展示和恢复以数据库 canonical history 为准。

### 2.2 ACK 与毒消息

正常路径在处理完成后 ack。当前 worker 对 `_dispatch`、flush、交互快速通道和后台反思任务都在 `finally` 中确认消息；不可恢复的业务异常会记录脱敏错误并 ack 丢弃，避免同一毒消息无限循环。这个选择意味着：

- 可恢复的队列故障应让消息保持 pending，等待 claim；
- 已确定无法处理或会无限失败的消息可以 ack，但必须有受限诊断和可观察状态；
- 不能用 ack 掩盖普通业务 bug，也不能把已产生副作用的任务简单重放。

入队本身也要考虑幂等：网关对能识别的消息 ID 使用去重检查；Stream XADD 失败不能盲目重推没有幂等保证的 payload。

## 3. 去重、顺序与并发

### 3.1 去重

worker 使用 `imseen:{stream_message_id}` 记录已经接收过的 Stream 条目，claim_stale 重投时先检查该键，避免同一条队列消息再次进入 Agent。这个键只解决 Stream 条目重投，不替代平台消息 ID、业务 request ID 或工具自身幂等键。

### 3.2 会话顺序

会话锁键使用 `platform + bot_id + chat_type + scope_id`，不是裸平台用户 ID。这样同一个平台用户在不同 bot、不同群和私聊之间可以并发，单一会话仍保持顺序。

worker 还维护两类锁：

- 主动消息锁：保证同一会话的 Agent Run 串行。
- 被动群消息锁：保证群消息落库顺序，但不等待主动模型任务，也不占用主动 Run 锁。

短时间连续输入进入防抖缓冲，静默达到窗口后合并为一轮。缓冲中的消息在 flush 完成前不 ack；进程退出时 flush task 纳入 drain。

### 3.3 有界并发

全局运行信号量限制同时执行的 Agent 数量，默认并发为 16，Admin 配置可在 worker 对账周期内热更新，最大值受代码限制。没有空闲槽时不继续从 Stream 拉取新任务，避免无界创建异步 task。

`ask_user` 的文本/按钮回复走交互快速通道，不等待原 Run 的会话锁；否则用户的确认可能排在等待中的 Run 后面而过期。

## 4. Run、Round 与工具恢复

```text
Run
  -> Round 1
  -> Tool Call
  -> Tool Result
  -> Round 2
  -> 最终回复 / 等待 / 失败 / 取消
```

- 一个 Run 可以包含多个 Round；工具调用和工具结果必须保留相同的 Run、Round 和 tool call 关联。
- 工具结果写入 canonical history 后才允许进入下一 Round，不能只把最后结果放进上下文。
- 工具失败形成结构化 Tool Result，模型可以修正参数或向用户说明失败；不能把工具异常包装成成功文本。
- 工具有副作用时使用注册表的 `mutates` 元数据识别是否改变业务数据，不靠工具名称前缀猜测。
- 用户取消会停止后续模型/工具推进并清理运行状态；已经发出的不可撤回平台消息不能被假装撤回。
- 交互等待持久化 prompt、会话和工具关联，消费时重新校验 owner、scope、过期时间和一次性 token；重复点击不能重复执行。

## 5. 重试策略

### 5.1 可重试对象

重试只适用于能判断为瞬时失败且副作用尚未发生的操作：

| 对象 | 当前策略 |
|---|---|
| LLM provider | 按 provider adapter 的瞬时错误白名单有限重试；用尽后转为结构化失败 |
| RAG/可选上下文 | 失败或超时可跳过，不阻塞主 Agent；后台 task 必须收尾 |
| Redis 消费 | worker 主循环异常等待 2 秒后继续；pending 消息由 claim 恢复 |
| 微信 long-poll | `getupdates` 是幂等读，异常等待后继续拉取 |
| QQ/飞书连接 | Gateway/gateway 负责心跳、重连和进程级重启 |
| QQ/飞书出站 | 只对明确瞬时错误有限重试；永久 4xx 和不确定副作用不盲重放 |
| 微信出站 | 只在连接建立阶段失败时有限重试；请求可能已送达时不重试 |
| 记忆反思任务 | 任务状态为 retry/dead，使用有限退避；达到上限进入 dead 等待人工/定时补偿 |

### 5.2 不应重试的情况

- 参数、Schema、权限、ownership 或确认失败。
- API key、token、bot 配置无效等稳定性错误。
- 已经可能产生副作用但没有幂等键的发送或写入。
- 编程错误、数据结构错误和违反不变量的异常。

重试日志只记录错误类别、尝试次数、耗时和 fingerprint，不记录正文、凭据或完整平台响应。

## 6. 上下文压缩与缓存恢复

上下文可靠性重点是“压缩不丢事实、并发不覆盖新历史”：

- 自动压缩由实际 provider usage 和预算守卫触发，不由粗略数据库消息数量单独决定。
- 压缩只处理允许压缩的旧历史；Snapshot、当前请求、canonical tool pair 和必要的动态上下文不能被误删。
- 压缩结果写为唯一 baseline summary，并用 baseline ID/hash 做 compare-and-set；开始压缩后如果 baseline 已变化，旧结果不能覆盖新结果。
- 同一 session 的 baseline task 合并，避免多个后台压缩同时运行。
- 压缩失败保留原 history，不删除 daily 或旧消息，不伪造 baseline 已更新。
- provider wire history 可以不同，但 canonical history 的消息顺序、tool call ID、tool result 归属和 quote/attachment 边界必须稳定，否则会造成恢复错误或 cache 前缀漂移。

## 7. 后台任务与补偿

后台任务包括 RAG 召回、记忆反思、scope 清理、附件/视频/RAG 索引 GC、定时任务和标题/摘要生成。共同约束是：

- 任务失败不能阻塞用户主回复，除非该任务是当前请求的必要业务步骤。
- 任务必须有明确的锁、游标、幂等键或版本条件，避免重启后重复写入。
- 反思和清理任务使用独立 Stream、consumer group、重试次数和退避；每 30 秒补偿到期任务。
- 反思 scope 使用分布式锁，同一 scope 串行执行；写入失败推进游标前必须保持原状态。
- RAG sidecar 不可用时不能伪造索引已更新；Python 侧保留可重试或补偿路径。
- 资源 GC 只清理确认未被业务引用的衍生文件或缓存，不删除业务主数据。

## 8. 网关与服务生命周期

`agent.gateway.gateway` 按 `UserBot` 配置管理 QQ、微信和飞书网关进程：

- 凭据通过环境变量注入，不放进 argv。
- 启动后存活不足 5 秒的进程按连续秒崩处理，采用指数退避，最长 5 分钟。
- 长时间运行后退出按网络抖动处理，可立即重启。
- UserBot 被禁用或删除时终止对应网关；数据库读取失败时保留现有进程，避免配置瞬时抖动误杀。

worker 收到 SIGTERM 后停止接收新消息，等待 active dispatch 和 flush task 完成，再关闭 scheduler、RAG 任务、Redis、sidecar 和数据库连接。异常退出路径会取消残留 task 并 best-effort 释放同样的资源。

Web 生成任务与 HTTP 请求脱离运行：浏览器断开不会直接取消后台生成；刷新后可通过 session stream 续看，最终以数据库历史为准。PTY、Web Agent SSE 和 IM Gateway 的连接关闭分别处理，不能用一个连接状态代表全部服务已恢复。

## 9. 可观测性与故障诊断

可靠性诊断至少需要区分：

- Stream length、pending、lag、consumer 数和 claim 次数；
- 消息从 received 到 ack 的耗时、失败类别和重试次数；
- session lock 等待、并发槽占用、防抖缓冲和 active Run 数；
- Run/Round/Tool 的最终状态、取消、交互等待和压缩结果；
- Gateway 连接、重连、秒崩退避和出站平台错误；
- 数据库连接池、未归还连接、后台 task pending 和服务关闭耗时。

日志只使用脱敏 ID、计数、状态、耗时和 fingerprint。用户正文、附件名、工具敏感参数、token、API key 和平台凭据进入普通日志都属于可靠性与安全缺陷。

## 10. 测试覆盖

| 可靠性范围 | 代表测试 |
|---|---|
| IM 去重、会话键和作用域 | `test_im_dedup.py`、`test_im_conversation_key.py`、`test_im_session_reuse.py` |
| 会话执行 gate、pending 和并发 | `test_session_execution_gate.py`、`test_runtime_state_scope.py` |
| Round、工具事件和失败收束 | `test_runner_collect.py`、`test_core_loop_characterization.py`、`test_stream_round_retry.py` |
| 交互一次性消费与恢复 | `test_interaction_protocol.py`、`test_interaction_events.py` |
| 压缩、baseline CAS 和工具边界 | `test_compaction.py`、`test_session_snapshot.py`、`test_history_persist_filter.py` |
| 平台重连、发送和附件边界 | `test_qq_raw_ws.py`、`test_qq_raw_send.py`、`test_wechat_quotes.py`、`test_feishu_gateway_guards.py` |
| 关闭、进程和资源清理 | `test_scheduler_shutdown.py`、`test_terminal_streaming.py`、`test_start_im_activity_order.py` |

新增异步任务、出站消息或持久化状态时，至少补充成功、瞬时失败、永久失败、重复执行、取消、超时和进程重启后的行为测试。测试应验证最终状态和副作用次数，不能只断言返回文案。

## 11. 当前限制

- Redis Stream 可以恢复未 ack 的入站消息，但平台 Gateway 在入队前失败、平台已经接受而本地未收到响应、或外部服务产生不确定副作用时，不能仅靠重试推断真实结果。
- IM 出站多数不是幂等操作，当前优先避免重复发送，因此网络不确定时可能需要用户重新发起。
- Web SSE 不负责补发完整历史 token；断线恢复依赖运行快照和最终数据库历史。
- graceful drain 只能等待当前进程可见的 task；硬杀进程、宿主机断电和 Redis/数据库同时不可用仍需要启动后的 pending、状态和补偿机制兜底。
- 可靠性指标和告警应继续覆盖每个平台、每个队列和每类后台任务，不能只看 Web HTTP 成功率。
