# Node WebUI Local 文件夹 ZIP 下载

## 范围

接入前端仍在使用的 `GET /api/v1/folders/{fid}/download`。复用批量下载的 PostgreSQL owner 过滤、Local 安全文件读取和 ZIP 生成；响应以文件夹名生成安全附件名，保留目录层级。不存在或越权文件夹返回 404；空文件夹返回有效空 ZIP。实现仅使用 2.0 Local 文件，不接入 OSS。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**67/67 通过，0 跳过**；隔离 PostgreSQL 覆盖嵌套文件、owner 隔离、空文件夹和 ZIP 正文，Host 测试覆盖认证及 Unicode 附件名。
- Python 文件夹 API 基线：**14 项通过**，串行运行。
- 所有测试在 devserver 原生环境执行；未使用 Docker。

## 边界

尚未做真实用户 Vite 登录态下载验收，未触发 CI，未提交代码。
