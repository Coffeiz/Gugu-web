# Node Agent 会话上下文刷新 Host 接入

## 变更

- 将已有 `POST /api/v1/agent/sessions/{session_id}/refresh-context` route 与 PostgreSQL refresher 接入 Node Host。
- Host 认证后只使用 `RequestContext` 中的 owner；刷新仅令 snapshot 过期、递增 `context_epoch` 并更新会话时间，不清除已持久化上下文。
- snapshot trace 失效事件继续 best-effort；记录事件失败不回滚已经提交的 epoch 刷新。
- 本切片不涉及 OSS/S3 或附件存储。

## 验证

- devserver Node 的刷新 route 测试 3/3 通过；Host 认证与可信 owner 注入测试通过。
- route 测试中的真实 PostgreSQL 集成用例因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，不能视为 PG 验收。
- 本轮 Agent 深链、上下文刷新及 Host 合并回归共 29 通过、0 失败、2 跳过；Node WebUI typecheck 通过。
- Python snapshot 不清除上下文基线 1/1 通过。
- devserver `/health`、Vite 首页返回 200；经 Vite 请求该 API 未认证时返回 401。
- 未执行认证态真实数据库写入；Vite 401 仅验证 Host 路由、认证守卫与代理链。
