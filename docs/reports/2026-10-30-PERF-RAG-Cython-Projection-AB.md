# 真实 RAG 来源投影差分报告

## 范围与安全边界

在已授权的单用户 devserver 数据上，以只读方式读取八类 canonical source records，分别调用 TS worker 的 `adapt` 与 Cython `project_source_records`。仅在进程内处理正文；TS index 目录使用临时目录。没有写入业务数据库、持久 RAG 索引、向量缓存或仓库用户配置。报告不保留账号、记录 ID、标题和正文。

比较口径为 TS wire 文档经现有 `wire_document_to_persistent` 规范化后的 `IndexDocument`，与 Cython 输出逐条比较顺序及全部 dataclass 字段。耗时不是严格同层基准：TS 时间含 JSONL worker 往返，Cython 时间为进程内 projection，主要验收结果一致性。

## 结果

| 来源 | 输入记录 | TS 文档 | Cython 文档 | 字段/顺序差异 | TS adapt | Cython projection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| calendar | 76 | 76 | 76 | 0 | 4.78 ms | 2.17 ms |
| canvas | 80 | 80 | 80 | 0 | 5.77 ms | 2.91 ms |
| conversation | 4,055 | 4,369 | 4,369 | 0 | 802.33 ms | 234.15 ms |
| knowledge | 263 | 458 | 458 | 0 | 92.94 ms | 36.52 ms |
| memory | 2,430 | 2,438 | 2,438 | 0 | 501.99 ms | 73.40 ms |
| note | 73 | 81 | 81 | 0 | 8.18 ms | 5.03 ms |
| project | 59 | 59 | 59 | 0 | 7.34 ms | 2.13 ms |
| scheduled_task | 36 | 38 | 38 | 0 | 4.07 ms | 2.00 ms |
| **合计** | **7,072** | **7,599** | **7,599** | **0** | — | — |

**结论：真实记录上的 source projection 输出顺序、文档数量及全部持久字段精确一致。** 对 Cython 投影额外包含 TS IPC 的耗时，不据此计算或宣称端到端加速。

## 对迁移的影响

- 为“真实来源 projection 与 TS adapt 行为等价”提供了八类来源的全量单用户证据，可纳入 shadow A/B 的来源准备阶段。
- 生产 `records_to_write_documents()` 仍连接 TS worker，尚未切换；此报告不是生产切流授权，也不验证多用户并发/异常重试。
- 仍需补齐其他 operation 的协议错误/异常状态矩阵，真实向量缓存/在线 query embedding 路径，以及固定条件下的 RSS 复测。
- 不改变现有 TS sidecar 生产路径，TS 删除和最终切换保持未执行。
