# Node WebUI Local 工作区 Vite 与 PostgreSQL 闭环

## 范围

为已接入 Node Host 的 Workspace Directory 用户路径补充真实 HTTP 集成证据，覆盖 Files 页面使用的目录列表、创建、改名、删除预览和删除接口。

## 验证的行为

- Vite 将 `/api/v1/workspace-directories` 请求转发到 Node Host；未认证请求返回 401。
- 登录 token 归属当前合成用户；目录列表不泄漏另一用户的记录。
- 创建会生成本地 Workspace 目录；改名保持稳定的磁盘目录名；删除提交后清除该目录。
- PostgreSQL 测试使用随机 schema；文件系统操作限定在一次性临时根目录并于测试后删除。

## 验证结果

- devserver Node TypeScript typecheck 通过。
- devserver Node workspace directory route、Host、PostgreSQL 与 Vite 集成回归共 **9/9 通过、0 跳过**。
- devserver Python 基准 `test_workspace_directories.py`、`test_workspace_canonical_mounts.py`、`test_folder_workspace_write_access.py` 共 **28/28 通过**。
- 本地没有运行测试。真实 sandboxd/PTy 进程及 Host ACL 权限行为未在本集成用例中启动；测试注入了临时目录创建端口，因此不能据此声称真实沙盒权限验收完成。

