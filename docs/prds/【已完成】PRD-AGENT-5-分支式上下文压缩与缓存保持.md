# PRD-AGENT-5：分支式上下文压缩与缓存保持

## 状态

实现完成（2026-08-25）

## 1. 背景

现有压缩在 history 较大时按多个块滚动摘要。每个块都会把上一块的新摘要重新放入请求，导致 provider 的稳定前缀被改变，后续块的 cache read 明显下降。真实 session 对比显示：分支式单次摘要请求减少一次模型调用，输入 token 更低，热启动时缓存命中率达到 100%；普通滚动策略的第二个块缓存命中率降至约 1.5%。

## 2. 目标

1. 从当前 session 的只读 history 快照分支出压缩任务，不阻塞当前 run，不直接修改真实 session。
2. 在安全输入范围内用一次摘要请求完成旧 history 压缩，尽量保持 provider 稳定前缀。
3. 压缩结果只有通过结构、长度和 baseline CAS 校验后才能成为新的 baseline。
4. provider overflow、run 收尾 baseline 更新和手动 `/compact` 共用同一摘要候选策略。
5. 只处理 baseline 之前的旧 history；system prompt、snapshot、动态尾部、工具目录、用户记忆和当前 run 全部保持独立。

## 3. 非目标

- 不删除原始数据库消息。
- 不把 snapshot、memory、RAG、工具 schema 或当前 run 压进摘要。
- 不新增一套 session 锁、baseline 或 pending 状态。
- 不在一次性输入超过安全上限时强行发送；超限使用已有分块滚动策略。

## 4. 策略

```text
读取当前 baseline 之后的 history
        ↓
保护最近完整 history 窗口
        ↓
可压缩 history <= branch 输入上限？
        ├─ 是：分支式单请求生成候选摘要
        └─ 否：分块滚动生成候选摘要
        ↓
长度/结构/当前 run 边界校验
        ↓
重新读取 session 并校验 baseline_message_id/hash
        ↓
CAS 成功后原子提交 summary + snapshot/baseline 元数据
```

当前第一版安全输入上限为 96,000 字符，摘要输出仍限制为 10,000 字符；保留窗口、provider usage 判定和 retry 规则继续由 PRD-AGENT-4 统一管理。

## 5. 并发与失败处理

- 摘要请求期间不持有数据库事务，只持有现有 session compression lock。
- 摘要请求失败、返回空内容、超过输出上限或结构校验失败时，候选直接丢弃，当前 baseline 不变化。
- 摘要请求完成后重新读取 session；若 baseline id/hash 已变化，旧候选丢弃，不覆盖新结果。
- 分支式压缩不改变当前 run 的消息对象；overflow retry 仍由当前 run 自己重新组装。
- 分支式输入超过安全上限时使用滚动 fallback，不能因为追求单请求而制造 provider overflow。

## 6. 可观测性

只记录脱敏指标：

- `compression_mode`: `branch` 或 `rolling-fallback`
- 输入字符数、处理消息数、保留消息数
- provider fresh/cache input tokens
- 摘要字符数、耗时、失败原因
- baseline CAS 成功/丢弃原因

不记录 history 正文、摘要正文、工具参数、附件名或用户输入。

## 7. 实施 Todo

### Phase 1：候选生成器

- [x] 增加分支式单请求路径。
- [x] 超过安全输入上限时复用现有滚动 fallback。
- [x] 统一持久 baseline 压缩和运行中 inline compaction 的候选生成策略。
- [x] 增加 branch/fallback 模式日志。

### Phase 2：安全提交

- [x] 保留现有 compression lock。
- [x] 保留 baseline id/hash CAS 校验。
- [x] 确认失败候选不会写入真实 session。
- [x] 为 branch 候选增加显式摘要长度/结构校验回归。
- [x] 增加 baseline 变化期间 branch 候选被丢弃的 CAS 回归测试。

### Phase 3：真实 provider 验证

- [x] 使用真实 session 完成冷启动与热启动对比。
- [x] 对比普通/分支的 input、cache、请求次数和摘要质量。
- [ ] 在 MiniMax、Qwen、OpenAI-compatible provider 各完成一次线上验证（保留为发布后观测项，不能用本地 mock 冒充）。
- [x] 验证 provider overflow 后 branch retry 不丢当前 run。

### Phase 4：上线收敛

- [x] 将 branch 输入上限固定为 96,000 字符，并由统一 fallback 策略处理超限历史。
- [x] 删除持久 baseline 中重复维护的 branch/rolling 分块入口，仅保留共享策略和超限 fallback。
- [x] ContextBudget 的触发、provider overflow retry 和 baseline 生命周期继续由现行上下文预算文档承接。

## 9. 实现位置

- `backend/agent/context/compaction.py`：共享 branch/fallback 候选生成器、摘要输出契约、inline compaction。
- `backend/agent/context/compress_conv.py`：持久 baseline 调度、session compression lock、baseline CAS 和原子写回。
- `backend/agent/core.py`：provider overflow 后只替换旧 history，保护当前 run 并重试当前 round。
- `backend/tests/test_compaction.py`：摘要长度/结构、工具轮次原子性、当前 run 保护、CAS 和 branch/fallback 回归。

线上 provider 验证不写入生产 session，也不把用户正文、工具参数或凭据写入报告；待后续使用各 provider 的真实配额复测。

## 8. 验收标准

- 可压缩 history 在安全上限内只发一次摘要请求。
- branch 请求失败不会改变 baseline。
- branch 请求与 baseline 提交之间发生新消息/新 baseline 时，旧结果不会覆盖新结果。
- system/snapshot/memory/tool schema/current run 不出现在摘要输入边界之外的错误删除中。
- 超大 history 仍能通过 rolling fallback 完成压缩。
- provider cache 与请求次数相较当前滚动策略有可观测改善。
