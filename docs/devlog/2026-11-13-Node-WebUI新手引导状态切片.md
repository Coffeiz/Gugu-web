# Node WebUI 新手引导状态切片

## 范围

前端 `onboardingApi` 在首次引导和用户设置中读取、保存引导进度，并允许用户重新打开引导。Python 原有实现还包含开发用重播种和重置接口；本切片只迁移正式用户使用的状态读取、更新与重新打开路径。

## 实现

- Node Host 接入 `GET/PATCH /api/v1/onboarding/state` 与 `POST /api/v1/onboarding/state/reopen`，从认证上下文取得 owner ID。
- PostgreSQL adapter 按当前用户的 `onboarding_state` 行加锁后合并 guide 字段，避免并发写覆盖；首次读取为缺少状态的用户建立默认行。
- 更新只接受引导步骤、完成步骤、dismissed、completed_at 和 guide_version。禁止改写 seed 字段，步骤和值域错误返回 422。
- 响应兼容旧扁平状态，保留 seed 内容、未知顶层字段和 guide 中的扩展字段。重新打开只清除 dismissed/completed_at 并切回当前版本，不清空已完成步骤。

## 验证

以下检查均在 devserver 执行：

- Node Host 定向测试：1 通过、0 失败；覆盖未认证拒绝、owner 隔离、字段校验、步骤去重、seed 保留和 reopen 行为。
- PostgreSQL 集成测试：因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过，真实数据库持久化仍待隔离测试库验收。
- TypeScript `pnpm typecheck`：通过。
- Python 基准 `tests/platform/auth/test_onboarding_state.py`：3 通过。
- Vite 首页 200、Node readiness 200；Vite 代理和直连 Node Host 的未认证 onboarding GET 均返回 401。

## 未完成边界

注册后的 onboarding seed 尚未接入 Node；开发用 `/onboarding/dev/reseed` 和 `/onboarding/dev/reset-guide` 仍由 Python 提供。reseed 依赖 Local 项目、文件和日历数据，不在本切片扩展其写入行为。
