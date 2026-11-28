# 工作区正式 SQLite 迁移门槛

本记录是只读依赖审计与迁移策略，尚未实现正式迁移。不修改schema版本、现有CHECK、用户数据库或运行配置；三张合成表的reader回归不等于正式数据库就绪。

## 当前阻断事实

Core当前schema 10的`conversation_sessions.workspace_id`带`CHECK(workspace_id IS NULL)`；`scheduled_tasks`要求workspace_id和filesystem_authorization_grant_id同时为NULL。`data/sqlite.ts::metadata`检查任务约束，`validateAgentSchema`还对Agent表/索引/触发器的完整sqlite_master定义做校验。因此不能直接修改某张表或松开CHECK后继续标记为版本10。

工作区管理列表已经公共化到Core并有实际双后端reader，但SQLite正式库没有完整workspaces/workspace_directories/folders/files及授权生命周期。现有声明创建/更新Core用例的事务端口、Host PG适配和临时表回归，不能替代这些正式对象。

## 完整依赖分层

| 层级 | 数据与事务边界 | 不能据此推断 |
| --- | --- | --- |
| 管理只读列表 | owner偏好、包含停用的声明、owner会话计数；保留原API顺序与能力投影 | 不能推断绑定可写、Shell可执行或正式SQLite完成 |
| 声明管理 | workspaces与真实project/folder/directory；事务内owner关系校验、创建/更新/解绑 | 声明不是物理目录，不可用project/directory ID代替workspace ID |
| 目录及文件空间 | workspace_directories与真实folders/files作用域、版本、软删/恢复、唯一索引；显示名fanout与物理落点分离 | 建表不等于目录存在、授权根有效、ACL生效或删除已清理 |
| 会话、任务和授权 | workspace引用、独立任务授权、撤销/过期、解绑/停用、活跃运行资源清理 | 会话授权不能继承给定时任务；目录存在不等于Linux MXC隔离完成 |

### 必须保留的约束和既有行为

- SQLite数据owner沿用Core无连字符UUID编码及单owner runtime元数据。不能复制Python的users外键后创建假用户表来通过结构校验；需使用Core实际owner不变量。
- workspaces保留folder/project/directory的可空引用和现有删除SET NULL语义；存在性FK并不验证同owner，必须有事务内归属检查或等价数据库保护。Python声明没有名称唯一约束，不机械新增全局唯一规则。
- 声明关联project/folder时，沿用现有服务允许引用该owner软删除对象的行为；directory关联必须是该owner的活动目录。不可统一加deleted_at过滤改变三者语义。
- workspace_directories保留活动项部分唯一索引`(user_id,directory_name)`与`(user_id,name)`，条件均为deleted_at IS NULL。name是显示名；directory_name为创建后冻结的物理段。改显示名在同事务向该owner所有绑定fanout，不能重写物理段使历史storage_key失效。
- folders活动名唯一范围覆盖owner、COALESCE(project_id,0)、COALESCE(workspace_directory_id,0)、COALESCE(parent_id,0)、name。保留真实父子树、版本及递归软删/恢复；不能用只含id/name的占位表。
- files保留owner内活动storage_key唯一、folder/project/directory关系、软删及版本。物理目录清理、文件元数据和关联任务/会话必须按现有生命周期协调。
- 声明删除仅解绑会话并停用对应普通工作区任务，不能删除项目、文件夹或文件。目录删除是另一危险操作：默认/系统目录保护、确认、关联对象清理、运行PTY终止及提交后的物理清理不可省略。
- 旧PG声明删除还由单列外键清理引用：关联提醒和错误跨owner任务的workspace置空，但不能主动改变这些任务的enabled；终端记录只清workspace、不删除或终止PTY。旧file_sync_bindings的CASCADE仅属历史清理兼容，不能据此在2.0重新启用DB↔FS对账。新正式schema必须明确这些保留/退役数据的迁移与恢复语义；不能把四条显式SQL等同于完整删除生命周期，也不能把临时单列FK测试当成复合owner约束验收。
- 保留session/task的workspace索引和任务授权有效性查询索引。只有真实关联服务/授权后端已验收时才放开相应NULL限制；不把授权字段建出来视为已接线。

不要天真地将同owner校验替换为`(target_id,user_id)`复合FK并直接保留ON DELETE SET NULL：这会尝试把owner一起清空。独立SQLite内存实验已验证带NOT NULL owner时删除被拒绝、原子保留原记录；这不是业务pytest或迁移验收。需选择保留单列SET NULL并补owner保护，或经专门行为验收的其他删除策略，不能默默破坏现有硬删除语义。

## 正式迁移策略

1. 由schema负责人确定新版本及文件所有权，串行处理schema.ts/sqlite.ts、Python互读和桌面Host。先区分可读元数据、声明、物理目录和执行能力，明确每个阶段仍被关闭的功能；阶段迁移存在不等于完整工作区交付。
2. 沿用现有显式迁移、排他写事务、带时间戳备份、备份完整性/owner/外键校验流程；不在普通open时自动修复或清空损坏数据。测试只用临时数据库。
3. 准备真实新表、索引、owner保护及引用关系。若需要重建session/task以变更CHECK，原子保留ID、历史/Run/队列/交互引用、任务触发收据、序列和其他现有业务数据；同步更新打开时的版本化结构校验，旧版本不得误认不兼容结构。
4. 不在schema迁移中伪造目录、默认绑定、ACL或授权。真实授权根、路径/符号链接防护、目录创建和ACL由可信Host完成；缺后端明确不可用，不能回退宿主执行。
5. DB/FS跨资源故障保留可恢复事实：目录创建/改名失败不残留假声明，事务回滚有补偿，提交后清理失败可识别和恢复；默认目录不由只读列表隐式创建。

## 最小验收矩阵

- 空库初始化、版本10及更早受支持库升级、迁移后重开、备份独立恢复；故障注入保留原库和所有非工作区数据。
- 真实表上的跨owner关联拒绝、FK删除SET NULL、同时间列表排序和真实会话计数；项目/文件夹软删关联与活动目录的差异。
- 并发同名目录创建、显示名变更fanout、物理段及历史storage_key不变，软删后创建/恢复冲突，默认/系统目录保护。
- 声明解绑与目录删除的不同副作用；会话、任务、授权记录、触发收据和PTY状态一致，任务不继承会话授权。
- 真实Local根/符号链接/ACL拒绝和取消清理；平台后端缺失时不开放执行。Linux MXC多用户隔离仍单独验收。
- Node/SQLite与PG共享合同、Python工作区参考、桌面实际Host与生产Web路径；不能仅运行schema字符串断言或合成reader测试。

## 源码依据

Python：`backend/app/models/__init__.py`的Workspace/WorkspaceDirectory/Folder/File/FilesystemAuthorizationGrant；`backend/app/services/workspaces.py`。Node：`packages/core/src/data/{schema,sqlite}.ts`、`application/workspace-declarations.ts`、Host `domains/workspaces/persistence/{workspace-create,workspace-update,workspace-delete,workspace-bindings,workspace-directories}.ts`。

现有查询验收与仍缺的Agent工具字段见[node-agent-workspace-port.md](node-agent-workspace-port.md)。本记录只确认完整迁移门槛，没有执行升级、改版本或新增工具。
