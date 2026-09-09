# Gugu RAG TypeScript Worker

这是 RAG 词法索引、候选融合和统一排序的固定 Node.js 制品源代码。业务侧
生命周期、来源映射和重建规范见 `backend/agent/rag/README.md`；本文只约束
Worker 的协议、持久化和责任边界。

共享协议类型位于 `backend/ts/packages/contracts/src/rag.ts`，是 Worker 与
Python 迁移桥接层之间的唯一 canonical contract。Python 侧可以继续保留
`backend/agent/rag/ts_sidecar.py` 作为迁移期进程桥接，但不得在另一处重新定义
Worker 请求/响应语义。

原文分词使用 `@node-rs/jieba`，只保留 Jieba 中文词和完整 ASCII 实体；
索引、查询和 Python 对照测试使用同一规则。构建时会把当前平台的 N-API
运行包复制到 `backend/bin/node_modules`，因此制品必须在目标平台上构建。

```bash
cd backend
make rag-ts-build
bin/gugu-rag-ts-worker.mjs --version
```

源码固定在 `backend/ts/workers/rag`，运行时只消费 `backend/bin/gugu-rag-ts-worker.mjs`，不在 devserver 或 Docker
容器内编译 TypeScript 或访问网络；运行时只加载随制品发布的原生分词依赖。

## 责任边界

- Worker 只处理 Python 已经提交的、经过授权范围筛选的文档和候选。
- Worker 不连接数据库、文件库或网络，不负责 owner/scope 鉴权，也不把正文权限判断交给分数。
- Worker 不生成 embedding；向量由 Python 侧准备并按 canonical contract 传入。
- Worker 的索引文件是可重建缓存。恢复失败必须返回可观测错误，由上层重新 `replace`，不能静默当作空索引。

## JSONL 协议

协议类型唯一来源是 `backend/ts/packages/contracts/src/rag.ts`，stdin/stdout
每行一个 JSON 请求或响应。当前操作分为四组：

- 生命周期：`ping`、`replace`、`patch`、`replace_transient`。
- 来源构建：`adapt`、`build_documents`、`build_and_index`、`tokenize`。
- 词法查询：`search`、`unified_search`、`batch_search`。
- 融合与排序：`hybrid_fuse`、`rank_candidates`、`unified_query`。

新增或修改操作时，必须先更新 `contracts/src/rag.ts`，再同步 Python
`agent/rag/ts_sidecar.py`、worker 实现和测试；禁止只改其中一侧的隐式字段。

`replace` 用于完整替换持久索引，`patch` 用于 snapshot revision 更新时的 chunk 级同步，
输入 `upserts` 和 `deletes`，不会要求调用方重新发送完整文档集合。`patch` 必须
校验 `base_revision`；不匹配时返回 `revision_mismatch`，由 Python 重新发送完整
`replace`，不得在 Worker 内猜测基线。

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
不在 devserver 或 Docker 容器内编译 TypeScript，也不访问网络。
