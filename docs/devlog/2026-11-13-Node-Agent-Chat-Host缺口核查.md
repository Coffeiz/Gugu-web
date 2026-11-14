# Node Agent 聊天 Host 缺口核查

## 当前证据

- devserver Node `/health` 返回 200，Vite 代理的合成 `POST /api/v1/agent/chat` 返回 404；当前 Host 没有注册聊天入口，请求未创建会话、未写数据库、未调用模型。
- Python 参考行为 `backend/tests/agent/chat/` 在 devserver 串行复验 **230 passed、0 failed、1 条第三方弃用警告**，可作为 Node 对照基线。此前临时测试环境缺少 `aiohttp`；切换到 devserver 已具备完整依赖的环境后通过，未修改仓库依赖。
- `gugu-core/src/agent/harness/` 的单元测试只证明编排契约，不能证明生产 PostgreSQL RunStore、跨进程 Lease/Cancellation、Provider、Tools 或 HTTP/SSE 已接通。

## 尚需实现

要让前端 `useChatStream` 主路径可用，Node Host 需要提供 owner-bound Run 启动/恢复/取消，先提交用户消息、附件 claim 和 pending queue receipt，再稳定 SSE 事件；还需持久 RunStore/Lease/outbox、Provider 与工具适配、交互恢复和取消恢复。缺少任一生产边界都不能用空实现或 Python fallback 伪装迁移完成。

本轮复核了前端请求协议、Python `ChatRequest` 与 Node Harness 生产端口；Node Core 暂无生产 Provider、RunStore、Lease/Cancellation、Tool 或 Context Data adapter。仅增加路由不能形成可用聊天链路，必须一起接通持久化、生成、SSE 和恢复边界。

本轮只复验 Python 基线，没有新增 Node 聊天路由或数据库写路径；未运行 Node 聊天测试或数据库验收，也未使用 Docker、修改运行配置、提交或触发 CI。
