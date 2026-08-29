# TypeScript 后端基础工程

这里承载逐步迁移后的 TypeScript API、Worker 和共享 contract。当前仍由 Python backend 提供旧 API，迁移期间两者必须复用同一份协议定义。

## 固定约定

- Node.js：推荐 `>=22 <23`；devserver 当前使用 Node 20，由 `tsx` 负责运行 TypeScript。
- TypeScript：使用仓库现有 `frontend/node_modules/typescript` 做无输出类型检查，配置见 `tsconfig.json`。
- lint：Phase 0 以 TypeScript 类型检查作为基线，命令为 `pnpm --filter @gugu/backend-ts typecheck`；引入独立 lint 规则前不得伪造通过结果。
- test：使用 Node 内置 test runner 和 `tsx` loader，命令为 `pnpm --filter @gugu/backend-ts test`。
- build：`pnpm --filter gugu-rag-ts-worker build` 只生成固定制品 `backend/bin/gugu-rag-ts-worker.mjs`，运行时不编译 TypeScript。
- API contract：`pnpm --filter @gugu/backend-ts gen:api` 从 FastAPI `/openapi.json` 生成 `packages/contracts/src/api.d.ts`；可用参数或 `OPENAPI_SOURCE` 指定文件/URL。

## 存储边界

PostgreSQL 是用户、session、message、tool event、任务、RAG 元数据和审计状态的唯一 canonical source。Redis 只负责队列、取消信号、SSE fanout、短锁、worker lease 和带 TTL 的运行快照；Redis 数据不能反向成为持久历史。API、Worker 和 Python bridge 只能通过 `packages/contracts` 交换数据，禁止各自扩展同一字段。

## 当前制品

`workers/rag` 是独立 JSONL Worker。实时事件不属于 TypeScript 运行时，已由 `backend/app/api/v1/live.py` 的 FastAPI 接口统一提供；TypeScript 目录不得新增 Live API 或 Agent API 入口。

## 实时事件边界

前端通过同源 `GET /api/v1/live/stream` 连接 FastAPI。该接口只接受用户 JWT，订阅 `events:{user_id}` 和全局通知频道，并过滤非 `live-event-v1` 业务事件。TypeScript 不再提供实时事件服务、systemd 单元或独立端口。
