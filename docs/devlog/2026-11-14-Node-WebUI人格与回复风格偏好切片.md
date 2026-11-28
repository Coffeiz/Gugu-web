# Node WebUI 人格与回复风格偏好切片

## 目标与范围

在已有通用偏好 GET/PATCH 的基础上，迁移仍被前端调用的回复风格、个人人格和群聊人格 API。SMTP 与邮件预览/发送接口不属于本切片；WebUI OSS 行为不在 Gugu 2.0 范围内。

## 实现

- `GET /api/v1/preferences` 读取并规范化三个隐藏文本文件，并保留 Python 的 snake_case 偏好行、camelCase 响应、人格更新时间与历史回复风格 JSON 迁移行为。
- `PATCH /api/v1/preferences/reply-style` 与三个上传接口接入 UTF-8、文件扩展名、40,000 字节上传上限、10,000 字符内容上限和控制字符校验；通用 PATCH 支持人格正文与开关。
- 文本写入 `<storage root>/<owner>/.agent/prompt/` 下的 Local 隐藏文件，拒绝路径越界和 symlink 目录，临时文件原子替换，文件权限为 owner-only。
- 正文或相关开关变化后，失效该用户 Agent 会话快照并递增 `preferences` 上下文版本；重复提交相同正文不会重复递增文本版本或失效快照。
- `agent.personality_preference_enabled` 的 config override 优先于 `AGENT__PERSONALITY_PREFERENCE_ENABLED`，默认沿用 Python 的开启值；关闭时响应标记不可用，写入端点返回 403。

## 验证

所有验证在 devserver 执行：

- Node 偏好与配置定向套件：**15 通过、0 失败、1 个 PostgreSQL 集成用例跳过**。跳过原因是未配置隔离测试数据库 URL；没有用真实用户数据库替代。
- 偏好模块及关联测试的严格 TypeScript 检查通过；完整 `npm run typecheck` 和 `npm run build` 均通过。
- Python preferences API、route、context 与 cache 基线串行 **18/18 通过**。
- Vite 首页返回 200；未认证 `/api/v1/preferences` 返回 401，验证代理到 Node Host 及认证守卫，不代表已验收 PostgreSQL 写入或真实登录态操作。

## 测试保护的回归

- 覆盖历史偏好值归一化、旧回复风格 JSON 向隐藏文件迁移、owner 由认证身份决定。
- 覆盖文本规范化、内容版本递增、上下文快照失效、重复正文不重复失效、功能开关拒绝路径。
- 覆盖 Host 只注入 PostgreSQL Preferences Store 时，由 Store 提供的快照失效与上下文版本端口仍被实际调用。
- 覆盖上传扩展名、UTF-8、字节/字符上限，以及隐藏文件读写、删除和 symlink 越界防护。

## 未验收

- Node PostgreSQL 隔离 schema 测试被跳过，实际 PostgreSQL 偏好行更新与 `conversation_sessions.snapshot_expires_at` 更新尚未在隔离库验证。
- 没有认证态浏览器表单验收；未读写 devserver 用户偏好数据。
- 后续用户 SMTP 配置 GET/PUT 与测试发送已在独立切片迁移；邮件预览仍待迁移，见[用户 SMTP 配置切片](./2026-11-14-Node-WebUI用户SMTP配置切片.md)和[SMTP 测试发送切片](./2026-11-14-Node-WebUI用户SMTP测试发送切片.md)。
