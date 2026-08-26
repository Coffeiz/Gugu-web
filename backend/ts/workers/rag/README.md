# Gugu RAG TypeScript Worker

这是 RAG 词法索引和评分过滤的固定 Node.js 制品源代码。

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

协议是 JSONL stdin/stdout：`ping`、`replace`、`patch`、`search` 和 `score_filter`。

`patch` 用于 snapshot revision 更新时的 chunk 级同步，输入 `upserts` 和 `deletes`，
不会要求调用方重新发送完整文档集合。
worker 的文档 ID 是稳定的 chunk slot，不包含业务文档版本；版本变化只会更新对应 slot，
不会让同一父文档的未变化 chunk 被误判为新文档。对外返回的引用 ID 仍由 Python 侧保留版本信息。
worker 不负责权限授权和正文输出。Python 侧先做 scope/owner 校验，worker 只返回
稳定候选 ID 与分数，正文由 Python 回填。
