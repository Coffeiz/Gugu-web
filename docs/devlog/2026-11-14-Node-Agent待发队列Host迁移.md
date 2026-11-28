# Node Agent 待发队列 Host 迁移

## 变更

- 将待读队列、导入草稿读取、会话队列增量更新、草稿全量替换以及 claim/release 路由接入 Node Host。
- 所有读写使用 Host 认证上下文中的 owner；GET 响应移除 claim token，PATCH 保留另一客户端取得的租约，claim/release 使用 PostgreSQL 行锁和 token 校验。
- 全量 PUT 仅接受草稿队列标识；空列表删除当前 owner 的草稿，session 队列必须使用 PATCH。
- 队列变化事件只发布 owner、session 与来源元数据，不包含队列正文。

## 验证

- devserver Node pending queue 与 Host 定向集合：34 通过、0 失败、5 个隔离 PostgreSQL 用例跳过。
- devserver Node WebUI typecheck 通过。
- devserver Python `tests/agent/chat/test_chat_pending_queue.py`：13/13 通过。
- 5 个 PostgreSQL 用例因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过；不能据此视为真实 PostgreSQL 行为验收。
