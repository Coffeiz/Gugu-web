# Node WebUI 文件元数据 PATCH 路径

## 范围

接入前端常用的 `PATCH /api/v1/files/{fid}` 改名和移动路径。实现保留省略字段与显式 `null` 的区别、owner 校验、版本 CAS、项目/Workspace/文件夹目标归属校验、Local PathMirror 搬迁补偿、文件冲突自动加序号、撤销记录和提交后资源事件。未改项目/日历或 OSS 路径。

## Python 行为基准

devserver 串行运行：

- `backend/tests/storage/files/test_files_api.py`
- `backend/tests/storage/files/test_file_service.py`
- `backend/tests/storage/files/test_undo_files.py`

结果：**91 项通过**。覆盖改名/移动、陈旧版本、跨用户访问、目标文件夹与空间校验、文本/二进制后缀保护及撤销行为。

## Node Host 验证

- Node 26 `@gugu/webui` typecheck：通过。
- `tests/files/file-update-route.test.ts`：1/1 通过，验证 PATCH 字段存在性与撤销上下文透传。
- 隔离 PostgreSQL `tests/files/file-update-postgres.test.ts`：1/1 通过，验证物理搬迁、版本推进、撤销状态、陈旧版本和 owner 隔离。
- Node 文件域全套 `tests/files/*.test.ts`：**56/56 通过，0 跳过**。
- PG 测试使用临时 schema 与合成文件目录，结束后删除 schema 和临时目录。

初次 PG 运行发现项目日期查询使用了不兼容的 SQL 别名；全文件域回归随后发现 PostgreSQL `date` 转 JS `Date` 后被 UTC 序列化成前一日，项目绑定找错月份目录，导致 canonical journal 缺失。改为 SQL 格式化 `start_date` 后，正文保存与项目绑定回归及全文件域回归均通过，未放宽断言。

Python 基准复跑结果：**91 项通过**。

## 边界

该 adapter 目前只覆盖文件 PATCH。文件复制、批量操作、归档/解档和表格预览仍未由 Node 接管。Node 文件 PATCH 已通过隔离 PostgreSQL 测试，但没有在真实用户数据或文件目录上验收。测试未使用 Docker、未触发 CI、未提交代码。
