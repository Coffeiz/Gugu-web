# Node Agent Run 取消 Redis 端口

## 范围

新增 Node `CancellationPort` 的 Redis 实现，供后续 Agent Run Host 组合使用。本切片没有注册 `/api/v1/agent/sessions/{session_id}/cancel`，也没有接入聊天执行、SSE 或生产 Host，因此不代表 Agent Chat 已迁移。

取消身份由可信 `ownerId`、`sessionId` 和 `runId` 组成。Redis 标记键按三者隔离，值为目标 `runId`，TTL 为 300 秒；请求先写标记，只有写入成功后上层才发布唤醒。Pub/Sub 通道按 owner 隔离，消息消费端再次核对三个身份字段，避免同一用户其他会话或排队的后继 Run 被误取消。

订阅断开会记录不含会话或消息内容的通用错误，取消事实仍以 Redis 持久标记为准；标记写入失败会返回错误，阻止发布一个没有持久化依据的通知。

## 验证

- devserver Node 26.13.1：Agent 取消端口与 Redis 命令回归 `13/13` 通过，0 失败、0 跳过。
- WebUI 全量 TypeScript 检查通过。
- devserver Python `tests/agent/test_run_cancellation.py`：`11/11` 通过。
- Redis 命令层通过 TCP 假 Redis 验证 AUTH、SELECT、GET、带 TTL 的 SET 与 PUBLISH 参数顺序；订阅匹配用注入式订阅器验证。**未连接真实 Redis**。
- 本切片没有 HTTP 路由或 PostgreSQL 写入，因此未做 Vite/PG 验收。

## 后续接线

聊天 Host 仍需生产 Provider、Canonical Context、历史事务写入、RunStore/lease 组合、Redis 端口装配、取消/续看 HTTP 路由与 Vite→Node Host 真实 Redis 验收。Redis 暂不可用时的运行策略和取消故障响应还须在 Host 集成时与 Python 行为逐项对照。
