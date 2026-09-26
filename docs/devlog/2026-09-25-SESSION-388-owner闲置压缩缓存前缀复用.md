# SESSION #388 owner 闲置压缩 cache miss：同进程快照前缀复用

## 现象

2026-09-25 排查 BYOK MiniMax 会话 #388 的自动压缩用量。自动 idle reflection 相关压缩记录中，多次出现约 128 cache-read tokens、53k–84k fresh-input tokens；而同一会话 15:49 左右的一次 inline/context compaction 约有 105,223 cache-read、783 fresh-input，命中约 99.26%。用户没有手动触发压缩。

冷热和模型本身不足以解释这个差异：同会话内 inline 压缩有高命中，owner idle reflection 压缩则几乎全量 fresh，说明两条路径实际发出的前缀不同。

## 根因

inline compaction 复用当前 run 已组装的 provider history；owner idle reflection 则由 worker 根据数据库历史另行重建。`compact_for_reflection()` 之前只把快照用于上下文预算判断，摘要生成仍调用 `_generate_append_summary(history_messages, previous_summary)`，从 DB 拼出最小消息列表。它没有沿用原请求的静态 system、工具声明以及完全相同的 provider history 前缀，因此追加式压缩虽保留了摘要增量语义，却不等于追加在原对话缓存前缀之后。

这不是消息里的“现在时间”变成了历史消息，也不是主会话被改写。问题发生在 owner idle 压缩生成摘要时采用了 worker 重建路径。

## 修复

- 在接收对话请求的进程内预约 4 分 30 秒 idle drain；同一 session 新活动会重置预约。完整 reflection snapshot 仍只在该进程内使用。
- Redis 只存 owner/session 维度的短 TTL 协调标记，不传输快照或 prompt。worker 看到有效标记时暂缓接管；本地进程退出后标记自然过期，worker 仍可按原来的归属和 idle 检查从数据库重建。
- 压缩侧把待压缩 DB 行用与会话一致的 formatter 重建，再验证 model identity、连续行边界和序列化消息片段都精确匹配原快照。匹配成功才使用快照中相同的 provider prefix，并保留协议需要的 system/tools；不匹配就回退原 DB append 路径，不猜测边界。
- 不改主对话 history、压缩 baseline CAS、水位、反思消息范围或摘要落库语义；没有改变全局 provider cache policy。
- 并发取消路径保持 marker 所有权：本地 drain 已经运行时，不提前删除/弹出协调状态，避免 worker 抢跑或刷新任务重建标记。

## 验证

- 新增精确映射、映射失败回退、反思压缩复用原 system/tools 与 cutoff，以及本地 active drain marker 生命周期测试。
- 本地相关后端测试：`tests/test_reflection_threshold.py`、`tests/test_baseline_run_summary_reuse.py`、`tests/test_compaction.py`、`tests/test_reflection_append_reuse.py`、`tests/test_reflection_snapshot.py`、`tests/test_im_memory_scopes.py`，136 项通过；竞态回归补入后需再次确认最终总数。
- 尚未进行真实 BYOK MiniMax 请求，也没有宣称已验证线上 cache ratio。仓库既有 `test_cache_strategy_compare.py` 会直接调用配置中的真实模型并产生用量；本次为避免未经单独授权消耗真实 API 配额，没有运行。应在自然发生的 SESSION #388 idle compaction 后，用 LoopScope 对比 cache-read/fresh-input 和压缩模式。

## 后续观测

确认新的 owner idle compression 记录确实采用 `snapshot-prefix`，并对照同 session 主请求 cache prefix 的 cache-read、fresh-input、cache-write、output tokens。若快照缺失或逐条匹配失败，应能看到安全回退，而不是错误复用；缓存收益依 provider 缓存策略而定，不设置硬命中率承诺。
