# Node Agent 凭据交互深链 Host 接入

## 变更

- 将已有 `GET /api/v1/agent/interactions/{prompt_id}/session` route 与 PostgreSQL lookup 接入 Node Host。
- Host 认证后从可信 `RequestContext` 取得 owner，并只返回其 MCP 凭据交互所属的 `session_id`；伪造 query 参数或请求头不能替换 owner。
- 普通交互、其他用户的 prompt 和不存在的 prompt 继续统一返回 404；响应不包含凭据或交互 schema。
- 本切片不涉及 OSS/S3 或附件存储。

## 验证

- devserver Node route、lookup adapter 和 Host 测试：29 通过、0 失败、2 跳过。本模块的真实 PostgreSQL lookup 集成测试因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，另 1 项为 Host 套件既有环境门控用例；跳过项均不计为通过。
- devserver Node WebUI TypeScript typecheck 通过。
- Python 兼容基线 `test_web_secret_link_and_submit_are_owner_scoped_for_group_session`：1 通过。
- devserver Node `/health`、Vite 首页返回 200；经 Vite 请求该 API 未认证时返回 401。
- 没有执行认证态真实数据库查询；Vite 401 仅验证 Host 路由、认证守卫与代理链。
