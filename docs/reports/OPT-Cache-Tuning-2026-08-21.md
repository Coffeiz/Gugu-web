# Prompt Cache 调优复盘报告

日期：2026-08-21

## 结论摘要

本轮调优已经验证有效：

- Kimi 连续对话大多数轮次达到 80% 以上缓存命中。
- Qwen 在修复组装前缀稳定性后，连续测试中后两轮达到 98% 以上缓存。
- 部分低命中轮次仍然存在，但主要由输入前缀发生结构性变化、跨进程加载旧代码或等待超过供应商 TTL 导致，不是缓存策略本身失效。
- MiniMax 尚未完成同等规模的复测，因测试期间 Token Plan 用量耗尽，保留后续验证。

## 初始现象

早期跨 run 测试中，第一轮通常只有约 128 token cache，甚至只占总输入的 0.7%；部分 run 的命中率约 43% 或 47.6%。同一 session 中也出现过明显波动：

| 样本 | 观察结果 |
| --- | --- |
| `run-1d3283bcbb02-25c739` | 约 576 token cache |
| `run-ffe323600d3a-1e98d5` | 约 95% cached |
| `run-62f5058d29ec-cea95d` | 约 47.6% |
| `run-4737909eb0d9-d31dc5` | 约 0.7%，约 576 token |
| Qwen 早期多轮样本 | 约 43% 左右 |

这说明“是否命中”不是唯一问题，更关键的是每一轮请求的前缀是否和上一轮字节级保持一致。

## 主要根因

### 1. 动态 system reminder 破坏了缓存前缀

早期组装把项目、日历、文件、memory、style、lens、channel 等内容反复拼入 system 或 system reminder。只要其中一小段发生变化，后续整个前缀都会失效。

尤其是：

- 每轮重新生成完整 runtime snapshot。
- `[system-reminder]` 的位置或包装结构变化。
- 动态内容被放在固定历史之前。
- 同一 session 的 run 与 round 使用了不同组装路径。
- 开发服务器仍运行旧 worker 或旧 Python 进程，导致观测到的输入结构与本地源码不一致。

### 2. run 与 LLM round 的组装边界不够稳定

目标结构逐步收敛为：

```text
system + session info + history/messages + dynamic tail
```

其中 history/messages 作为连续追加区域，tool use、tool result 和新消息都保持顺序；stance、summary、current time 等变化频率更高的内容放在末尾动态区域。

### 3. 厂商 TTL 与本地刷新 TTL 是两层机制

本地 session snapshot TTL 设为 30 分钟，用于控制业务上下文重新读取；供应商 Prompt Cache 通常约 5 分钟自然过期。命中不会无限延长供应商缓存，超过供应商 TTL 后下一轮需要重新建立缓存，这是正常现象。

因此：

- 本地 30 分钟 TTL 不会替代供应商 5 分钟缓存。
- 5 分钟内持续对话时，稳定前缀可以持续命中。
- 间隔过长后，首轮低命中属于供应商缓存自然淘汰。

## 本轮实现调整

### 稳定 session snapshot

项目、日历、文件、memory 等低频变化内容在 session 开始或 TTL/压缩时刷新，普通对话轮次不重复全量加载。

session snapshot 使用稳定的结构和 hash，避免每个 run 生成不同的版本属性或额外 wrapper。

### 连续历史与压缩 baseline（P0–P1）

此前 runner/web 会按“最近 N 条”查询并再按 token 预算裁剪。随着会话增长，窗口边界会在不同 run 之间滑动，即使前面的 system 和历史大部分相同，也会从历史第一条开始失去缓存前缀。

现已改为：

- 未压缩会话按 `conversation_messages.id` 正序读取完整历史，不再使用滑动的 `LIMIT` 或 newest-first 裁剪；
- `ConversationSession.baseline_message_id` 记录最近一次压缩已经覆盖到的消息水位；
- 压缩后旧消息仍保留在数据库，下一轮只读取 baseline 之后的新消息，并保留唯一的 summary 行；
- `baseline_message_hash` 用于记录压缩边界身份，便于后续诊断历史是否被错误重算；
- Web、IM collect、IM stream 三条入口共用同一个 session history loader，避免 run/入口之间出现不同历史窗口。

这样只有真正新增的消息进入前缀尾部；压缩发生时才改变历史基线，而不是每一轮随着窗口滑动改变前缀。

