# TypeScript 后端基础工程

这里承载逐步迁移后的 TypeScript API、Worker 和共享 contract。当前仍由 Python backend 提供旧 API，迁移期间两者必须复用同一份协议定义。

## 固定约定

- Node.js：`>=22 <23`；本地版本以 `engines` 和 CI 检查为准。
- TypeScript：使用仓库现有 `frontend/node_modules/typescript` 做无输出类型检查，配置见 `tsconfig.json`。
- lint：Phase 0 以 TypeScript 类型检查作为基线，命令为 `npm run lint`；引入独立 lint 规则前不得伪造通过结果。
- test：使用 Node 内置 test runner 和 `--experimental-strip-types`，命令为 `npm test`。
- build：`npm run build` 只生成固定制品 `backend/bin/gugu-rag-ts-worker.mjs`，运行时不编译 TypeScript。
- API contract：`npm run gen:api` 从 FastAPI `/openapi.json` 生成 `packages/contracts/src/api.d.ts`；可用参数或 `OPENAPI_SOURCE` 指定文件/URL。

## 存储边界

PostgreSQL 是用户、session、message、tool event、任务、RAG 元数据和审计状态的唯一 canonical source。Redis 只负责队列、取消信号、SSE fanout、短锁、worker lease 和带 TTL 的运行快照；Redis 数据不能反向成为持久历史。API、Worker 和 Python bridge 只能通过 `packages/contracts` 交换数据，禁止各自扩展同一字段。

## 当前制品

`workers/rag` 是独立 JSONL Worker。API 后续只创建 command、查询状态、订阅 event，不在 API 进程内运行不可控时长的 Agent loop。
