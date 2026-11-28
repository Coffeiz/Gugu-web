# Node WebUI 用户 SMTP 配置切片

## 目标与范围

迁移用户 SMTP 配置读取与保存：`GET /api/v1/preferences/smtp`、`PUT /api/v1/preferences/smtp`。配置与测试发送现已分别迁移；邮件预览接口仍待迁移，详见[SMTP 测试发送切片](./2026-11-14-Node-WebUI用户SMTP测试发送切片.md)。WebUI OSS 不属于 Gugu 2.0 支持范围。

## 实现

- Node 路由复用用户认证身份确定 owner，校验主机、端口、账号、发件地址、SSL 和启用状态。
- PostgreSQL 只查询配置展示字段，不读取密码；更新时密码可省略或传 null 以保留已有密文。
- 新密码由 HKDF-SHA256 派生密钥后使用 AES-256-GCM 加密，存储格式与 Python `EncryptedString` 一致；API 响应不包含密码。

## 验证

所有验证均在 devserver 完成：

- Node 偏好定向套件：**16 通过、0 失败、1 个隔离 PostgreSQL 用例跳过**；跳过原因是未配置隔离测试数据库 URL。
- `npm run typecheck` 与 `npm run build` 通过。
- Python 偏好 API/路由/context/cache 与用户 SMTP API 最近邻基线串行 **19/19 通过**。
- 使用合成密钥和密码生成 Node 密文，并由 Python `AESGCM` 解密成功，验证跨语言存储格式兼容。
- Vite 首页返回 200，未认证 `/api/v1/preferences/smtp` 返回 401。

## 未验收

- 隔离 PostgreSQL 环境未配置时，不以真实用户数据库替代；真实 PG upsert 尚未验收。
- 未执行真实 SMTP 发送；邮件预览接口仍待迁移。
