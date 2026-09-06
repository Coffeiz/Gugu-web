# 文件同步 Phase 5

## 目标

把本地文件同步接入 Admin 存储对账页面，提供脱敏运行状态、绑定 dry-run、
绑定对账、冲突逐项处理、失败/重试观测，并保持 OSS 的独立沙盒边界。

## 实施结果

- 新增 `app/services/filesync/admin.py` 作为 Admin 编排层；文件投影仍统一复用
  `filesync.bindings`，没有在 API 或页面复制同步规则。
- 新增 `/api/v1/admin/filesync/status`、绑定 dry-run/对账和冲突恢复接口，Admin
  路由复用统一 `require_admin`。
- 状态接口不返回文件正文、服务器绝对路径或异常文本，只返回相对路径、计数、状态码
  和指纹是否存在；OSS 下隐藏历史本地绑定和冲突列表并报告忽略数量。
- 物理对象孤儿导入/删除接口增加后端 `confirm`，前端仍使用统一确认弹窗；绑定对账不
  自动删除物理文件，冲突保留云端/双方等写操作要求显式确认。
- 新增 `frontend/src/api/filesync.ts` 和 `components/filesync/FileSyncAdminPanel.vue`，
  StorageAudit 页面只负责组合，不复制 Admin filesync 请求和状态逻辑。

## 回滚

关闭 `sandbox.file_sync_enabled` 即停止新的同步操作；保留 journal、冲突、outbox 和
物理文件，不删除数据库记录，不执行 `down -v`。Admin 原有存储对账仍可独立使用。

## 验证

Phase 5 专项回归：27 passed；完整后端回归：2079 passed；ownership/confirm gate、
compileall、前端 strict typecheck、i18n scan、70 个测试文件/447 个测试、生产 build、
CSS glass 和 UI dialog 回归均通过。devserver 仅做代码同步、只读 Python 语法检查与
HTTP 健康检查，不修改运行配置、不执行迁移或重启。
