# Node Agent 会话文件系统授权迁移

## 范围

将会话完整用户沙箱授权的申请、确认、撤销三个 API 接入 Node WebUI Host：

- `POST /api/v1/agent/sessions/{session_id}/filesystem-authorization/request`
- `POST /api/v1/agent/sessions/{session_id}/filesystem-authorization`
- `DELETE /api/v1/agent/sessions/{session_id}/filesystem-authorization`

路由接入统一认证，并从认证上下文获取 owner。申请和确认先检查会话归属；功能开关关闭时拒绝新授权，已有授权仍可撤销。确认码在 Redis 中沿用 Python 的 key、摘要和 TTL 协议，可由 Python 或 Node 兑换。授予与撤销在 PostgreSQL 事务内写入授权记录和脱敏安全事件；撤销前还会停止该会话未关闭的交互 PTY。

申请响应保留 `waiting_confirmation`、`needs_confirm`、`summary`、`instruction`、`authorization_ttl_minutes` 与 `confirm_code` 字段。确认码失效或身份不匹配返回 400；确认服务不可用返回 503；其他用户的会话返回 404。

## 验证

所有验证均在 devserver 原生运行，未使用 Docker：

- Python 授权与 Agent 命令行为基线：`75 passed`。
- Node 路由、确认码、PostgreSQL 和真实 Redis 测试：`9 passed`、`0 failed`、`0 skipped`。
- Vite→认证 Node Host→随机 PostgreSQL schema 完成申请、无效码拒绝、确认、撤销端口调用和 owner 隔离；该测试用替身确认 PTY 终止端口会在撤销时调用，未连接真实 sandboxd。
- 真实 Redis Lua 测试验证确认码一次性兑换及 owner/会话身份隔离。
- `corepack pnpm run typecheck` 通过。

Node/Vite 测试输出含 Node `module.register()` 弃用提示和 `fatal: not a git repository` stderr；两者未导致测试失败，stderr 来源尚未定位。

测试使用的随机 PostgreSQL schema 在用例结束时删除；真实 Redis 测试在 `finally` 中撤销其唯一合成测试键。测试未修改运行配置。
