# OPT-RAG：约 1.9 万篇 RAG 三阶段 Python/TS A/B 测试报告

> 测试日期：2026-09-12
> 测试环境：devserver `192.168.110.51`，现有数据库与本地 Storage
> 测试对象：RAG 全量 worker replace、`index_cache_get`、Memory 来源加载
> 测试目的：对照现行 Python 路径与 TS 候选路径的耗时，并验证 Memory 文档投影一致性
> 数据保护：使用真实数据库和 Storage 只读数据；不记录 owner 标识、正文、标题、文件名或凭据

---

## 1. 结论

本轮在同一 devserver、同一数据窗口各运行 3 轮。最终数据集有 19,082 条有效索引记录。

- 全量 worker replace：Python 中位数 `5,018.79ms`，TS 候选 `4,783.14ms`，低约 `4.7%`。这是小幅优势，尚不足以单独证明整体迁移收益。
- 冷 `index_cache_get`：Python `7,113.59ms`，TS 候选 `5,364.90ms`，低约 `24.6%`。但 TS 候选没有加载持久向量缓存，阶段范围不等价，不能将该差值当作完整链路的确定收益。
- Memory 来源加载：Python 单次 `3,826.35ms`；TS canonical 路径冷加载中位数 `11.38ms`。两边都是 688 个 chunk，identity、version、text、scope 四类签名全部一致。就本次测量口径看，TS 候选约快 `99.7%`。
- 数据中发现 1 组重复 worker key、多出 1 条记录。它可能使 `documentsById` 中同 key 的文档覆盖，但不会从 worker 的文档数组和倒排 posting 中自动消失；应单独排查其来源与召回影响。

这次结果支持继续验证 TS 路径，但**不等于已经完成迁移或确认可以替换生产实现**。优先补齐 TS `index_cache_get` 的向量加载步骤，并单独查清重复 key。

随后以 **Python 先、TS 后** 的相反顺序各运行两轮复测，19,082 条索引数和 Memory 的 688 条 canonical 文档及四类签名仍一致；相对同轮 Python，三个 TS 阶段分别低 `9.4%`、`20.5%`、`99.6%`。反序复测没有改变方向，但轮数较少、阶段口径限制仍然存在。

## 2. 测试设计与范围

测试脚本自动挑选有效索引记录数接近 19,000 的 owner；报告不保留其标识。Python 与 TS 按顺序在同一数据窗口读取同一索引数据，每个可重复阶段运行 3 轮，统计中位数。

### 2.1 全量 worker replace

- Python：现行 `KnowledgeIndexCache.get(..., force=True)` 路径，统计 `TsSidecarClient.replace` 耗时。
- TS：从数据库读取索引行并转换为 worker 文档，在独立临时 worker 中执行 replace；每轮启动独立 worker。
- 两侧有效索引条数均为 19,082。此阶段可用于粗略比较，但没有逐文档比较全部索引 payload。

### 2.2 `index_cache_get`

- Python：实际调用现行 `KnowledgeIndexCache.get(..., force=True)`，并在每轮后清空缓存、关闭 lexical client。
- TS：查询 revision、读取索引正文行、映射为 worker 文档，再在临时 worker 中 replace。
- **口径差异：**TS 候选没有读取/装载持久向量表；Python 路径可能包含持久向量加载。因此 TS 结果是当前 TS 实现流程的局部模拟，不能视为同范围端到端 A/B。

### 2.3 Memory 来源加载

- Python：调用现行 `_memory_recall_documents`，完成 Memory 来源读取与 canonical 文档生成；本项只测 1 次，不是多轮中位数。
- TS 原始文件读：读取 `loadMemoryCached` 所需 Storage 来源；该数据只用于显示单纯文件读取成本，**不与 Python 完整加载流程比较**。
- TS canonical：读取持久 Memory 索引并合并新鲜 daily 来源，生成 canonical chunk；执行 3 轮冷加载和 1 次缓存命中。
- 对 Python 与 TS canonical 结果比较数量及 identity、version、text、scope 四类 SHA-256 签名；本轮全部匹配。

## 3. 脱敏结果

以下为脚本最终 JSON 输出中的脱敏统计字段。脚本未将原始 stdout 另存为远端文件；此处作为本次可追溯的结构化结果记录。

