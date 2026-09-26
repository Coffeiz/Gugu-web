# 缓存策略诊断：SESSION #388 owner idle compaction

## 范围

本次不是调整 provider 的缓存控制策略，而是修正自动 idle reflection 触发压缩时，生成摘要的请求前缀与主会话不一致的问题。

## 基线证据

- SESSION #388 owner idle reflection 压缩：多条记录约 128 cache-read tokens、53k–84k fresh-input tokens。
- 同 session inline/context compaction：约 105,223 cache-read、783 fresh-input，缓存命中约 99.26%。
- 差异与执行路径吻合：inline compaction 使用当前 run 的 provider history；owner idle compaction 原先用 worker 从数据库重建最小 history，没有复用原静态 system/tools/provider prefix。

## 改动假设

将 idle drain 优先放回仍持有主请求快照的进程内执行，并仅在模型身份、连续持久化行及序列化 history 可逐条精确匹配时沿用原快照前缀。跨进程 worker fallback 不持有完整快照；它仅在本地标记缺失/过期后执行旧的安全 DB 重建路径。

预期是使匹配成功的 idle compression 请求前缀与主会话稳定前缀一致。缓存是否命中仍由 provider、模型、缓存 TTL 和实际请求共同决定；不据此承诺固定比例。

## 验证状态

- 合成单元测试覆盖精确前缀、错配回退、system/tools 传递和 active drain 协调标记。
- 未运行 `backend/scripts/diagnostics/test_cache_strategy_compare.py`：它读取运行配置并向真实 MiniMax endpoint 发请求，可能产生费用；此次授权是修复实现，并未单独授权真实模型探针。
- 待自然会话运行后，在 LoopScope 检查 `snapshot-prefix`/`append-replay` 路径以及 cache-read、fresh-input、cache-write、output token 数据。
