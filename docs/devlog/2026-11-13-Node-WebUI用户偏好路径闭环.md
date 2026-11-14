# Node WebUI 用户偏好路径闭环

## 目标与范围

前端在启动时通过 `preferencesApi.get()` 读取用户界面与工作区设置，并通过 `PATCH /api/v1/preferences` 保存语言、主题、默认视图、Shell 开关、自动模式、IM 工具展示等偏好。原 Node Host 未注册这两个端点，导致该路径依赖 Python。

本次接入通用偏好读取和部分更新：路由从认证后的 Host 身份取得 owner，PostgreSQL 适配器使用 `user_preferences` 的既有 JSON 文档。返回值遵循 Python 默认值、camelCase 响应和历史 palette/tool mode 归一化；PATCH 保留未触及的存储键。人格正文、回复风格文件、SMTP 与邮件操作明确返回不可用，不会伪报成功。存储范围保持 Local-only，不涉及 OSS。

## Python 行为基准

- `backend/app/api/v1/preferences.py`：`get_preferences` 与 `update_preferences`。
- `PreferencesResponse` / `PreferencesUpdate` 约定由 `backend/app/schemas/__init__.py` 定义。
- `backend/tests/platform/preferences/test_preferences_route.py` 新增路由行为回归，覆盖新用户默认值、locale/theme/自动模式与模板更新、后续局部更新保留之前值，并确认数据只写入该用户偏好行。
- `test_preferences_api_contract.py` 与 `test_preferences_cache_contract.py` 保留人格设置和缓存契约回归。

devserver 串行运行：上述三个 Python 测试文件 **11/11 通过**。devserver 原系统 Python 没有 pytest；为运行测试，在 `/tmp` 建立了继承系统站点包的临时 pytest 环境，并安装缺失的测试运行依赖及本仓库本地 `gugu-core` 包。没有读取或改写运行配置。

## Node Host 接入与验证

- `gugu-webui/src/domains/preferences/preferences.ts` 提供受保护的 GET/PATCH；只接受已定义的通用偏好字段，认证身份外传入的 owner 信息不会决定读写用户。
- `gugu-webui/src/domains/preferences/persistence/postgres.ts` 读写现有 PostgreSQL `user_preferences` 表。
- `app.ts` 注册认证域，`main.ts` 注入 PostgreSQL store。
- `preferences.test.ts` 和 `preferences-host.test.ts` 覆盖默认值、历史数据归一化、局部合并、拒绝未开放字段及 Host 认证 owner；**5/5 通过**。
- `preferences-postgres.test.ts` 在随机隔离 schema 中走完整 Host 路由，验证首次默认值、连续局部更新和不同 owner 的隔离；**1/1 通过**，未计任何跳过用例。
- devserver `npm run typecheck` 通过。Vite 代理与直连 Node Host 的未认证 GET 都返回 **401**；这是路由/守卫烟测，不替代上面的业务和 PG 测试。
- `git diff --check` 通过；未使用 Docker、未触发 CI、未提交。

## 尚未迁移或未验收

- Node Host 的人格/回复风格文件与上下文失效通知、用户 SMTP、邮箱变更邮件等仍未接入；这些能力需要 Node Local 文件适配器、上下文/事件联动或 SMTP sender 后再闭环。当前偏好响应明确显示人格能力未开放，相关 PATCH 会拒绝请求。
- PostgreSQL 行为由隔离 schema 的集成测试验收；devserver 用户的真实偏好数据未读取或修改。
- 未做带真实登录态的浏览器交互验收；Vite 烟测只覆盖未认证守卫。

## 当前树回归补记（2026-11-13）

- 对照 Python `update_preferences`，Node PATCH 原先会保留已废弃的 `shell_autopilot_enabled` JSON 键；现已在每次通用偏好更新时移除，并新增回归覆盖空值/非法可选值不覆盖原值。
- devserver Node 偏好行为与 Host 测试 **6/6**、随机 schema PostgreSQL **1/1** 通过，0 跳过；Python 路由与 API 合约 pytest 串行 **7/7** 通过；`@gugu/webui` typecheck 通过。
- Vite 与直连 Node Host 对未认证 `/api/v1/preferences` 均返回 **401**。没有认证态浏览器验收；此项仅证明代理和认证边界。
- 以上仍只完成通用偏好子集。人格、回复风格文件、SMTP/邮件能力保持未迁移，不计入完成；未使用 Docker、未改运行配置、未触发 CI、未提交。

## Vite 认证读写与隔离 PG 补验（2026-11-13）

- 新增 `gugu-webui/tests/host/preferences-vite.integration.test.ts`：通过 Vite 代理，以合成 cookie/CSRF 会话请求 Node Host，再写入随机隔离 PostgreSQL schema。
- 覆盖已认证 GET 的历史值读取、PATCH 局部合并、未知 JSON 键保留、废弃字段移除及最终持久化内容；不使用真实账号或业务 schema。
- devserver Node 偏好定向套件 **8/8 通过、0 跳过**，TypeScript 检查通过；Python `test_preferences_route.py` **1/1 通过**。
- 这是跨层 HTTP/PG 行为验收，不是浏览器表单点击验收；当前偏好支持范围和未迁移能力仍按上文边界处理。未使用 Docker、未触发 CI、未提交。
