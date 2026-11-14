# Node WebUI Local 文件复制路径

## 范围

接入 `POST /api/v1/files/{fid}/copy`，由 Node Host 认证并从请求上下文确定 owner，Local PostgreSQL adapter 负责复制和覆盖文件。实现覆盖目标空间校验、重名副本、物理文件暂存与失败补偿、版本推进、配额事件、canonical file change、撤销记录及提交后资源事件。覆盖复制遵循 Python API 的 `create` 事件语义；复制到自身仍记录撤销上下文并刷新权威实体。未改项目/日历或 OSS 路径。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- `tests/files/file-copy-route.test.ts`：通过，验证认证、owner、目标参数、元数据和无效请求响应。
- 隔离 PostgreSQL `tests/files/file-copy-postgres.test.ts`：通过，验证重名复制、覆盖正文/版本/配额、稳定配额操作键、自身复制收据及 owner 隔离。
- Node 文件域 `tests/files/*.test.ts`：**58/58 通过，0 跳过**。
- Python 基准 `test_files_api.py`、`test_file_service.py`、`test_undo_files.py`：**91 项通过**，串行运行。
- PostgreSQL 测试使用临时 schema 和合成文件目录，结束后删除 schema 与临时目录。全部测试在 devserver 原生执行，未使用 Docker。

## 边界

本切片只接入单文件复制。批量删除/移动、归档/解档和表格预览仍待迁移；未在真实用户文件目录验收。未触发 CI，未提交代码。
