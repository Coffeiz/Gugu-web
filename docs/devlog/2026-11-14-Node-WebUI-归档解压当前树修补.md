# Node WebUI 归档与解压当前树修补

## 范围

修复 Local 归档实现的共享当前树类型错误，并把纯文件夹归档项构造规则收口到 `file-archive-rules.ts`。PostgreSQL adapter 对递归查询结果声明文件夹树与文件记录类型，避免空结果分支把必要字段退化为泛型 `Row[]`。

这次修补没有改变 Python 的归档格式、命名冲突、路径安全或容量上限语义。规则测试覆盖嵌套文件夹以所选根目录为 ZIP 根、子目录层级、扩展名冲突和无效归档路径。

## 验证

- devserver Node 26.13.1：归档/解压定向套件 9 项，8 通过、0 失败、1 个隔离 PostgreSQL 用例因缺测试 URL 跳过。
- devserver Python：`test_files_archive.py` 与 `test_files_archive_api.py` 共 33/33 通过。
- devserver `pnpm run typecheck`：通过。
- `git diff --check`：通过。

## 未完成验收

当前 devserver shell 没有隔离 PostgreSQL 测试 URL，因此这次没有验证真实 PostgreSQL 文件记录与 Local 文件往返，也没有用认证请求走完整 Vite→Node Host→PostgreSQL 路径。迁移清单仍将这两条接口标为部分完成，不把跳过的 PG 用例计为通过。
