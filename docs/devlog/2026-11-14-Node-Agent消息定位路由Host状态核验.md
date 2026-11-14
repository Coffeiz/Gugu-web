# Node Agent 消息定位路由 Host 状态核验

## 当前实现

检查迁移清单时发现该 route 已在当前树接入 Node Host：Host 传递认证上下文中的 owner，PostgreSQL 查询仅返回展示正文行的位置，并过滤 timeline、summary 与其他用户消息。迁移清单此前仍标记为“Host 未挂载”，本记录更正该状态。

## 验证

- devserver Node route 测试 3/3 通过；Host Agent 会话域 suite 23 通过、0 失败、1 个隔离 PG 用例跳过。
- devserver Python `test_agent_api_messages.py` 59/59 通过，但该文件未直接覆盖 `get_message_location`，只作为相邻 API 基线。
- devserver Node WebUI typecheck 通过；经 Vite 调用消息定位路由，未认证请求返回 401。
- locator 真实 PostgreSQL 集成测试因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；本轮没有认证态数据库读取。
