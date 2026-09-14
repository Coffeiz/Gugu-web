# Gugu RAG TypeScript Worker

这是 RAG 查询期数据访问、词法索引、候选融合和统一排序的固定 Node.js 制品源代码。业务侧
生命周期、来源映射和重建规范见 `backend/agent/rag/README.md`；本文只约束
Worker 的协议、持久化和责任边界。

共享协议类型位于 `backend/ts/packages/contracts/src/rag.ts`，是 Worker 与
Python 迁移桥接层之间的唯一 canonical contract。Python 侧可以继续保留
`backend/agent/rag/ts_sidecar.py` 作为迁移期进程桥接，但不得在另一处重新定义
Worker 请求/响应语义。

原文分词使用 `@node-rs/jieba`，只保留 Jieba 中文词和完整 ASCII 实体；
索引与查询使用同一规则；Python 融合实现只保留在离线诊断参考计算中。构建时会把当前平台的 N-API
运行包复制到 `backend/bin/node_modules`，因此制品必须在目标平台上构建。

```bash
cd backend
make rag-ts-build
bin/gugu-rag-ts-worker.mjs --version
```

源码固定在 `backend/ts/workers/rag`，运行时只消费 `backend/bin/gugu-rag-ts-worker.mjs`，不在 devserver 或 Docker
容器内编译 TypeScript 或下载依赖。worker 可经 Data Runtime 连接配置好的 PostgreSQL，并通过明确的 StorageReader 读取允许的 owner 存储；不允许任意出站网络访问，运行时只加载随制品发布的原生分词依赖。

## 责任边界

- Worker 可通过 Data Runtime 按 Python 认证授权后传入的 owner 只读加载持久索引与受支持的 source 数据；也可处理 Python 写侧投影后提交的 patch/replace。它不负责用户身份认证、ACL 或业务授权事实。
- 数据库读取必须绑定 owner；未实现的 scope 必须 fail-closed。文件正文和 Memory 私有内容仅通过显式 StorageReader 访问，不拼接任意路径；Python 仍负责最终 owner/scope 复核。
- TS 运行时不执行业务主数据或持久索引写事务；RAG-9 的事件编排、KnowledgeIndexEntry 更新和向量写入仍由 Python 写路径负责。
- 查询时 worker 通过 owner-bound 专用 IPC 接收临时 embedding 配置，在 TS 发起 provider 请求并生成 query vector；公网目标由 Python 复用 URL 安全校验后 pin，支持 Node 标准 HTTP(S) proxy 环境变量，禁用自动重定向。凭据不记录、不持久化、不回显。
- Python 仍负责 embedding 凭据解密/选择；文档与 Memory 写侧向量生成和持久化继续使用共享 Python embedding 原语，不属于 query retrieval。
- Worker 的索引文件是可重建缓存。恢复失败必须返回可观测错误，由上层重新 `replace`，不能静默当作空索引。

## JSONL 协议

协议类型唯一来源是 `backend/ts/packages/contracts/src/rag.ts`，stdin/stdout
每行一个 JSON 请求或响应。当前操作按用途包括：

- 生命周期：`ping`、`replace`、`patch`、`replace_transient`。
- 查询期数据读取/准备：`database_revision`、`load_index_from_database`、`sync_index_from_database`、`load_vectors_from_storage`、`prepare_memory`。
- 来源构建：`adapt`、`build_documents`、`build_and_index`、`tokenize`。
- 词法查询：`search`、`unified_search`、`batch_search`。
- 融合与排序：`hybrid_fuse`、`rank_candidates`、`unified_query`。

新增或修改操作时，必须先更新 `contracts/src/rag.ts`，再同步 Python
`agent/rag/ts_sidecar.py`、worker/Data Runtime 实现和测试；禁止只改其中一侧的隐式字段。

`replace` 用于完整替换持久索引，`patch` 用于 snapshot revision 更新时的 chunk 级同步，
输入 `upserts` 和 `deletes`，不会要求调用方重新发送完整文档集合。`patch` 必须
校验 `base_revision`；不匹配时返回 `revision_mismatch`，由 Python 重新发送完整
`replace`，不得在 Worker 内猜测基线。

`load_index_from_database` / `sync_index_from_database` 由 Data Runtime 按 owner 从 PostgreSQL 读取持久 canonical index 与增量；这是查询期只读路径，不执行业务索引写入。
`replace_transient` 是 Memory/本轮上下文等瞬态语料槽，不写入持久索引。
`unified_query` 是 Agent 主查询入口，负责按来源组装候选并调用统一排序；
`hybrid_fuse` 和 `rank_candidates` 是可独立测试的融合/排序契约。

成功响应必须是 `status: "ok"`，失败响应必须是 `status: "error"` 并带稳定
`code`。调用方不能把错误响应当作空结果继续注入上下文。

## 文档与 revision 规则
Worker 文档 ID 是稳定的 chunk slot，不包含业务文档版本；版本变化只会更新对应
slot，不会让同一父文档的未变化 chunk 被误判为新文档。对外返回的引用 ID 仍由
Python 侧保留版本信息。查询请求中的 `source_types`、scope 和消息水位只能缩小
Python 已授权的候选集合，不能扩大可见范围。

## 构建与验证

```bash
cd backend
make rag-ts-build
bin/gugu-rag-ts-worker.mjs --version

cd ts/workers/rag
pnpm test
```

构建会把当前平台的 N-API 分词运行包复制到 `backend/bin/node_modules`，因此
制品必须在目标平台上构建。运行时只消费 `backend/bin/gugu-rag-ts-worker.mjs`，
不在 devserver 或 Docker 容器内编译 TypeScript，也不临时下载依赖；数据库和存储访问仅限 Data Runtime / StorageReader 的显式配置。
