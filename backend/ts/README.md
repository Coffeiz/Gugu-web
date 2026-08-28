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

`workers/rag` 是独立 JSONL Worker。`api/live.ts` 是实时事件 TypeScript 服务：只负责 JWT 用户隔离、Redis 用户频道/广播订阅和 SSE 输出，不在 API 进程内运行 Agent loop。前端通过 `VITE_LIVE_API_URL` 或当前主机的 8585 端口直接订阅。

## Live API 试点

```sh
corepack pnpm install
GUGU_SECRET_KEY=... REDIS_URL=redis://127.0.0.1:6379 corepack pnpm --filter @gugu/backend-ts start:live
```

监听 `GET /live/stream`。它只接受 `role=user` 的 HS256 JWT，并只订阅 `events:{user_id}` 与全局通知频道；业务消息必须是 `live-event-v1` canonical envelope，断开连接会取消订阅并释放 Redis 连接。生产环境由 `gugu-live.service` 托管；跨端口浏览器访问需配置 `TS_LIVE_ALLOWED_ORIGINS`。
