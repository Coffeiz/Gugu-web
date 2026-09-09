# 后端诊断脚本

这里保存需要真实 provider、网络或人工观察的诊断脚本，不属于 pytest 回归套件，也不会在 CI 中自动调用。

稳定行为必须补到 `backend/tests/`；本目录脚本只用于复测缓存、provider 响应和历史链路问题。运行前请确认本地配置，不要把密钥、用户输入或完整模型响应写入日志。

## RAG 查询信息量感知软重排离线对照

`rag_field_rescore_probe.ts` 支持 RAG 诊断 JSON 和 LoopScope `loopscope-run-export`，对比当前排序与查询信息量感知 soft-rescore。它会复用 TS `tokenizeRaw`，使用完整索引 IDF 找出本次 query 的高信息 token，再对候选全文计算覆盖率；不会调用生产 RAG、写索引或修改运行配置。

LoopScope 原始 run 导出只包含已经注入模型的召回正文，通常不含候选的 BM25/conf。传入对应的完整 TS 索引后，脚本会按 `source_type + title` 将候选对回索引并重算 BM25；conf 不会伪造，报告会明确标记为缺失。无法对回索引的候选使用注入排名 `1/rank` 代理分，仅用于观察重排因子，不可与生产分数直接比较。

脚本会读取真实候选正文，默认必须显式传入 `--allow-real-data`。输出应留在被 gitignore 的 `backend/scripts/diagnostics/local/`：

```bash
node --experimental-strip-types \
  backend/scripts/diagnostics/rag_field_rescore_probe.ts \
  --allow-real-data \
  --input backend/scripts/diagnostics/local/<rag-run>.json \
  --index-json <storage.local_path>/<user-id>/.system/rag/ts-index/<owner-hash>/index.json \
  --include-content
```

LoopScope run 导出示例：

```bash
node --experimental-strip-types \
  backend/scripts/diagnostics/rag_field_rescore_probe.ts \
  --allow-real-data \
  --input /path/to/loopscope-runs.json \
  --index-json /path/to/ts-index/index.json \
  --include-content
```

传入 `--index-json` 时，脚本会读取 TS RAG 持久化索引里的全部 `documents`，用同一套 `tokenizeRaw` 按文档去重统计完整 `documentFrequency`，报告标记为 `full_ts_index`，并记录索引版本、revision 和文档数。`df=0` 的未知 token 不参与高信息词筛选，避免把 OOV 词误判成高 IDF 词。这里的 `index.json` 是只读输入，不会写回索引。

生产路径中的 `<owner-hash>` 是 `sha256(owner_user_id)[:32]`；索引目录由 `backend/agent/rag/ts_sidecar.py` 的 `index_dir_for_owner()` 决定。

不传 `--index-json` 时，报告会明确标记为 `candidate_corpus_proxy`：仅根据导出候选集估算 IDF，只适合快速比较，不能替代完整索引 IDF。
