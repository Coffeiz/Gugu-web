---
name: testing
description: 测试约定。pytest 基座、vitest 要求、E2E Playwright 标准、回归测试写法、禁止改断言规则。写或改测试前必须阅读。
---

# 测试约定

## 后端（pytest）

- 跑法：`PYTHONPATH=. .venv/bin/pytest`（devserver 上跑）。
- 测试基座在 `backend/tests/conftest.py`：
  - `db` fixture 给每个测试一个全新的内存 SQLite（`StaticPool` 共享同一条连接），测完即弃。
  - `user_a`/`user_b` 是标准的多用户越权测试姿势：B 拥有资源，A 拿着 B 的资源 id 调工具，必须得到"不存在"而不是数据。
  - `_reset_redis_client`（autouse）测试结束后重置 `app.core.redis` 的模块级客户端单例。
  - 模型列类型要方言无关（`Uuid`/`JSON`/`Text`…）——SQLite 能直接建表。

## 前端单测（vitest）

- 跑法：`npm run test:run`（一次性）或 `npm run test`（watch）。
- 改完纯逻辑/composable 之后必须跑。
- 测试失败时先定位实现、夹具和调用链，**不得直接改断言、删除用例、增加 `skip` 或放宽校验来恢复绿色**。
- 只有产品契约明确改变并完成记录后才调整预期。
- 回归用例名称和注释要写明防止的具体回归行为，至少包含触发路径和关键结果。

## E2E（Playwright）

配置在 `frontend/playwright.config.ts`，用例在 `frontend/e2e/*.spec.ts`。

### CI 只接确定性的关键路径

CI 目前只跑：`file-lifecycle`、`scheduled-task-run`、`chat`、`calendar`。

新增用例接 CI 的标准：
- 不依赖测试账号的既有数据（每轮 CI 全新数据库）。
- 不接真实模型——CI 用 `backend/scripts/mock_llm_server.py`。断言只验证"收到了 AI 回复"，不抠固定文字。
- 不需要真实设备权限或第三方账号绑定。

新增 CI 用例需同时改 `.spec.ts` 文件和 workflow 中的 `npx playwright test` 文件列表。

### 选择器约定

- 有 `title`/文本的交互元素：`page.getByRole('button', { name: '登录' })`。
- 没有语义信息的容器：直接用现有 CSS class（如 `.chat-window`），改了要跟着改测试。
