# Node WebUI 文件夹创建、改名与移动写路径

## 目标

将 Python `create_folder`、`rename_folder`、`move_folder` 的 Web 写路径接入 Node Host，同时保留认证 owner、空间归属、版本冲突、撤销记录、Local 路径镜像和提交后资源事件语义。

## 实现

- 创建和改名通过 Host 认证后从请求上下文取得 owner，不接受客户端提交的用户标识。
- 移动接口兼容 Python 的 camelCase / snake_case 字段，并区分字段缺省与显式 `null`，从而保持跨个人、项目和 Workspace 空间移动时的归属更新语义。
- PostgreSQL adapter 在 owner 文件夹树 advisory lock 和事务内校验目标空间、版本、子树环路与同名冲突；移动时更新子树 scope，路径 planner 搬迁 Local 文件 key，并记录 Undo。提交后清理旧目录骨架并发布资源变更。
- 失败事务会回滚路径镜像；已提交写入不会因为旧目录清理或事件发布失败而误报为失败。

## 验证

- devserver Node 26.13.1：文件夹路由、Host、PostgreSQL adapter 和路径 planner 定向回归 **16/16**，无失败或跳过。
- devserver Node TypeScript 检查：`pnpm exec tsc --noEmit` 通过。
- devserver Python 参考回归：文件夹 API、文件夹回收站和文件服务共 **79/79**。
- Vite 5174 与 Node Host 9595 的未认证 `PATCH /api/v1/folders/42/parent` 均返回 **401**，证明代理、路由和认证守卫存在；没有执行认证后的业务写入。
- Node adapter 测试使用 mock Pool；devserver 当前未提供隔离 PostgreSQL URL，真实隔离 PG SQL、登录态 HTTP 写入和 Local 文件系统事务仍未验收。未使用 Docker。

## 后续

文件夹软删除、恢复和复制尚未迁移。当前写入 adapter 的复杂度扫描含较多新符号结构性提示；后续拓展前应继续按操作拆分事务编排和路径搬移职责，避免继续增大单一操作函数。
