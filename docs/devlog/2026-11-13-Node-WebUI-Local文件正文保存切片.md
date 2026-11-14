# Node WebUI Local 文件正文保存切片

## 当前实现

`PUT /api/v1/files/{fid}/content` 已挂到 Node Host 用户认证域。owner 只从认证后的 RequestContext 获取；PostgreSQL adapter 按 owner 读取文件、执行版本 CAS，在 Local 存储中原子替换正文，并在同一事务内更新文件版本/大小、记录 Undo 前后内容附件。提交后发布文件资源更新事件。

路由将 JSON 传输体上限提高到 8 MiB，以容纳最大 1 MiB 正文的 JSON 编码开销；业务仍按正文 UTF-8 字节数限制 1 MiB，与 Python 服务合约一致。

## 验证

- devserver Node 26 `corepack pnpm --filter @gugu/webui typecheck` 通过。
- devserver Node 26 `corepack pnpm --filter @gugu/webui build` 通过。
- Node Host、正文路由、PostgreSQL adapter 定向测试 **19/19 通过，0 跳过**；其中 adapter 使用随机 schema 验证 owner 隔离、版本冲突、文件正文、Undo 附件和提交后资源事件，schema 与临时存储均在测试结束后清理。
- Python 参考行为在 devserver 串行复验 `tests/storage/files/test_files_api.py`、`test_undo_files.py`、`test_file_service.py`、`test_file_operations.py`、`test_filesync_phase1.py`，**172/172 通过**；路由请求体上限修正后再次运行 `test_files_api.py`，**37/37 通过**。
- 当前常驻 Node Host readiness 和 Vite 首页均返回 200；经 Vite 发起的未认证正文 PUT 返回 401，确认代理路由进入认证门。没有用真实账户经常驻 Vite 完成已认证的正文写入。
- 未使用 Docker，未修改用户运行配置。

## 未完成差异

Python 正文写入还会在事务中取得 filesync path advisory lock，并 best-effort 记录 canonical file change journal。Node 2.0 当前尚无完整 filesync 持久化适配器，因此此处没有移植这两项旁路行为；启用本地目录同步时可能缺并发协调和同步 journal。需随 filesync 迁移闭合，在此之前该 API 仅记为部分迁移。
