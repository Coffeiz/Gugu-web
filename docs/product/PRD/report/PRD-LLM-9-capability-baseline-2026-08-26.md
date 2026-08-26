# Capability Phase 4/6 基线报告

日期：2026-08-26

## 本地注册与注入基线

使用 `backend/scripts/diagnostics/capability_baseline.py` 读取当前真实 Tool/Skill Registry，未连接数据库、未发起 LLM 请求：

| 指标 | 结果 |
|---|---:|
| 工具数 | 95 |
| Skill 数 | 10 |
| 短描述目录 | 2,889 字符 |
| 原生 OpenAI 全量 Schema | 67,510 字符 |
| 固定 Adapter Schema | 1,608 字符 |
| 目录构建平均耗时 | 0.035 ms |
| 目录构建 P95 | 0.061 ms |

固定 Adapter 的 Schema 前缀相较原生全量 Schema 减少约 97.6%。这组数据只说明注册与注入层的本地成本，不替代真实 Provider input/cache 指标。

## Phase 6 运行时验证

- 能力文档复用统一 `search_documents_with_cache()` 和 TypeScript RAG 索引缓存，不复制 BM25/Embedding。
- 推荐上限为 5；推荐结果只调整能力目录顺序，全部授权工具始终保留。
- 默认 `capability_rag_enabled=false`、`capability_rag_shadow=true`，可以先只观测，再显式打开排序影响。
- sidecar/索引失败时记录类型化诊断并保持完整授权目录，不影响工具执行主链路。
- 运行时推荐不注册 Provider 业务 Schema，不参与权限、确认门或 handler dispatch。

真实 Provider input tokens、cache ratio、推荐命中率和 P95 可通过 LoopScope 导出后执行：

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/diagnostics/capability_baseline.py --trace /path/to/loopscope-runs.json --json
```