```json
{
  "dataset": {
    "active_index_chunks": 19082,
    "duplicate_worker_key_groups": 1,
    "duplicate_worker_key_extra_rows": 1
  },
  "iterations": 3,
  "python_current": {
    "full_replace_worker_ms_median": 5018.79,
    "index_cache_get_ms_median": 7113.59,
    "memory_source_load_ms": 3826.35,
    "index_chunks": 19082,
    "memory_chunks": 688,
    "memory_storage_writes": "disabled"
  },
  "typescript_candidate": {
    "full_replace_ms_median": 4783.14,
    "index_cache_get_cold_ms_median": 5364.9,
    "memory_raw_file_load_cold_ms_median": 3.15,
    "memory_raw_file_load_warm_ms": 0.03,
    "memory_canonical_load_cold_ms_median": 11.38,
    "memory_canonical_load_warm_ms": 0.01,
    "index_chunks": 19082,
    "memory_records": 5,
    "memory_canonical_chunks": 688,
    "memory_canonical_source": "persistent_index",
    "memory_canonical_count_matches_python": true,
    "memory_canonical_signature_matches_python": {
      "identity": true,
      "version": true,
      "text": true,
      "scope": true
    },
    "full_replace_effective_indexed_chunks": 19082
  },
  "ab_delta_percent_vs_python_current": {
    "full_replace_worker": -4.7,
    "index_cache_get_cold": -24.6,
    "memory_load": -99.7
  },
  "supplied_baseline_ms": {
    "replace": 7150,
    "index_cache_get": 8920,
    "memory_load": 4260
  }
}
```

用户此前提供的历史耗时为全量替换 `7,150ms`、`index_cache_get` `8,920ms`、Memory `4,260ms`。本次同一轮 Python 实测分别为 `5,018.79ms`、`7,113.59ms`、`3,826.35ms`，并未复现历史基线；由于运行窗口、缓存状态和计时范围可能不同，本文只用同轮 Python 值计算 A/B 差值，不把 TS 数字直接与历史值作性能结论。

## 4. 测试限制与解释

1. `index_cache_get` 的 `-24.6%` 不是完整等价比较：TS 计时含 revision 查询、完整正文行读取/映射和临时 worker replace，但不含持久向量表加载。应补上该环节后再判断完整链路收益。
2. Memory 的 `3.15ms` 仅表示 TS Storage 来源读取，不代表完整来源加载；可用于观察读取开销，不能与 Python `3,826.35ms` 直接对比。更合适的 TS 对照是 `11.38ms` canonical 冷加载，并且本轮四类签名、chunk 数均匹配。
3. 全量 replace 差距只有约 `4.7%`。两边都对约 19,082 条数据执行 worker replace，但尚未做逐文档 payload 哈希核对，也没有修复重复 key 后复测。
4. 最终数据集有 1 组重复 worker key。TS worker 会将文档追加到数组和 postings，同时在 `documentsById` Map 中按 id 写入；同 id 后写记录可能覆盖 Map 值。该数据形态可能影响按 id 删除、增量 patch 与检索计数，需追溯源记录后再决定修复策略。
5. Python 与 TS 的 Memory 字段签名一致是本次样本的正确性证据，不代表其他 owner、来源类型或增量变更场景已全面等价。

## 5. 数据安全与副作用

- 连接真实 devserver 数据库并读取真实索引数据；读取 Storage 中 Memory 文件/持久索引。未调用真实 LLM/provider。
- Python 基线显式禁用 `PersistentMemoryIndex.replace`，并将 Storage `.put` 替换为拒绝写入的函数；Storage 写入字段报告为 `disabled`。
- TS/Python worker 索引目录使用独立临时目录，不触碰正式索引目录。脚本执行后检查到匹配的临时目录数量为 `0`。
- 未修改数据库、Memory 文件、正式向量索引或服务配置；未重启服务。
- 报告只保留耗时、数量、签名相等布尔值及重复 key 计数，不含签名原文、owner id、正文、标题、文件名或凭据。

## 6. 测试脚本与复现

脚本：[`rag-three-stage-ab.ts`](../../backend/ts/scripts/rag-three-stage-ab.ts)

devserver 运行时由 backend Python venv 调用 `get_settings()` 读取已有受保护配置，在进程内把数据库 URL 与 Storage 根目录传给 TS 子进程；实际值不打印、不写入命令记录。TS 入口参数为：

```bash
GUGU_STORAGE_BACKEND=local node --import tsx scripts/rag-three-stage-ab.ts --allow-real-data --rounds 3
```

脚本通过 `--allow-real-data` 显式确认使用真实数据；需要环境变量 `GUGU_DATABASE_URL`、`GUGU_STORAGE_ROOT`。未指定 owner 时脚本按索引记录数自动选择接近 19,000 条的 owner。敏感环境变量值不输出。

