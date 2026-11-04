# Gugu RAG

RAG 检索、索引投影和索引生命周期统一由 Python/Cython 实现。TypeScript worker 不参与 RAG；仓库内的 TypeScript 仅用于文件同步、画布渲染等独立功能。

## 数据与权限边界

- PostgreSQL 和用户存储保存事实数据；RAG 索引是可重建的派生数据。
- Python 负责身份认证、owner/scope 授权、业务数据读取、索引写入编排、最终权限复核和上下文组装。
- `backend/agent/rag` 负责来源投影、分块、Cython 词法检索、融合、排序、缓存和快照生命周期。
- 启用常驻 RAG sidecar 时，Python 服务通过本机 Unix socket 访问 Cython 索引；未配置时使用进程内 Cython 实现。
- sidecar 只接受已绑定 owner 的请求。返回正文前仍由 Python 复核 owner/scope，索引分数不代表权限。
- 文件库不是自动 RAG 来源。文件读取与修改继续走独立的文件工具和授权流程。

## 检索来源

统一索引支持 Memory、Knowledge、项目、便签、画布、日历、定时任务和会话消息。来源映射位于 `backend/app/core/events.py`，写入成功后通过 `RagIndexUpdated` 或 `MemoryUpdated` 更新派生索引。

新增来源时，需要同步来源模型、适配器、资源事件映射、索引读写、权限边界和行为回归覆盖。只读操作不能触发索引重建。

## 索引生命周期

- 索引更新必须发生在业务事务提交后；索引失败不能回滚已经成功的业务写入。
- 索引文档使用稳定 ID、版本、chunk 序号和内容哈希；增量更新只替换变化的 chunk。
- 持久索引 revision 变化时，缓存重新加载；损坏、过期或缺失的快照从事实数据重建。
- 索引数据保存在用户存储下的 `.agent/rag/`，不作为业务数据迁移或删除的依据。
- 不存在第二套 RAG 引擎或静默 fallback。Cython 运行失败应显式记录并由索引事件重试。

## 维护入口

重建一个用户的统一索引：

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/maintenance/rebuild_knowledge_index.py --user-id <UUID>
```

只重建某个来源：

```bash
PYTHONPATH=. .venv/bin/python scripts/maintenance/rebuild_knowledge_index.py \
  --user-id <UUID> --source knowledge
```

重建仅更新可再生索引，不修改 Knowledge、项目、文件库或 Memory 主数据。诊断脚本应复用 `agent.rag.service.rank_candidates_for_query` 等生产 Cython 路径，不复制一套排序实现。
