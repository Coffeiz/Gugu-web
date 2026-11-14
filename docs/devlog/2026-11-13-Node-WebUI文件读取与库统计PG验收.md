# Node WebUI 文件读取与库统计 PG 验收

## 范围

补齐 `GET /api/v1/files/{fid}`、`GET /api/v1/files/{fid}/location`、`GET /api/v1/files/summary`、`GET /api/v1/files/library-counts` 与 `GET /api/v1/files/storage` 的真实 PostgreSQL 回归。路由继续从认证 Host 上下文取得 owner；查询验证 owner 过滤、文件/项目/文件夹关联、回收站分类计数、近期记录限制，以及配额账本优先于文件汇总的行为。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**66/66 通过，0 跳过**，包含临时 schema PostgreSQL 端到端测试。
- Python 文件 API 与分页/路径基线：**47 项通过**，串行运行。
- PostgreSQL 测试以合成 owner/数据建临时 schema；执行后删除 schema，未连接或修改用户数据目录。
- 所有命令在 devserver 原生环境运行；未使用 Docker。

## 边界

缩略图、XLSX 预览和压缩/解压路由仍未迁移；尚未以真实用户账号执行 Vite 登录态验收，未触发 CI，未提交代码。
