# Gugu 统一 RAG 规范

本文说明 Agent 侧统一 RAG 的数据边界、索引生命周期和维护方式。RAG 索引是由业务数据派生出的可重建投影，不是业务数据的事实来源。

## 1. 架构边界

```text
业务主数据 / Knowledge Markdown / Memory
              │
              │ 成功写入后发布索引事件
              ▼
        Python 来源适配器
              │ 生成已授权、未切块的 source record
              ▼
        TS canonical projection
              │ 文本组装、切块、版本、wire document
              ▼
   knowledge_index_entries（统一持久投影）
              │
              │ 召回时加载并发送给 TS worker
              ▼
  TS RAG worker（BM25、词法召回、融合、排序）
              │
              ▼
 Python scope/owner 校验 + 正文回填 + 注入上下文
```

职责划分如下：

- 业务表、Knowledge 文件和 Memory 存储保存事实数据。
- Python 负责业务主数据读取、权限边界、source record、持久化事务和正文回填。
- TS worker 是唯一的索引投影实现，负责来源文本组装、分块、版本、wire document、BM25、融合和排序。
- `knowledge_index_entries` 只保存可重建的统一索引文档；不能把它当作业务主表使用。
- TS worker 负责来源 projection、Jieba 分词、BM25、候选召回、向量融合和候选排序，不访问数据库、不判断用户权限、不输出未授权正文。
- 最终召回结果必须经过 Python 的 owner/scope 校验；TS 返回的分数不能替代权限判断。

## 2. 来源与映射

当前统一索引来源：

| `source_type` | 业务来源 | 变更资源 | 说明 |
| --- | --- | --- | --- |
| `memory` | profile、daily、pattern 等 Memory | `memory` | 走 Memory 专用重建和向量同步 |
| `knowledge` | 用户 Knowledge 条目 | `knowledge` | 主数据是用户目录下的 Knowledge Markdown |
| `project` | 项目、阶段、待办 | `projects` | 通过项目适配器生成文档 |
| `file` | 文件库文件和文件夹记录 | `files` | 只索引已授权的文件记录及其可检索内容 |
| `note` | 思维便签 | `mind` | 与画布资源共用 mind 事件 |
| `canvas` | 思维画布节点 | `mind` | 与便签资源共用 mind 事件 |
| `calendar` | 日历事件 | `calendar` | 只生成 owner 范围内文档 |
| `scheduled_task` | 定时任务 | `scheduled_tasks` | 只生成 owner 范围内文档 |
| `conversation` | 会话消息 | `sessions` / `conversation` | 支持消息水位过滤 |

资源到来源的集中映射位于 `backend/app/core/events.py` 的
`_RAG_SOURCES_BY_RESOURCE`。新增业务资源时必须同时检查：写入事件、映射、来源适配器和索引测试。

## 3. 写入与更新规则

所有会改变可检索内容的写入，都必须遵循：

1. 先完成主数据写入并提交事务。
2. 提交成功后发布 `RagIndexUpdated`；Memory 使用 `MemoryUpdated`。
3. 由 `agent.events.bus` 异步调用 `agent.rag.pipeline` 重建受影响来源；同一用户同一来源
   的连续事件合并为最新事件，重建期间到达的后续事件会在当前任务完成后再处理一次。
4. 索引任务失败最多重试三次，并记录索引诊断；不能回滚已经成功的业务写入。
5. `replace_source_documents` 以来源为边界替换投影，清理本来源的过期 chunk，并失效进程内缓存。

禁止在业务代码中直接写 `knowledge_index_entries` 来“顺便更新索引”。这样会绕过来源适配、版本和缓存失效逻辑。确需批量修复时，使用统一重建入口。

工具写入由 `registry.dispatch` 的资源映射统一发布事件；API、IM 生命周期和自动反思写入也必须走同一事件链。只读操作（`list_`、`get_`、`read_` 等）不得触发索引重建。

## 4. 版本、缓存与一致性

- 每个索引文档包含稳定的 `document_id`、来源 ID、`document_version`、chunk 序号和内容哈希。
- 同一父文档的未变化 chunk 应保持稳定槽位；版本变化只更新受影响的 chunk。
- 持久投影更新后，当前进程的来源缓存立即失效；其他进程通过 revision 检测后重新加载。
- TS worker 使用持久索引 revision；`patch` 必须携带正确的 `base_revision`，revision 不匹配时必须显式失败并由 Python 重建。
- Memory 的向量缓存与统一来源投影是不同的存储边界；Knowledge 等来源的索引投影仍统一管理，避免被动 RAG 只覆盖某一个来源。
- 索引缺失、旧版本或事件丢失时，以主数据为准，执行来源级或用户级重建，不修改业务主数据。
- 写路径不再有 Python 分块、`rag_write_mode` 或 shadow 分支；TS worker 失败由索引事件重试和诊断暴露，禁止静默回退到第二套投影。

## 5. 召回链路与分数

Agent 查询通过 `UnifiedQueryRetriever` 进入 TS worker。worker 先按来源和 scope 做候选召回，再由统一排序阶段处理候选：

- 纯词法查询使用 TS worker 的 BM25 原始分数。
- Memory 可携带查询向量和文档向量，按统一 hybrid/RRF 契约融合；embedding 不可用时显式回退为 BM25。
- 最终选择使用统一排序结果中的 `confidence`、来源质量、去重和 parent 限制；不要在业务层把 `fused_score` 当作权限或唯一阈值。
- `source_types`、scope 和会话消息水位都是查询约束，不是召回后再猜测的提示词规则。
- 返回正文前必须由 Python 按 owner/scope 回填；worker 只返回稳定候选和诊断字段。

## 6. 重建与诊断

重建一个用户的统一索引：

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/rebuild_knowledge_index.py --user-id <UUID>
```

只重建某个来源：

```bash
PYTHONPATH=. .venv/bin/python scripts/rebuild_knowledge_index.py \
  --user-id <UUID> --source knowledge
```

重建脚本只修改索引投影，不修改 Knowledge、项目、文件库或 Memory 主数据。执行后应检查返回的来源 chunk 数量，以及对应来源的召回测试或管理诊断。

## 7. 新增来源检查清单

新增一个可召回来源时，按以下顺序完成：

- 在 `RagSourceType`、Python来源常量和来源适配器中登记。
- 定义稳定的来源 ID、文档 ID、版本、scope、标题、正文和元数据字段。
- 在 `app/core/events.py` 增加资源到 `source_type` 的集中映射。
- 确认所有写入入口在主事务成功后发布事件，包括 API、工具、IM 和后台任务。
- 在 `index_builder.py`、`persistent_store.py` 和必要的向量同步路径补齐实现。
- 在 TS contract 中补齐来源字段或协议变更；不要在 Python 和 TS 各自复制一份不一致的 schema。
- 增加事件更新、重建、权限隔离、缓存失效、召回和失败重试测试。
- 运行 Python RAG 测试和 TS worker 测试后，再执行一次来源级重建验证。

## 8. 常用验证命令

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_knowledge_index_event.py \
  tests/test_rag_ts_sidecar.py \
  tests/test_rag_unified_query.py

cd ts/workers/rag
pnpm test

cd ../../..
make rag-ts-build
bin/gugu-rag-ts-worker.mjs --version
```

若只是调整文档、字段说明或协议注释，至少运行 `git diff --check`；若改变协议或来源行为，必须同时更新 contract、Python bridge、worker 和测试。
