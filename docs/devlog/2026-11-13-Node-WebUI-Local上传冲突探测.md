# Node WebUI Local 上传冲突探测

## 范围

接入只读 `POST /api/v1/files/check-conflicts`。Host 从认证请求取 owner，PostgreSQL 按 owner、空间、项目、文件夹及 Workspace 目录匹配，按输入顺序返回，并保留 Python 对点文件和无扩展名文件的命名拆分规则。冲突响应中的现有文件使用 Python `model_dump()` 的 snake_case 字段。未改项目/日历或 OSS 路径。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**60/60 通过，0 跳过**，含隔离 PostgreSQL、Host 认证及非法输入用例。
- Python `test_files_api.py`、`test_file_service.py`、`test_undo_files.py`：**91 项通过**，串行运行。
- 隔离 PostgreSQL 测试只使用临时 schema 与合成数据，完成后删除 schema；未使用 Docker。

## 边界

只覆盖查询冲突的 Node 路径；presign/confirm 和 OSS 上传路径不在此切片，2.0 OSS 支持由并行会话移除。未在真实用户数据上测试，未触发 CI，未提交代码。
