# Node WebUI 用户 SMTP 邮件预览迁移

## 范围

迁移 `POST /api/v1/preferences/smtp/preview`，使开发邮件样式页可由 Node Host 返回预览 HTML。该路由只接收模板、主题和配色，不读取 SMTP 密码、不发信，也不依赖已保存的 SMTP 设置。

Node 渲染与 Python 路由保持相同的默认值、模板/主题/配色枚举、预览文案、主题颜色和 HTML 转义边界。Logo 通过前端静态资源路径使用 alpha mask 着色；预览资源由同源 Web 静态服务提供。

## 验证

- devserver Node 偏好路由与 Vite→Node Host 集成回归：14 通过，0 失败，0 跳过。覆盖未认证拒绝、无 SMTP 配置仍可预览、主题/配色/template 输出、非法主题拒绝及同源 Logo 静态资源可读。
- devserver Python 邮件模板、邮件能力和用户 SMTP 回归：13/13 通过。
- devserver `gugu-webui` TypeScript typecheck 通过。
- devserver Vite 代理对未认证预览请求返回 401，确认代理到达 Node Host。
- 未发送真实邮件；该路由不访问 Redis 或 PostgreSQL。

Vite 测试配置读取 Git 短 SHA 时，Mutagen 同步的 devserver 工作目录没有 `.git`，因此测试输出了一条 `git rev-parse` 错误；Vite 按既有配置回退构建时间戳，集成断言全部通过。

## 回归保护

认证和 SMTP 配置状态彼此独立，避免开发邮件样式页因为用户尚未保存 SMTP 配置而无法预览。主题、模板和配色仍由服务端枚举校验，非法值映射为 422。
