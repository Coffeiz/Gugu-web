# Cython BM25 devserver 对照记录

## 范围

- 实验：2026-10-29，devserver，Python 3.12.3、Cython 3.3.0、系统 C 编译器。
- 数据：用户明确授权的单账号、8 个有效 RAG 来源；一次读取后固定同一份 7,758 个 canonical chunks，同时构建 TS 与 Cython 索引。
- 任务：40 个来自语料标题的查询，每个查询重复 3 次；使用生产 TS Worker tokenizer；Top-K=10。
- 隐私：账号 ID、来源标题、正文和 query 均未写入报告。TS 索引和 Cython 构建目录使用临时目录，未写入用户索引。

## 检索结果

| 指标 | TS RAG worker | Cython BM25 |
| --- | ---: | ---: |
| 搜索均值 | 2.7460 ms | 0.1081 ms |
| 搜索 P50 | 2.4102 ms | 0.1030 ms |
| 搜索 P95 | 4.6638 ms | 0.1582 ms |
| 目标来源 Hit@10 | 100% | 100% |

- Top-1 一致率：100%。
- Top-10 平均 Jaccard：1.0000（集合完全一致）。
- 本次观测的 TS/Cython 搜索耗时比：25.402×。
- 该比值不是纯算法内核加速：TS 计时含 JSONL 子进程请求/响应，Cython 计时是当前进程内核调用；它展示迁入进程内之后的词法调用潜力，不能直接外推到完整 Agent/RAG 请求。

## 准备和资源成本

| 阶段 | 耗时 |
| --- | ---: |
| 真实来源读取与 canonical projection | 17,276 ms |
| 临时 TS 索引构建 | 8,581 ms |
| 复用 TS tokenizer 处理语料 | 5,878 ms |
| Cython CSR 打包 | 804 ms |
| Cython 首次编译/导入 | 14,111 ms |

Python benchmark 进程峰值 RSS 为 683.64 MiB；TS worker 峰值 RSS 为 308.38 MiB。两者进程职责不同：Python 峰值包含来源读取后的 canonical 文档、tokenized 输入和 Cython CSR，TS worker 只含临时索引；因此这两个数字不是同口径内存比较。生产制品必须预编译，不能把约 14 秒首次开发编译计入生产启动路径。

基准数值输出后，进程以退出码 0 结束，但 Python asyncio 在 event loop 关闭后仍打印了 `BaseSubprocessTransport.__del__` 管道回收警告。指标已经完整产出且临时目录清理；该 benchmark 的 subprocess 生命周期诊断仍需后续收敛，不能把警告当作应用 RAG 故障或忽略为无影响的业务信号。

## 合成核验

同一 devserver 上另跑 4,000 文档、80 查询：Python 与 Cython 所有查询 Top-K 顺序完全一致，分数绝对/相对容差 `1e-12`；Cython 相对 Python map 为 8.61×，相对同 CSR 的 Python 内核为 20.23×。对照仓库 TS BM25 benchmark 的热查询均值为 0.1150 ms，Cython 为 0.0291 ms（约 3.95×，两者 benchmark 实现细节不同，仅作量级参考）。

## 结论与限制

这证明当前 Cython BM25 基础内核能在真实 canonical 数据和同一 TS 分词结果上复现 Top-K，并显示词法搜索的潜在延迟收益。它不覆盖 Hybrid/RRF、query embedding、confidence-v4、候选预算/多样性、Memory snapshot、权限复核、缓存生命周期或 Agent 注入，因此不是“完整 RAG 已等效”或“可删除 TS worker”的证据。

迁移仍须按 [PRD-RAG-11](../prds/PRD-RAG-11-Cython等效模块与TS-RAG迁移.md) 完成其余行为等价实现，再用固定真实 query set 做全链路 shadow A/B。当前标题派生任务偏向 lexical exact-match，后续评测需补充脱敏真实用户 query、难负例和多来源任务，但只在用户确认评测集范围后使用。

## 2026-10-30 真实语料复测与基准修正

在 7,599 个 canonical chunks 上，以 40 条真实文档标题派生 query、每条 3 轮对比 TS worker 与 Cython BM25。第一次复测发现 benchmark 自身的 conversation 投影错误：它用分块正文构建 Cython 侧索引，TS worker 则用完整 `context_current`；该轮 Top-10 Jaccard 0.8002、共同候选分数不一致，判为无效实验，不作为实现回归结论。修正脚本并增加针对性测试后重跑：

| 指标 | TS worker | Cython BM25 |
| --- | ---: | ---: |
| 搜索均值 | 1.4950 ms | 0.5674 ms |
| 搜索 P50 | 1.3038 ms | 0.4353 ms |
| 搜索 P95 | 2.9515 ms | 1.2201 ms |
| 目标来源 Hit@10 | 100% | 100% |

- 40/40 Top-1、Top-10 有序序列、Top-10 集合完全一致；共同候选分数不一致为 0，最大绝对分差为 0。
- 当前进程内热搜索均值约 2.635×；TS 仍通过 JSONL 子进程，Cython 为本进程内核调用，不能外推成完整 Agent 端到端加速。
- TS worker 峰值 RSS 为 332.25 MiB；benchmark Python 主进程峰值 RSS 为 687.76 MiB，包含 canonical 文档、TS/Cython tokenizer 返回值和 Cython CSR，职责范围不同，不能作为同口径内存比较。
- 本轮只覆盖真实 lexical BM25，不覆盖真实向量缓存、embedding provider、confidence 重排、候选注入或完整授权链。开发 Cython 依赖只安装在一次性临时目录，测试索引与扩展构建目录均为临时目录；未修改项目配置或用户数据。
- 基准退出码为 0 且完成临时目录清理，但 asyncio 仍打印 `BaseSubprocessTransport.__del__` event-loop-close 警告；这是基准 subprocess 资源回收问题，后续应收敛。
