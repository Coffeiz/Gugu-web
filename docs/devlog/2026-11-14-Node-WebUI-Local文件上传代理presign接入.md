# Node WebUI Local 文件上传代理 presign 接入

## 问题

文件上传弹窗和项目卡片会先请求 `/api/v1/files/presign`，根据返回的 `mode` 选择 OSS 直传或 Local 代理上传。Node WebUI 已有 Local multipart 上传、配额和 PostgreSQL 存储实现，但缺少 presign 路由；切换到 Node 后前端会在上传前收到 404。

## 变更

- 在现有文件上传路由组中挂载受认证保护的 Local presign 路由。校验 Python `PresignRequest` 的必需和可选字段类型，返回 `{ mode: 'proxy' }`，不扫描用户存储或提前写入文件。
- 前端随后继续使用现有 multipart `/api/v1/files` 路径，由上传流程再次检查容量、owner/scope、冲突并写入文件和 PostgreSQL。
- 2.0 Linux/NAS 部署为 Local-only；OSS 直传专用 `/files/confirm` 不属于当前部署范围。

## 验证

- devserver Node `file-upload.test.ts`：5/5 通过，覆盖 proxy 选择后 multipart 文件实际进入存储适配器、畸形字段返回 422、配额拒绝、图片尺寸和表单顺序。
- devserver PostgreSQL Local 上传集成：1 项因未配置隔离测试库 URL 跳过，0 失败。
- Python `test_files_api.py` 与 `test_file_upload_service.py`：39/39 通过。
- devserver WebUI typecheck 通过。
- 运行态：Vite 与直连 Node 对未认证 `/api/v1/files/presign` 均返回 401；已确认 Host 路由挂载和认证边界。当前没有隔离 PostgreSQL 测试 URL，未验收认证上传的真实 PG 持久化。
