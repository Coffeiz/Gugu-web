# Node WebUI 用户 SMTP 测试发送切片

## 范围

迁移 `POST /api/v1/preferences/smtp/test`。桌面设置页可提交 SMTP 参数、密码、收件人和邮件外观；省略收件人时使用当前认证用户邮箱。Gugu 2.0 WebUI 按 Local-only 方案运行，OSS 不在支持范围内。

## 实现

- Node Host 注册受认证保护的 SMTP 测试发送路由，并校验连接参数和邮件模板选项。
- 请求提供的密码优先；密码为空时通过 owner-scoped 查询读取已保存凭据。凭据解密兼容 Python `EncryptedString`、旧明文值和格式错误的历史值。
- SMTP 传输复用现有认证邮件 transport 创建逻辑；发送失败只返回通用错误提示，不向用户暴露 SMTP 原始异常。
- 通用偏好 GET/PUT 仍不读取或回显 SMTP 密码。

## 验证

- devserver Node 定向测试：22 项中 21 通过、0 失败、1 个隔离 PostgreSQL 用例因未设置测试库 URL 跳过。
- devserver Python 偏好与 SMTP 最近邻回归：21/21 通过。
- devserver TypeScript typecheck 与 build 通过。
- Vite 首页返回 200；未认证的 SMTP 测试发送请求返回 401，确认代理路由与认证守卫生效。

## 尚未验收

- 未连接真实 SMTP 服务发送邮件。
- 隔离 PostgreSQL 用例因测试库 URL 未配置而跳过；真实 PG 查询/写入行为未验收。
- `POST /api/v1/preferences/smtp/preview` 邮件预览仍待迁移。
