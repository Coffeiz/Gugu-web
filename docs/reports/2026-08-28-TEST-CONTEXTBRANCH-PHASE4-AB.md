# ContextBranch Phase 4 AB 测试报告（脱敏）

日期：2026-08-28
环境：devserver（当前模型预设；只读快照，不写回数据库）
目的：对比迁移前的 provider 直连反思路径与 `ContextBranch` 路径在反思、压缩分支中的输入稳定性、耗时和输出效果。迁移前实现未作为工作树代码保留，但可由 Git `HEAD` 复原；本次已在 devserver 独立 detached worktree 中直接运行 Git `HEAD` 的旧 `complete_json`，主工作树未修改。

补测：2026-08-28 使用当前 devserver MiniMax-M3 预设，对反思分支直接读取 provider 原始 usage，验证缓存字段。

## 测试前提

- 从 devserver 抽取 3 个真实会话的最近 120 条消息作为快照，脱敏标识为 S388、S386、S511；覆盖 web、群聊和长会话场景。
- 每个快照分别执行 reflection 与 compaction；同一分支先跑旧实现，再跑 ContextBranch。
- 两种实现使用相同 system prompt、相同 delta、相同 devserver 模型预设和 max_tokens；不触发任何 writer、RAG 索引或主 session 更新。
- `ContextBranch` 的 scope/revision 仅用于审计，不进入 provider user 正文。

## 结果

|快照|分支|旧实现耗时|ContextBranch耗时|输入指纹一致|输入字符|旧输出字符|新输出字符|
|---:|---|---:|---:|---|---:|---:|---:|
|S388|reflection|3844.5 ms|4155.5 ms|是|1348|452|458|
|S388|compaction|14552.2 ms|15265.5 ms|是|6747|1386|1456|
|S386|reflection|13659.3 ms|4140.5 ms|是|474|571|535|
|S386|compaction|8979.7 ms|9410.5 ms|是|3832|1138|1175|
|S511|reflection|4297.9 ms|3084.1 ms|是|801|453|446|
|S511|compaction|8649.6 ms|16207.6 ms|是|5902|1392|1394|

## 结论

1. 六组对照的输入 fingerprint 全部一致，证明 scope/revision 不会污染 provider 正文；跨 run 的前缀缓存条件保持不变。
2. 新旧路径输出长度接近，均完成有效的反思/压缩；语义差异来自模型采样和调用时延，不是组装顺序变化。
3. 初始 A/B 脚本未保存 provider usage，因此当时只能以 fingerprint 判断缓存等价；补测已直接读取原始 usage，确认 MiniMax-M3 返回 `cache_read_input_tokens`，详见下节。
4. ContextBranch 统一了 Knowledge、owner、group、member 的失败分类、attempts 与 scope revision 审计，且不改变领域 writer 和主 history。

## 回归与验收

- `scope`/`scope_revision` 只写 metadata，不写模型正文。
- provider error、空输出、非法 JSON 均由统一 `return_reason` 分类。
- 旧实现与新实现的 system+delta fingerprint 相同。
- 本报告不包含用户正文、昵称、平台 ID 或凭据。

## 反思缓存补测

本次旧策略使用原 provider 直连；新策略使用 `ContextBranch`，两者使用相同 `system + user` 正文。MiniMax-M3 的原始 usage 确实返回了 `cache_read_input_tokens`，说明此前报告只能依赖 fingerprint 的判断过于保守。

|快照|旧策略 cache_read|ContextBranch cache_read|输入 token（旧/新）|输入 fingerprint|
|---:|---:|---:|---:|---|
|S388|9207|9207|1 / 1|256bdf5510d5103b|
|S386|4096|4096|99 / 99|35a6e61cba41b238|
|S511|14080|14080|49 / 38|fc04bbe4ed4ac622|

说明：provider 将命中部分单独计入 `cache_read_input_tokens`，所以 `input_tokens` 是未命中部分，不能单独当作总输入。三组补测均返回缓存读取；旧策略与 ContextBranch 的 cache_read 完全一致。S511 的未命中 token 存在 11 token 差异，但完整正文 fingerprint 相同，属于 provider 侧 token 统计口径差异，不是组装变化。

## 精确旧实现复测

为避免“等价 provider 直连”与真实旧代码混淆，另外使用 Git `HEAD` detached worktree 执行旧版 `agent.memory._llm.complete_json`，使用同一批快照和当前 MiniMax 预设。旧 helper 本身不暴露 provider usage，因此缓存字段仍由上一节的原始 provider 旁路请求核验；该临时 worktree 与脚本均已删除。

|快照|旧实现耗时|输入字符|输入指纹|输出字符|结果非空|
|---:|---:|---:|---|---:|---|
|S388|3814.2 ms|19899|a2c13d17f535c8ee|392|是|
|S386|7464.0 ms|1706|92571510824facef|397|是|
|S511|4293.8 ms|34004|517fea6a3ad7ed72|520|是|

这组结果确认了旧代码路径可以在不干扰当前仓库和服务的情况下复现；由于模型请求存在正常波动，耗时仅用于量级参考，不作为性能基准。
