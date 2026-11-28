# N2 Agent greeting API 迁移

## 范围

迁移旧 FastAPI `GET /api/v1/agent/greeting` 到 Node Web Host。接口仍返回 `{ text, enabled }`，只接受 `zh-CN`、`ja-JP`、`en-US`；无效 locale 返回 422。Host 从认证上下文取得 owner，不采信 query/header 中的身份。

Core 负责 locale 归一、时区日期、最近互动、相处姿态、项目顺序与数量、近七天记忆和问候提示词，以及生成/缓存用例。Host 负责 owner-scoped PostgreSQL 读取、安全 Local 文件读取、配置与 BYOK 解封、Provider transport、Redis 锁和 Fastify 协议。模型生成仍使用 standalone Provider，不记 AgentUsage。

## TDD 与验证

- Core 问候测试在模块创建前因 `greeting.js` 不存在失败；锁刚取得时取消测试也先因锁未释放失败，修复后通过。当前 `packages/core/tests/agent/context/greeting.test.ts` 为 11/11。
- Host 路由测试接线前返回 404；接入认证 owner 与 Core generator 后通过。`agent-misc`、上下文/Redis/Provider 适配、BYOK 和 `createApp` owner 链合计 36/36。
- Core build、Web Host production build 和 production typecheck 在 devserver 通过。
- Python 基线为 `backend/agent/greeting.py`、`backend/app/api/v1/agent_routes/misc.py`、`backend/tests/agent/chat/test_greeting_cache.py` 与 `test_greeting_protocol.py`。已核对实现和测试场景；devserver 没有项目 `.venv/bin/pytest`，系统 Python 也未安装 pytest，因此本轮未运行 Python 回归。

## 验收边界

- `main.ts` 已把真实 PostgreSQL pool、Local 存储根、BYOK 主密钥适配、安全 Provider transport 和可选 Redis 接入生产 Host 入口；此处是代码接线证据，不等同运行服务验收。
- PostgreSQL 查询和 owner 过滤有 Host 适配回归，但没有隔离 PostgreSQL 服务验收；SQLite 尚未接入。
- Redis 命令适配使用合成命令对象验证 SET NX、TTL 和 token 比对释放；真实 Redis 未验收。
- BYOK 绑定与 Provider 配置组合已做合成回归；本轮没有真实 Provider 调用，也没有真实部署或真实用户数据验收。
