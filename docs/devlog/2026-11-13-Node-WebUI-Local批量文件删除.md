# Node WebUI Local 批量文件删除

## 范围

接入认证后的 `POST /api/v1/files/batch-delete`。PostgreSQL adapter 在单事务中锁定当前 owner 的有效文件、按稳定顺序获取 filesync 路径锁、移动 Local 正文并递增版本，使用一个 Undo 收据覆盖本批实体，提交后发布资源事件。空列表无写入并返回 204；其他 owner 的 ID 被忽略。事务失败时回滚 SQL 并按逆序恢复已移动正文。

## devserver 验证

- Node 26 `@gugu/webui` typecheck：通过。
- Node 文件域 `tests/files/*.test.ts`：**63/63 通过，0 跳过**；批量 PG 用例还验证第二个文件 SQL 更新失败时，首个物理移动也会补偿，数据库、文件和事件保持未提交状态。
- Python 文件 API/service/Undo 与文件分页/路径基准：**101 项通过**，串行运行。
- PostgreSQL 使用临时 schema 与合成文件目录，结束后删除 schema 和目录；未使用 Docker。

## 边界

只接入批量软删除；批量下载、压缩/解压仍待迁移。未在真实用户文件目录验收，未触发 CI，未提交代码。
