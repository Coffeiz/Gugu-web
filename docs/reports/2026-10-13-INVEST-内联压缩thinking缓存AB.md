# INVEST：内联压缩丢失原生 thinking 前缀

> 排查日期：2026-10-13
> 排查环境：本地测试环境、devserver
> 排查对象：QQ 会话的 Anthropic 内联压缩分支
> 排查目的：修复压缩分支重建 canonical history 时丢失 Provider 原生 thinking/signature 的问题，并用真实 Provider usage 做 A/B

---

## 结论

`compact_context()` 原先每次都从 `MessageArea.provider_projection()` 重新生成摘要输入。主请求通过 Anthropic driver 恢复的原生 thinking/signature 只存在于不可变 Provider 投影中，不在 canonical Area；压缩分支因此丢块，和主请求的缓存前缀发生差异。

现在只有当最近 Provider 投影的 Area revision、digest、entry count 和固定前缀边界都与当前 Area 完全一致时，压缩才复用该 wire 投影。检查未通过时仍使用 canonical renderer，避免用过期快照压缩。

## 真实 A/B

使用 devserver 上既有 QQ 历史和 MiniMax-M3.1-Flash-Preview / Anthropic 路由，在内存 Area 副本上比较两种压缩路径。A、B 各自使用随机隔离 system 标记，先以相同真实主请求前缀预热，再串行发送同一压缩分支请求；报告只记录 provider usage 和结构摘要，不含会话正文。

缓存率按 `cache_read / (fresh_input + cache_read + cache_write)` 计算：

| 路径 | 预热完整输入 | 预热缓存读取 | 压缩完整输入 | 压缩缓存读取 | 压缩缓存率 | Provider 结果 |
|---|---:|---:|---:|---:|---:|---|
| A canonical 重建 | 81,044 | 128 | 81,105 | 71,808 | 88.5371% | 成功，压缩生效 |
| B 复用 wire 投影 | 81,043 | 188 | 81,827 | 81,041 | 99.0394% | 成功，压缩生效 |

B 比 A 多命中 9,233 tokens，缓存率提升 10.50 个百分点。两臂都接受了 Provider 请求；本次隔离 A/B 没有重现早先的 400 或精确的 0.1% 缓存率。另一轮共享预热的试跑中两臂都接近 100%，说明 A/B 必须隔离缓存前缀，不能把共享预热后的结果当作差异结论。

### 适用边界

历史 continuation 状态的 provider、model、协议及 reasoning 配置与当前请求一致，但其整体配置指纹不同，因此该实验显式使用 `--allow-config-fingerprint-mismatch` 回放历史签名块。两臂使用相同的当前 system、工具声明和历史；Provider 接受了两臂请求。这个结果验证了实际历史签名块被压缩路径保留时的缓存差异，不代表当前配置会恢复这条旧 continuation 状态。要无覆盖开关地重做，应使用配置指纹匹配的新鲜 run。

会话 baseline 仍为 `249127`；摘要最大 id/时间、压缩用量账本最大 id，以及 reasoning 状态版本/更新时间在实验后未变。诊断没有绑定 usage context、执行工具、提交摘要或写回会话。

### Responses 协议压缩补测

原始 A/B 只覆盖 QQ 会话的 Anthropic 内联压缩；此前的“三协议续接缓存全矩阵”测的是反思分支，不能代替 Responses 压缩验证。现追加一次 devserver MiniMax Responses 实际压缩 A/B：在进程内将模型配置副本切到 Responses，先由真实模型生成一条 reasoning item，再把它放入 74 条合成历史投影，分别执行 canonical 重建和复用 wire 投影。每臂用独立 system 标记预热，输入不含真实会话内容；没有数据库读写、工具派发或用户配置修改。

| 路径 | 预热缓存读取 / 输入 | 压缩分支 reasoning item 数 | 压缩缓存读取 / 输入 | 压缩缓存率 | 压缩结果 |
|---|---:|---:|---:|---:|---|
| A canonical 重建 | 0 / 20,768 | 0 | 0 / 21,037 | 0.00% | 成功 |
| B 复用 wire 投影 | 189 / 20,768 | 1 | 20,758 / 21,542 | 96.36% | 成功 |

这次补测说明 Responses 的真实 reasoning item 可随有效 wire 投影进入压缩分支，且本次供应商调用成功并命中前缀缓存。每臂只有一轮，缓存率是单次观测；reasoning item 来自本次真实 seed 请求，但历史为合成数据，因此不证明数据库持久化 Responses continuation 的恢复路径。Anthropic 真实 QQ 历史压缩结果见上方主 A/B。

### Chat Completions 协议压缩补测

按“Chat 不测续接”的范围，使用 MiniMax Chat Completions 对 75 条合成历史执行无续接压缩 A/B。两臂均不含 reasoning item；只比较丢弃最近 wire projection 后重建与直接复用 projection。两边均成功压缩。单轮缓存率接近，未显示 canonical 路径引入新的前缀丢失；这项结果不覆盖 Chat 的续接能力。

| 路径 | 预热缓存读取 / 输入 | 分支 reasoning item 数 | 压缩缓存读取 / 输入 | 压缩缓存率 | 压缩结果 |
|---|---:|---:|---:|---:|---|
| A canonical 重建 | 128 / 20,539 | 0 | 20,480 / 21,313 | 96.09% | 成功 |
| B 复用 wire 投影 | 189 / 20,540 | 0 | 20,530 / 21,314 | 96.32% | 成功 |

每臂一轮且使用隔离 system 标记；输入为合成历史，没有数据库读写、工具派发或用户配置修改。

## 回归测试

- `tests/agent/context/test_compaction.py`：62 项通过。新增行为用例确保 revision/digest 匹配时保留 thinking/signature，Area 更新后则忽略旧投影并包含新消息。
- `tests/agent/context/test_reflection_snapshot.py`、`test_context_cache_boundaries.py`、`test_phase2_reasoning_drivers.py`、`test_anthropic_roundtrip.py`：92 项通过。
- 最后两项测试输出了现有 `pypinyin` 弃用警告；断言全部通过。

## 测试脚本

- 脚本：[`compare_inline_compaction_thinking.py`](../../backend/scripts/diagnostics/compare_inline_compaction_thinking.py)
- 在 devserver/backend 运行：

  ```bash
  PYTHONPATH=. .venv/bin/python scripts/diagnostics/compare_inline_compaction_thinking.py \
    --session-id <目标QQ会话ID> --allow-real-llm --allow-config-fingerprint-mismatch
  ```

- 原始脱敏统计由脚本输出到终端，本报告保存了结果；脚本不写结果文件。用于首次试跑的 `/tmp/compaction_thinking_ab.py` 已删除。
- 测试读取真实数据库历史与加密 reasoning 状态，并连接真实 Provider；脚本不提交数据库事务、不更新 usage context、不写会话/摘要/续接状态，也不派发工具。
