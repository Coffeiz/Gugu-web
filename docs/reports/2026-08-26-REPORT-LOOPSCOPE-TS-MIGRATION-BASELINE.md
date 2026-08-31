# LoopScope TypeScript 迁移基线报告

## 1. 基线

- 日期：2026-08-26
- 当前工作分支：`dev`
- 参考分支：`feat/loopscope-0.3-ts-foundation`
- 参考分支 HEAD：`04bf96da`
- 本次操作：仅建立本地跟踪分支并读取其内容，没有切换当前分支、没有修改 LoopScope 运行数据库。

## 2. 当前 dev 实现

当前 LoopScope 后端仍是独立 Python 服务：

```text
loopscope/backend/
├── loopscope/main.py       # FastAPI 路由
├── loopscope/storage.py    # sqlite3 + 手写 SQL
├── pyproject.toml
└── tests/
```

持久化使用 SQLite、WAL 和外键，运行时数据库为 `loopscope/data/loopscope.db` 或 `LOOPSCOPE_DB_PATH` 指定路径。当前没有 ORM。

旧 API 契约：

```text
GET  /api/health
POST /api/collector/runs
GET  /api/sessions
GET  /api/sessions/{session_key}/runs
GET  /api/runs/{run_id}
GET  /api/runs/{run_id}/spans
```

## 3. 参考分支可复用内容

### 可以提取

- `loopscope/apps/collector/src/server.ts`：Node HTTP Collector 骨架；
- `loopscope/apps/collector/src/store.ts`：Run/Span 幂等写入、查询和派生数据；
- `loopscope/packages/db`：Drizzle SQLite schema、WAL、外键和增量迁移；
- `loopscope/packages/contracts`：Zod payload 校验和 Trace 类型；
- `loopscope/packages/trace-sdk`：TypeScript Worker 上报 SDK；
- `loopscope/pnpm-workspace.yaml`：LoopScope 内部 workspace 结构。

### 不直接提取

- `loopscope/apps/web` 的 Next.js + React 页面；当前目标仍是 Vue + Vite；
- 删除 Python 后端和 Vue 前端的提交；
- 分支中与 LoopScope 无关的 Gugu 前端、Runtime 和视觉修改。

## 4. 已冻结的兼容要求

1. Collector 仍接收完整 Run snapshot，Gugu Python hook 不需要知道 Drizzle 或 TypeScript 内部实现。
2. 相同 Run id 重复上报必须幂等，不能产生重复 spans。
3. 保持旧 API 路径、字段命名、排序和错误状态。
4. 必须保留 `/api/runs/{run_id}/spans` 以及 `list_runs` 的 `limit`、`before` 参数。
5. 旧 SQLite 数据库必须原地可读，迁移不得清空、重建或覆盖用户数据。
6. Collector 不可用或写入失败时，Gugu Agent 主链路不能被阻塞。
7. 诊断日志不记录用户正文、附件、token、密钥或签名 URL。

## 5. 参考分支的已知补齐项

参考分支的 TypeScript Collector 目前还需要在提取时补齐：

- 旧版 spans 分页接口；
- `list_runs` 的 `limit`、`before` 和兼容排序；
- 旧 SQLite fixture 的读写回归；
- payload 大小限制与错误脱敏；
- `better-sqlite3` 在 macOS arm64、Linux x64 和 Docker 中的安装验证。

参考分支的 Next.js + React 前端不纳入本次迁移。

## 6. Phase 0/1 结论

Phase 0 已完成。Phase 1 已提取 Storage Core，LoopScope 后端迁移不需要从零重写，下一阶段应直接补齐旧 API 兼容。

下一步：

```text
Phase 1：提取 TypeScript Storage Core
Phase 2：补齐 HTTP API 兼容
Phase 3：Python/TypeScript 双实现对照
Phase 4：Docker、devserver 切换与 Python 清理
```
