# TypeScript 后端基础工程

这里保留与 RAG 无关的 TypeScript 服务和共享 contract。当前包括文件同步 watcher、画布渲染等独立 worker；RAG 查询、索引投影、缓存和 sidecar 均由 Python/Cython 负责。

## 固定约定

- Node.js：版本要求见根目录 `package.json`，运行方式以各 worker 的部署配置为准。
- TypeScript：使用仓库现有 TypeScript 做无输出类型检查，配置见 `tsconfig.json`。
- 测试：使用 Node 内置 test runner 与 `tsx` loader，命令为 `pnpm --filter @gugu/backend-ts test`。
- API contract：`pnpm --filter @gugu/backend-ts gen:api` 从 FastAPI OpenAPI 生成共享类型。
- 文件同步 watcher：Python 负责 sidecar 生命周期、权限复核、reconcile 和数据库投影；TypeScript worker 只上报绑定目录下的文件系统事件。

## 存储边界

PostgreSQL 是用户、session、message、tool event、任务、RAG 元数据和审计状态的唯一 canonical source。Redis 只负责队列、取消信号、SSE fanout、短锁、worker lease 和带 TTL 的运行快照；Redis 数据不能反向成为持久历史。

API、worker 和 Python bridge 通过共享 contract 交换数据，禁止各自扩展同一字段。

## 实时事件

前端通过同源 FastAPI `GET /api/v1/live/stream` 连接实时事件。TypeScript 不提供实时事件服务、systemd 单元或独立端口。

`packages/filesync-watcher` 是独立 JSONL 文件系统事件 sidecar。它只输出绑定目录的相对路径事件，不访问数据库、不执行权限判断，也不向用户暴露物理路径；事件丢失或 sidecar 重启时由 Python 统一 reconcile 恢复。
