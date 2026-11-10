# RAG 与 Knowledge

RAG 从已经授权的来源中找出相关内容，作为当前轮上下文。Knowledge 是可保存、可追溯的知识主数据。RAG 索引只是可重建的派生数据，不能代替业务数据或权限系统。

## 当前架构

```text
业务数据与索引事件
        ↓
Python source adapter 读取已授权数据并生成文档
        ↓
Python 持久化索引 + Cython 分块、词法检索与排序
        ↓
Python 复核 owner/scope、组装引用和上下文
        ↓
Agent
```

- RAG 的索引投影、查询、缓存、融合、排序和快照均由 Python/Cython 实现，不再有 TypeScript RAG worker 或第二套引擎。
- 多个 Python 服务进程可通过本机 Unix socket 连接常驻 Cython sidecar；未配置时使用进程内实现。
- Python 负责认证、授权、数据库和存储读取、索引写入编排及最终权限复核。sidecar 不授予权限。
- 文件库不参与自动 RAG；文件仍通过独立的文件工具读取和修改。
- TypeScript 后端仍可用于文件同步、画布渲染等与 RAG 无关的 worker。

## 已接入来源

自动检索支持 Memory、Knowledge、项目、便签、画布、日历、定时任务和会话消息。群组或成员记忆使用显式 scope；会话消息检索受消息水位约束。来源到业务资源的映射位于 `backend/app/core/events.py`，对应适配器位于 `backend/agent/rag/adapters/`。

业务写入成功后，通过 `RagIndexUpdated` 或 `MemoryUpdated` 异步更新派生索引。只读操作不得触发重建；索引失败不能回滚已提交的业务数据。

## 一致性与安全

- 索引文档保留稳定来源 ID、版本、chunk 序号和内容指纹，方便增量更新与引用追溯。
- revision 不匹配、索引损坏或快照过期时，从 canonical 业务数据重建；不自动切换到另一套引擎。
- 所有结果在返回正文前再次校验 owner/scope。分数不能代替权限判断。
- RAG 数据存放在用户存储的 `.agent/rag/` 下，可删除并从业务事实数据重新生成。

## 维护

```bash
cd backend
PYTHONPATH=. .venv/bin/python scripts/maintenance/rebuild_knowledge_index.py --user-id <UUID>
```

指定来源：

```bash
PYTHONPATH=. .venv/bin/python scripts/maintenance/rebuild_knowledge_index.py \
  --user-id <UUID> --source knowledge
```

修改来源时，同时检查 source adapter、事件映射、索引持久化、权限隔离、缓存失效和回归覆盖。诊断工具应调用生产 Cython 排序入口，不复制另一套生产算法。
