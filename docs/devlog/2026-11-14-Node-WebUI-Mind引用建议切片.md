# Node WebUI Mind 引用建议切片

## 迁移范围

- 迁移 `GET /api/v1/mind/ref-suggest`，限制 `limit` 为 1–20，匿名请求返回 401。
- 空关键词按 Python 顺序返回最近项目、文件夹、文件、活动、画布便签、Skill、MCP 和有效定时任务候选，并限制总数。
- 非空关键词复用 Node 全局搜索，按消息记录单独查询对话候选，过滤 JSON 富消息与 summary 行；聊天建议 ID 锚定消息，标签为命中片段，subtitle 为会话标题。
- 结果 owner 绑定到认证用户；MCP UUID 保留字符串，PostgreSQL bigint 文本 ID 映射为 Python 兼容数字。

## 验证

- devserver Node 路由、PG adapter 行为及生产 Vite→`main.ts`→Node Host→随机 schema 集成：`4/4` 通过，0 失败、0 跳过。
- Python Mind API 与引用建议 folder/Skill/MCP/task 对照：`39 passed`。
- `@gugu/webui` typecheck 通过。
- 真实 Vite/PG 集成覆盖最近项目/文件/活动、项目关键词搜索、逐条消息建议和跨 owner 隔离。用例首次发现消息 bigint ID 为文本造成 API 响应类型偏差，映射已修复并由同一集成回归锁定。
- 测试进程有非致命 Git 元数据探测 stderr 与 Node `module.register()` 弃用提示，未影响测试。

## 边界

- Redis 跨进程通知不涉及本只读端点，未纳入本次验收。
- 项目仍有其他待迁移 API；本次没有提交。
