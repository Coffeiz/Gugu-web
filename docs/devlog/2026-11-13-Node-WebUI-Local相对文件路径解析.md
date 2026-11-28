# Node WebUI Local 相对文件路径解析

## 范围

接入 `POST /api/v1/files/{fid}/resolve-paths`，复用文件读取 Host 和 PostgreSQL adapter。验证批次与路径片段上限，拒绝绝对 URL/路径、反斜线和 NUL；相对路径仅在来源文件 owner 与逻辑 scope 内解析，并支持父目录、URL 编码、查询参数、文件和文件夹结果。无效相对目标返回空结果，来源文件不存在返回 404。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**62/62 通过，0 跳过**，包含隔离 PostgreSQL 和 Host 认证/路径边界用例。
- Python `test_file_listing_pagination.py`：**10 项通过**。
- PostgreSQL 测试使用临时 schema 和合成数据，结束后删除 schema；未使用 Docker。

## 边界

只迁移文本链接的相对文件路径查找；缩略图、XLSX 预览与压缩/解压仍未接入。未触发 CI，未提交代码。
