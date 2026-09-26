# SESSION 388 压缩触发与追加前缀 A/B

## 问题与修复

MiniMax-M3 BYOK 的上下文上限为 128,000 tokens，90% 触发线为 115,200。主 run 最近一次 provider 输入为 81,515 tokens，尚未触线；反思预检使用本地估算约 118,088 tokens，错误触发了压缩。修复后，同进程反思快照携带最近一轮 provider 实际 `context_input`，反思预检据此判断；缺少实际用量的重启接管和静默群路径仍使用估算。

压缩缓存前缀此前因纯文本在主请求中为单个 text block、数据库回放中为字符串而无法对齐。修复允许这两种纯文本表示等价，仍严格校验消息角色、其他字段及工具块；按主会话的 `(created_at, id)` 顺序回放，只校验待压缩前缀。截点落在无法对齐的工具轮次时，最多前退七条消息，将其留在未压缩尾部。

## 复现与 A/B

使用同一会话的 MiniMax-M3 BYOK 模型配置和合成消息，不读取或输出会话正文，不写业务表或用量账本。运行仓库脚本：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/test_cache_strategy_compare.py \
  --allow-real-llm --compaction-ab --session-id 388
```

| 请求 | fresh input | cache read | 总 input | 缓存命中率 |
| --- | ---: | ---: | ---: | ---: |
| 主请求预热 | 57,966 | 128 | 58,094 | 0.22% |
| A：截断历史重放 | 38,658 | 128 | 38,786 | 0.33% |
| B：原前缀追加 | 110 | 57,984 | 58,094 | 99.81% |

另一次合成对照中，A 命中 128 / 23,833（0.54%），B 命中 48,128 / 48,210（99.83%）。A/B 使用合成前缀，证明 provider 对完整追加结构的缓存行为，不代表所有真实会话都能达到该比例。

用保存的 SESSION 388 快照与持久化历史进行只读对照：旧版 `_snapshot_cache_prefix` 无法返回匹配前缀，修复版对已对齐的 101 条消息返回原始主请求前缀；旧版反思预检返回 `compacted`，修复版在实际 81,515 tokens 时返回 `not_needed`。回归用例覆盖 115,200 tokens 恰好触线、压缩后避免重复触发，以及工具块不被纯文本等价规则放宽。

## 验证边界

devserver 的 Mutagen `gugu-web` 会话在本次验证期间处于暂停状态。本次真实 A/B 仅在 devserver `/tmp` 执行诊断脚本，修复文件仅在临时目录做只读对照，运行服务尚未应用修复。因此目前不能用新的自然流量 LoopScope 记录确认 SESSION 388 的压缩命中率；同步和服务更新后需观察 `snapshot-prefix` 模式、压缩前一轮 `context_input` 与压缩请求的 cache-read/fresh-input。
