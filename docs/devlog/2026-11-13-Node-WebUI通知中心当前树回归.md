# Node WebUI 通知中心当前树回归

## 路径

前端 `notificationApi` 的通知列表、最新气泡、标已读与清除调用进入 Node Host 认证域，由 PostgreSQL adapter 查询 `site_notifications`、`notification_reads` 和 `notification_dismissals`。所有查询从认证用户取得 owner，并用用户注册时间排除注册前广播。清除只记录当前用户的 dismissal，不删除通知本体。

## Python 基线

- 路由与行为来源：`backend/app/api/v1/notifications.py`、`backend/app/services/notifications.py`。
- devserver 原生串行 pytest：`backend/tests/scheduling/events/test_notifications.py` **4/4 通过**。

## Node Host 验证

- `gugu-webui/tests/host/notifications-route.test.ts` **4/4 通过**，覆盖认证、owner、limit 边界、错误输入与响应形状。
- `gugu-webui/tests/persistence/postgres.integration.test.ts` 中通知 Host/PG 集成 **1/1 通过，0 跳过**。随机隔离 schema 覆盖注册时刻微秒边界、广播/定向通知、持久/气泡通知、已读去重、全量标读、过期气泡、用户独立清除及通知本体保留；schema 在测试后清理。
- devserver Vite 与直连 Node Host 的未认证通知列表和气泡请求均返回 **401**。
- 同一当前树 `@gugu/webui` typecheck 在偏好切片回归时通过。没有改动通知运行时代码。

## 结论与边界

通知中心四个用户 API 已有 Node Host、PostgreSQL 和 Python 行为对照证据，可由 Node 承担。Vite 烟测只验证代理与认证门，没有真实浏览器登录态验收。测试均在 devserver 原生运行；未用 Docker、未改运行配置、未触发 CI、未提交。
