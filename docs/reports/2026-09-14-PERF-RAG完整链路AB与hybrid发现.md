# PERF：RAG 完整召回链路 A/B 重放与 hybrid 混合检索延迟发现

> 日期：2026-09-14
> 环境：devserver（i7-6700 @ 3.4GHz）vs 本机（Apple M2），同一真实 owner 数据（21k 持久文档 / 64MB 快照 / 838 条记忆 / 20MB memory_vec.json）
> 方法：从 LoopScope collector 提取 5 个真实 run 的用户 query，构造 worker 协议级重放脚本，双机交替执行 `prepare_memory` + `unified_query`
> 主提交：重放所测代码为 `d265c8a6`（dedup 塌缩）与 `9613a2b4`（延迟落盘）

## 1. 五个真实 run 的 RAG 耗时（LoopScope span，生产链路）

| run | 时间 | run 总耗时 | **RAG 耗时** | 索引段 | memory 段 | 检索段 | fusion |
|---|---|---|---|---|---|---|---|
| run-d91e320… | 04:37:42 | 18.48s | **993ms** | 0 | 627ms | 355ms | hybrid-rrf |
| run-295b640… | 05:19:23 | 15.69s | **6,633ms** ❄️ | 5,613ms（恢复 4,530 + 同步 1,077） | 514ms | 481ms | hybrid-rrf |
| run-5d12fab… | 05:19:53 | 11.90s | **1,748ms** | 0 | 847ms | 868ms | hybrid-rrf |
| run-f3e0fc6… | 05:20:25 | 10.89s | **878ms** | 0 | 526ms | 316ms | hybrid-rrf |
| run-60c16b4… | 05:22:06 | 12.97s | **1,173ms** | 0 | 757ms | 383ms | hybrid-rrf |

要点：run 页的「大数字」（12.97s 等）是整 run 耗时（LLM 轮次 1.5–5.3s/轮为主）；run-295b640 是唯一冷启动（worker 空闲回收），5.6s 索引段被 10s 窗口吸收、未超时；五单全部 `completed`。

## 2. worker 侧重放 A/B（真实 query 重放，不含 Python 侧）

### 热态（每轮增量）

| query（真实用户消息） | Mac M2 | devserver i7-6700 |
|---|---|---|
| 「bm25的rag数据是哪里的？」 | 120 / 67ms | 178ms |
| 「具体数据是什么样的」 | 56ms | 139ms |
| 「有完整表格吗」 | 58ms | 168ms |
| 「端到端延迟数据是什么」 | 65ms | 170ms |
| **平均** | **73ms** | **166ms（2.3×）** |

分段（devserver）：prepare_memory ~80–102ms + unified_query ~58–88ms；Mac：33–54ms + 23–66ms。

### 冷启动

| | Mac M2 | devserver |
|---|---|---|
| 恢复 + 启动 | 2,396ms | 4,194ms（2.1×） |
| **合计** | **~2.4s** | **~4.4s** |

## 3. 关键发现：生产 ~1s 与重放 ~166ms 的差额 = hybrid 混合检索

重放最初只测出 73–190ms，与生产 878–1,748ms 差 4–10 倍。排查（05:19 窗口无写侧日志，排除排队）后定位：**这几个 run 的 fusion 已是 `hybrid-rrf`**（此前 09-02 全是 `bm25` + `embedding_disabled`）——embedding 混合检索已启用，重放脚本传空 `vector_version` 走的是纯 BM25 路径，两者不是同一条链路。

混合模式每轮比纯 BM25 多三件事：

| 额外工作 | 估计耗时 | 说明 |
|---|---|---|
| query 向量生成 | ~200–400ms | worker 向 embedding provider 发 HTTP（外部网络延迟） |
| memory_vec.json 全量加载 | ~150–250ms | **20MB 向量文件每次 prepare 全量 JSON.parse** |
| RRF 融合 + 向量解析（44 万键值对） | ~100ms | |

其中第 2 项与索引快照的 64MB JSON 是同一类问题（全量文本序列化 + 解析），解法同理：向量缓存增量化（按 vector_version + 增量键维护，只 parse 变更部分）。第 1 项可做短 TTL 的 query 向量缓存。

## 4. 结论

1. worker 侧计算 Mac 比 devserver 快 2.1–2.3×（恢复 2.4s vs 4.2s；热态 73ms vs 166ms），但绝对值都小——**迁移硬件的体感收益有限**。
2. 生产热态 ~1s 的构成 = worker 计算 ~150ms + query 向量外部调用 ~200–400ms + 20MB 向量解析 ~200ms + Python 调度/回连剩余。**下一个值得做的优化是向量缓存增量化**（同时利好冷热），query 向量缓存次之。
3. hybrid-rrf 是功能变重（召回质量换延迟），不是性能退化；对比延迟时必须区分 fusion 模式——**重放/基准必须带上与生产一致的 `vector_version`**，否则测的不是同一条链路（本次方法论教训）。
4. 数据安全：真实快照与记忆副本仅存于受控目录（Mac `~/.gugu-rag-bench`，0700），`/tmp` 中的非脱敏副本与凭据文件已全部删除。
