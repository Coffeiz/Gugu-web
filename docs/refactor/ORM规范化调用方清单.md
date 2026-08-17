# ORM 规范化调用方清单

> 用途：记录已经迁移到 Service 的领域，其 API、Agent、任务调用方和事务边界。这里只记录边界，不复制业务实现。

## 画布域

| Service 入口 | API 调用方 | Agent 调用方 | 事务边界 | 状态 |
| --- | --- | --- | --- | --- |
| `app.services.mind_canvas` | 画布列表、节点、关系、引用节点和置顶 API | `agent.tools.mind_canvas` | Agent `SkillRegistry.dispatch` 统一提交；Service 默认 `flush`；批量操作自身保证原子提交/回滚 | 已完成 |

画布 API 已完成迁移：画布列表/创建/更新/删除、画布节点列表/新增/便签新增/节点更新/移除、节点置顶，以及画布内关系查询/创建/删除和引用节点创建均复用 `app.services.mind_canvas`。

时间流便签 API 的列表、创建、乐观锁更新和软删复用 `app.services.mind`；Service 默认只 flush，API 负责 HTTP 事务提交和冲突响应。

## 已完成的 Agent 收口

以下 Agent 工具不再直接导入 Model、SQLAlchemy 或 ownership helper，查询和写入通过对应 Service 完成：

- 思维画布、思维笔记
- 日历、项目、定时任务
- 文件、回收站
- 群上下文、历史对话、搜索用量

Agent 工具的任务级事务由 `agent.tools.base.SkillRegistry.dispatch` 统一处理：handler 正常返回后提交；handler 抛异常时由 Session 上下文回滚。

客户 API 已复用 `app.services.clients` 的列表、创建、归属读取和删除入口；日历提醒、独立定时任务、搜索用量的写入 Service 也已改为默认 `flush`，由 Agent 任务边界提交。

## 兼容入口清理记录

- 画布 Agent 的 `_canvas_item` 旧包装已删除，调用方直接使用 Service 的 `get_canvas_item`。
- `app.core.mind_canvas` 保留原子领域逻辑，不作为查询/事务入口。
- 画布 API 和时间流便签 API 的历史 ORM 查询/写入已删除，API 只保留 HTTP 参数、异常和提交边界。

## 后续清单

- [x] 将画布 API 的平行查询/写入实现迁移到 `app.services.mind_canvas`。
- [x] 为日历提醒、独立定时任务、客户和搜索用量 Service 补齐默认 `flush`、Agent task `commit` 边界。
- [x] 为后台清理、身份、账户删除、文件诊断等非 Agent Service 单独核对事务边界；这些入口保留各自的外部存储、附件清理或独立 DB 事务语义。
- [x] 迁移完成后删除时间流 API 的旧查询/写入入口，并将新增领域路径纳入静态边界检查。

## 后台 Service 事务核对结论

- `account_deletion.delete_account`：先清理外部存储和 Redis，再删除用户及级联数据并提交；不可拆成普通 flush，否则会留下已删除账号的外部数据或提前提交半个注销流程。
- `conversation_cleanup.remove_session_with_attachments`：先在 DB 事务内删除消息/附件关系，提交成功后才清理物理附件；`commit=False` 仅供更大事务复用。
- `im_identity.consume_qq_binding_code`：使用独立短事务原子占用绑定，成功后消费 Redis 挑战码。
- `storage.folder_doctor.repair`：补目录和扫描是外部存储动作，只有实际搬迁导致 ORM 文件路径变化时才提交数据库。
