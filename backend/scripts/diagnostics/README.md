# 后端诊断脚本

这里保存需要真实 provider、网络或人工观察的诊断脚本，不属于 pytest 回归套件，也不会在 CI 中自动调用。

脚本名使用 `probe_*.py`、`compare_*.py` 或其他明确动作名，禁止使用 pytest 会识别的 `test_*.py`。需要验证纯规则或稳定用户行为时，应将合成输入及断言放入 `backend/tests/`；不要让主动诊断脚本承担回归门禁。

稳定行为必须补到 `backend/tests/`；本目录脚本只用于复测缓存、provider 响应和历史链路问题。运行前请确认本地配置，不要把密钥、用户输入或完整模型响应写入日志。

## RAG confidence 分数探针

`rag_confidence_probe.py` 复用 `rag_quality_retest.py` 的真实只读召回链路，
但同时输出两种视图：

- 当前 `confidence` 模式的实际入选结果，以及 `0.35` / `0.55` 阈值统计；
- `top_k` 观察模式下同一候选池按 `rank_score` 排序、不过滤 confidence 的前 k 条，包含 `raw_score`、`fused_score`、`rank_score`、
  `confidence`、`source_quality` 和 confidence 区间。

这样可以区分“排序分高”与“confidence 通过过滤”，不会把 `rank_score` 当成
事实置信度。默认输出来源指纹；需要查看真实标题/正文时显式传入
`--full-report`，报告应写入被 gitignore 的 `backend/scripts/diagnostics/local/`：

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/diagnostics/rag_confidence_probe.py \
  --user <user-id> \
  --query "gpt6大概多少参数量" \
  --query "蒙扎的T6叫什么" \
  --top-k 10 --candidate-limit 20 \
  --full-report scripts/diagnostics/local/rag-confidence.md
```

不传 `--query` 时沿用 `rag_quality_retest.py` 的内置查询集；该脚本不写数据库、
不更新索引，也不改变线上 confidence 选择逻辑。

如果要复现某次 LoopScope run，使用 `--run`。脚本会保留 run 中每个带
`[owner-rag]` 的原始 query、对话原文和已注入召回；逐条 conf 则用该 run 的
用户 ID、原始 query 对当前 Cython 索引只读重跑。由于历史 RAG span 只保存聚合
质量统计，报告会明确区分“历史原始召回”和“当前 conf 重跑结果”：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/rag_confidence_probe.py \
  --run /path/to/loopscope-runs.json \
  --top-k 10 --candidate-limit 20 \
  --full-report scripts/diagnostics/local/loopscope-confidence.md
```
