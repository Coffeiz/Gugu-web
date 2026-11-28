# Node Agent RunStore 持久化基础

## 范围

为 Core Agent Harness 提供 PostgreSQL RunStore adapter，支撑后续 Web 聊天迁移所需的加密 checkpoint、事件 outbox、版本比较与 lease fencing。

## 实现与验证

- adapter 将 checkpoint 与事件载荷用 AES-256-GCM 加密，并使用 owner/session/run/kind/event 身份作为认证附加数据；支持按序读取待投递事件及确认。
- create/commit 在事务内校验当前未过期 lease 与 fence，执行 checkpoint version CAS，并将 interaction receipt、canonical history、checkpoint 和 events 一起提交。history writer 收到当前事务的完整 checkpoint，因而可以同时持久化 usage；history 写入失败会回滚整笔提交；checkpoint sequence 不能回退，若有新事件，其序号必须与 checkpoint 对齐。
- 新增 Alembic migration：先建 Agent run leases，再建 checkpoints、events 与 interaction receipts。devserver `alembic history` 确认依赖顺序，未向用户数据库应用 migration。
- devserver Node 26 定向测试 7 项：6 通过、0 失败、1 个隔离 PostgreSQL 用例因缺少 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；新增行为用例验证序号回退或 outbox/checkpoint 序号不一致会拒绝提交且不改写已有状态。`@gugu/webui` typecheck 通过。
- 后续 devserver 复验：RunStore 行为测试 7 项，6 通过、0 失败、1 个隔离 PostgreSQL 用例因测试连接变量缺失跳过；history callback 行为断言确认 writer 收到已提交 checkpoint 的 `usage`、`totalUsage` 和版本。对应 Node 测试通过，Agent 与项目/日历入口的定向 TypeScript 检查通过；全量 WebUI typecheck 当前被独立归档适配器的 TS 错误阻断。
- Python 对照复验在 devserver 串行运行 `tests/agent/test_run_finalize.py` 与 `tests/agent/chat/test_message_area.py`：28 passed、0 skipped。
- 聊天生成迁移前的 Python 行为基线在 devserver 串行复跑：`tests/agent/chat/`、Web stream/resume/queue/session events 与取消用例共 257/257 通过。
- 本轮 Vite 仍返回 `POST /api/v1/agent/chat` 404；该 adapter 尚未接入生成路由。Node Provider/Context 装配、请求队列、取消、SSE 新建/恢复与持久历史仍待实现。

## 验收边界

history 同事务契约通过必需的 `writeHistory` callback 暴露，callback 接收 history delta 和提交 checkpoint；生产 canonical-history writer 尚未接入。此切片只建立持久化 adapter 与 migration，不计作 Agent Web 聊天迁移完成。真实 PostgreSQL schema、并发提交/lease 竞争和故障恢复尚未验收。