远端临时目录前缀为 `/tmp/gugu-rag-three-stage-ab-ts-*` 和 `/tmp/gugu-rag-three-stage-ab-py-*`，结束后已清理；未保留额外远端原始输出文件。本报告第 3 节保留脱敏结构化统计结果。

## 7. 顺序反转复测：Python 先、TS 后

在首轮 TS-first 三轮测试后，将执行顺序反转为 Python baseline 先完成，再执行 TS 候选；本轮两轮，中位数按两次耗时的平均值计算。仍使用同一 devserver 真实数据，自动选中数据规模接近 19,000 的 owner；没有重启服务或触碰正式索引。

| 阶段 | Python（2 轮） | TS（2 轮） | TS 相对变化 |
| --- | ---: | ---: | ---: |
| 全量 worker replace | 5,181.48ms | 4,692.72ms | -9.4% |
| 冷 `index_cache_get` | 6,921.64ms | 5,503.96ms | -20.5%* |
| Memory 来源加载 | 3,975.61ms（单次） | 16.22ms（canonical 冷加载中位数） | -99.6%** |

数据量仍为 19,082 条索引、688 个 Memory canonical chunk。Memory identity、version、text、scope 四类签名均与 Python 一致。重复 worker key 仍为 1 组、多出 1 条，尚未处理。

`*` TS `index_cache_get` 仍未包含持久向量表加载，不是完整等价链路。`**` Python Memory 只有一次计时，TS canonical 为两轮冷加载中位数；数值用于确认顺序反转后的方向，不应解释为严格统计显著性。

本轮脱敏结构化结果：

```json
{
  "dataset": {
    "active_index_chunks": 19082,
    "duplicate_worker_key_groups": 1,
    "duplicate_worker_key_extra_rows": 1
  },
  "iterations": 2,
  "execution_order": "python-first",
  "python_current": {
    "full_replace_worker_ms_median": 5181.48,
    "index_cache_get_ms_median": 6921.64,
    "memory_source_load_ms": 3975.61,
    "index_chunks": 19082,
    "memory_chunks": 688,
    "memory_storage_writes": "disabled"
  },
  "typescript_candidate": {
    "full_replace_ms_median": 4692.72,
    "index_cache_get_cold_ms_median": 5503.96,
    "memory_raw_file_load_cold_ms_median": 2.62,
    "memory_raw_file_load_warm_ms": 0.02,
    "memory_canonical_load_cold_ms_median": 16.22,
    "memory_canonical_load_warm_ms": 0.01,
    "index_chunks": 19082,
    "memory_records": 5,
    "memory_canonical_chunks": 688,
    "memory_canonical_source": "persistent_index",
    "memory_canonical_count_matches_python": true,
    "memory_canonical_signature_matches_python": {
      "identity": true,
      "version": true,
      "text": true,
      "scope": true
    },
    "full_replace_effective_indexed_chunks": 19082
  },
  "ab_delta_percent_vs_python_current": {
    "full_replace_worker": -9.4,
    "index_cache_get_cold": -20.5,
    "memory_load": -99.6
  },
  "execution_safety": {
    "memory_storage_writes": "disabled",
    "remaining_benchmark_temp_dirs": 0
  }
}
```

复现入口（运行目录为 devserver 仓库 `backend/ts`；执行器先从 backend 的受保护配置读取并注入 `GUGU_DATABASE_URL` 与 `GUGU_STORAGE_ROOT`，不输出变量值）：

```bash
GUGU_STORAGE_BACKEND=local node --import tsx scripts/rag-three-stage-ab.ts --allow-real-data --rounds 2 --order python-first
```

本轮 Python 与 TS worker 目录均使用 `/tmp/gugu-rag-three-stage-ab-{py,ts}-*` 私有临时目录，复测后检查剩余目录数为 `0`。没有保留额外的远端 stdout 文件；本节保存脱敏统计结果。

## 8. 后续建议

1. 为 TS `index_cache_get` 对照补入与 Python 相同的持久向量读取和传递步骤，再跑同一数据集的 A/B。
2. 定位重复 worker key 对应的来源类型与稳定键生成路径；确认是源数据重复、索引 chunk 构造重复还是合理的多版本记录。修复前避免直接丢弃记录。
3. 对全量 replace 增加按 source 类型和 chunk 数的 payload 一致性校验，避免只凭总数认定输入等价。
4. 若上述差异收敛后优势仍稳定，再扩大到多个 owner 和冷/热状态矩阵，作为 TS 接管决策依据。
