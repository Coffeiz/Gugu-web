# Node WebUI 工作区删除当前树验证

## 行为基准

前端 `frontend/src/services/api.ts` 的 Workspace API 调用 `DELETE /workspaces/{id}`。Python 路由委托 `backend/app/services/workspaces.py::delete_workspace`：仅删除工作区记录；解绑当前用户的会话；停用并解绑普通计划任务；依赖外键清除文件同步绑定、终端会话等引用；保留项目和文件目录。OSS 专用拒绝逻辑不迁入 Gugu 2.0。

Python 最近邻回归：

- `tests/terminal/test_shell_workspaces.py::test_workspace_can_be_renamed_disabled_and_deleted_without_deleting_project`
- `tests/scheduling/tasks/test_scheduled_task_workspace.py::test_deleting_workspace_disables_bound_scheduled_tasks`

## Node Host 当前实现

Node 路由已使用认证上下文中的 owner ID；PostgreSQL adapter 在事务内锁定并校验工作区归属，解绑 owner 会话与普通计划任务，再删除工作区。现有 Node 回归覆盖认证/owner、响应兼容、跨 owner 拒绝、中途失败回滚；隔离 PG fixture 还覆盖项目保留、外键清理、日历类任务保持启用及终端绑定释放。

本轮只验证了既有实现，没有修改工作区删除代码。

## 验证结果

- devserver Python 两个最近邻 pytest：**2/2 通过**。
- devserver Node 路由、事务行为和隔离 PG 测试集合：**5 通过、0 失败、1 个隔离 PostgreSQL 用例跳过**。跳过原因是未设置 `GUGU_WEBUI_TEST_DATABASE_URL`，不可计为通过。
- devserver `gugu-webui` typecheck 当前失败于其它并行改动：`admin-llm-presets.ts` 缺少 `mask`，`auth/persistence/quota.ts` 引用了尚未同步的 `shared/date-key.js`，`file-batch-download-postgres.ts` 引用未定义的 `loadFolderFiles`。这些错误不在 Workspace 删除文件中。
- Vite 首页返回 200，但经 Vite 请求工作区删除返回 502；直连 Node Host `9595` 无监听。故本轮没有证明运行中 Vite→Node Host 守卫链。先前未认证请求返回 401 仅作为历史路由守卫证据。
- devserver 没有隔离 PostgreSQL URL；本机回环 5432 无 PostgreSQL 响应，且没有 `postgres`/`pg_ctl` 服务端二进制。因此本轮无法运行真实 PostgreSQL 集成测试。

## 最小后续条件

在 devserver 提供指向隔离 schema 的 `GUGU_WEBUI_TEST_DATABASE_URL`，并在并行代码收敛后恢复 Node Host 监听，再重跑 `workspace-delete-postgres.test.ts`、相关 Node typecheck 与 Vite→Node Host smoke。不得改用用户业务数据库代替隔离测试库。
