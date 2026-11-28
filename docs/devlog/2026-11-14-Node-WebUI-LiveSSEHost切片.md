# Node WebUI Live SSE Host 切片

## 范围

将 `/api/v1/live/stream` 接到认证后的 Node Host。流订阅当前 owner 频道和广播频道，首帧后及每条 Redis 消息前重新读取 PostgreSQL 用户状态，校验账号可用性与 token security version；客户端断开时取消等待并释放订阅。Redis 未配置时保留已认证的 SSE 路由并发 reset 提示。

## 验证

- Python 行为基线：`tests/platform/realtime/test_live_stream.py` 与 `tests/platform/realtime/test_web_session_events.py`，23/23 通过。
- Node Live 路由与 Redis RESP adapter 行为测试：13/13 通过，覆盖频道、事件 allowlist/字段裁剪、账号停用、认证拒绝、断连清理、Redis 协议失败及缺少 Redis 配置。
- Node 认证会话对照：登录、注销和 `/auth/me` 行为测试通过；新增 Vite→Node Host 用例验证未认证拒绝、Cookie 会话、Live 事件和注销后旧 Cookie 失效。
- Node 定向集合总计 24 项：23 通过、0 失败、1 个既有 PostgreSQL Vite 集成用例因未配置隔离测试库而跳过。跳过项不计入通过数。
- Node WebUI typecheck 通过。
- devserver 当前运行路径烟测：Vite 首页、site-config、Node readiness 均为 200；未经认证的 `/api/v1/live/stream` 返回 401。
- Python 认证 Cookie/token 撤销与 Live 基线合计 33/33 通过。

## 未验收项

- Vite Host 行为测试使用合成认证用户和 fake Redis subscription；真实 PostgreSQL 用户查询、security version 变更与真实 Redis Pub/Sub 没有本轮验收。
- devserver 未配置 `GUGU_WEBUI_TEST_DATABASE_URL`，本机 PostgreSQL readiness 无响应。完成真实数据库验收的最小条件是提供专用隔离 PostgreSQL URL，并允许测试创建/删除随机 schema；Live 基础设施验收还需提供可用于测试的 Redis 连接。
- 当前 Vite→Node 主机仅验证无凭据请求的 401。认证后的真实数据库和 Redis 事件端到端行为仍待上述测试基础设施。