### 增量动态区域

高频变化内容集中在消息尾部，主要包括：

- stance / 相处方式
- summary
- 当前时间
- 必要的 runtime context diff

动态区域和固定历史分离，固定前缀不因时间或 stance 小幅变化而整体失效。

### 历史消息时间统一

所有历史消息统一按 `sent_at` 格式化，避免同一组装链路同时出现不同时间格式，进而造成前缀变化或把内部时间结构泄漏给模型。

### Provider cache 标记

缓存标记按 provider 能力处理：

- Anthropic/MiniMax 路径保留可用的主动缓存标记。
- OpenAI 兼容路径根据 provider 能力应用历史区域缓存策略。
- 字符串内容统一转成合法 text block 后再附加缓存控制字段，修复了 `dict(content)` 导致的 `ValueError`。

## 实测结果

### Kimi

连续多轮测试中，大多数轮次达到 80% 以上 cache。一次重点样本：

```text
run-a0a7c3a…603d
run-3340c4f…0f78
run-c9b0a99…9ff0
run-c1e1e75…c785
run-4399843…10db
run-b11ee0f…4e87  ← 约 52%，异常轮
run-32340de…9e04
run-7ef71b6…cc93
```

分析结论：异常轮不是固定性失败，其他轮次仍保持高命中，说明该轮发生了输入前缀变化或超过了供应商 TTL，需要对该轮 input 做结构 diff，而不是调整模型参数。

### Qwen

早期多轮约 43% 命中；完成固定区域、动态尾部和 message 顺序调整后，新的三轮测试中后两轮达到 98% 以上 cache。

这证明稳定前缀策略对 OpenAI 兼容模型同样有效，不只适用于 Anthropic 格式。

### MiniMax

当前没有完成完整复测。测试期间 MiniMax Token Plan 达到用量上限，后续需要在额度恢复后按相同 session 连续测试，并重点记录：

- `input_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- round 1 与后续 round 的结构 diff

## 低命中样本的分类

后续排查低命中时，应优先按以下顺序判断：

1. 对比相邻 run 的 `system_prompt`、session info、history/messages、dynamic tail 四个区域。
2. 检查是否发生了 system reminder 的全量重建，而不是尾部 diff。
3. 检查是否切换了 provider、模型或 API 格式。
4. 检查两轮间隔是否超过供应商缓存 TTL。
5. 检查 devserver 是否运行了旧 worker、旧 Python bytecode 或未同步的工作树。
6. 最后才考虑模型侧缓存策略差异。

## 验证与回归

本轮同时补充了以下回归保护：

- session snapshot 与 TTL 相关测试。
- 连续历史 loader 的顺序、baseline 水位和 summary 保留测试。
- 压缩后 baseline 水位写入与后续增量读取回归测试。
- provider cache capability 测试。
- stream sanitizer 测试，防止内部时间标记泄漏到模型输出。
- IM identity/context 组装测试。
- LoopScope wrapper 的 session 参数透传测试。
- 长上下文压缩路径的 `session_id` 传递测试。

## 当前遗留问题

### 低命中轮次仍需做自动 diff

目前主要依靠 LoopScope 手动查看 input。下一步可以在测试脚本中自动比较相邻 run 的：

```text
system digest
session info digest
history prefix digest
dynamic tail digest
```

输出第一个发生变化的 section 和变化 token 数，避免人工逐段检查。

### 动态区域还可以进一步分块

当前动态尾部已经比全量 system reminder 稳定，但 stance、summary、time 仍可以分别成为独立消息块，按变化频率从低到高排列：

```text
stance → summary → current time
```

这是可选优化，不应在没有 input diff 证据时直接扩大重构范围。

### 供应商 TTL 只能通过实测确认

文档中的 5 分钟是当前经验值，不应视为所有 provider 的固定协议。后续应按模型分别做间隔测试，记录 1、3、5、10 分钟后的命中变化。

## 最终结论

本轮调优的核心方向是正确的：**固定 session 前缀，连续追加 history/messages，把变化内容推到末尾，并让 provider 只对稳定区域复用缓存。**

Kimi 和 Qwen 的高命中实测已经证明架构有效。剩余低命中主要属于特定轮次的前缀漂移、供应商 TTL 淘汰或运行版本不同步，应通过自动化 input diff 继续收敛，而不是回到每轮全量刷新上下文的方案。
