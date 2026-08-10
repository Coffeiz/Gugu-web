# 测试约定

跨前后端的测试规则统一收在这份文档；具体的代码风格分别见 `docs/development/backend.md`、`docs/development/frontend.md`。

## 后端（pytest）

- 跑法：`PYTHONPATH=. .venv/bin/pytest`（devserver 上跑，见 `AGENTS.md`）。
- 测试基座在 `backend/tests/conftest.py`：
  - `db` fixture 给每个测试一个全新的内存 SQLite（`StaticPool` 共享同一条连接），测完即弃，测试间零污染，也不碰任何真实数据/外部服务。
  - `user_a`/`user_b` 是标准的多用户越权测试姿势：B 拥有资源，A 拿着 B 的资源 id 调工具，必须得到"不存在"而不是数据。新增涉及权限边界的功能，跟着写一条这种测试。
  - `_reset_redis_client`（autouse）测试结束后重置 `app.core.redis` 的模块级客户端单例——不这样接的话，Redis 连接会绑死在某个测试的事件循环上，下个测试复用到已关闭循环的连接，报 `Future attached to a different loop`，且只在特定顺序组合下触发，表现为跟执行顺序有关的 flaky。
  - 模型列类型要方言无关（`Uuid`/`JSON`/`Text`…）——SQLite 能直接建表；引入 `JSONB`/`ARRAY` 等 PG 专属类型会在 `create_all` 时立刻报错，届时再迁真 PG。
- 涉及权限、删除或工具确认这类高风险改动，除了 pytest 再补运行额外的静态检查（见 `docs/development/backend.md`）。

## 前端单测（vitest）

- 跑法：`npm run test:run`（一次性）或 `npm run test`（watch）。
- 改完纯逻辑/composable 之后必须跑；改完成功能或提交前跑一次完整 `npm run typecheck`（涉及 `frontend/tsconfig.strict.json` 白名单里的文件用 `npm run typecheck:strict`，见 `docs/development/frontend.md`）。

## E2E（Playwright）

配置在 `frontend/playwright.config.ts`，用例在 `frontend/e2e/*.spec.ts`。

### CI 只接确定性的关键路径

`.github/workflows/runtime-integration.yml` 的 `e2e` job 目前只按文件名显式跑这几条（不是跑全部 `e2e/*.spec.ts`）：

```
npx playwright test e2e/file-lifecycle.spec.ts e2e/scheduled-task-run.spec.ts e2e/chat.spec.ts e2e/calendar.spec.ts
```

**新增用例要不要接进 CI，标准是"能不能做到完全确定"**：

- 不依赖测试账号的既有数据（每轮 CI 都是全新数据库）。
- 不接真实模型/真实第三方服务——CI 里 `AI__BASE_URL` 指向 `backend/scripts/mock_llm_server.py`（固定文本回复、不带 `tool_calls`），避免真实模型的不确定性/限流/花钱。写断言时不要死抠这个固定回复的具体文字（那样测试就只能在 CI 有效）——只断言"确实收到了一条新的 AI 回复"（比如消息数量变化），这样同一条用例在本地/devserver 接真实模型跑也有意义，见 `frontend/e2e/chat.spec.ts` 的写法。
- 不需要真实设备权限（录音）或第三方账号绑定（IM 扫码连接）——这类场景硬做用例，大概率靠 `test.skip()` 兜底，会出现"全绿但什么都没测"的假象，宁可不接 CI，留给人工验收清单（例如 `docs/refactor/【已完成】GuguChat组件拆分重构方案.md` 第九节）过一遍。
- 现有的 `filesystem-phases.spec.ts` 等用例大量依赖长期测试账号的既有数据，属于历史遗留、不接 CI，新用例不要照抄这个模式。

新增一条要接 CI 的用例，两处都要改：加 `.spec.ts` 文件本身，以及上面 workflow 里那行 `npx playwright test` 的文件列表（不加的话 CI 不会跑它，会出现"写了但没生效"的假象）。

### 本地/devserver 手动跑

```bash
cd frontend
cp .env.e2e.local.example .env.e2e.local   # 只需一次，填测试账号密码（不要提交，已在 .gitignore）
./e2e/run-local.sh e2e/chat.spec.ts         # 不传参数就跑全部
```

`PLAYWRIGHT_BASE_URL` 默认指向 `http://127.0.0.1:5173`；devserver 上要跑之前，先确认 5173 端口的 vite dev server 是活的、能正常返回登录页（`curl http://127.0.0.1:5173/login`），不要在它跑着的时候手动删 `node_modules/.vite`——预构建缓存和进程内存状态对不上，会让页面一直 504（`Outdated Optimize Dep`），得重启那个 vite 进程才能恢复。

### 选择器约定

现有用例按元素的语义信息选，不新增 `data-testid`：

- 有 `title`/文本的交互元素：`page.getByRole('button', { name: '登录' })`、`.locator('[title="展开"]')`。
- 没有语义信息的容器/状态类：直接用现有 CSS class（如 `.chat-window`、`.msg.ai .msg-bubble`、`.exp-session-item.active`），这些 class 本身就是组件对外稳定的结构标记，改了要跟着改测试。
