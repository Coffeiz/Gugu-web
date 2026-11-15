# Node Agent 工作区公共查询与会话绑定边界

正式SQLite的表依赖、owner/外键语义、版本化迁移和最小验收门槛见[工作区SQLite迁移边界](node-workspace-sqlite-migration-boundary.md)。当前不放宽会话/任务的workspace NULL限制。

## 已公共化的既有会话绑定

`@gugu/core::createWorkspaceBindings(runtime)`提供bind/unbind/current公共用例。可信Host注入事务和owner限定查询/更新；现有Web Host PG适配保留原SQL、会话行FOR UPDATE和事务边界，将校验、错误与结果投影委托Core，既有路由和main调用保持有效。绑定必须是本owner的启用工作区；current仍返回本owner已停用工作区，历史跨owner错误引用返回null；他人会话按不存在处理。绑定回执boundSessionCount=1、current=0是旧API投影，不代表真实总计数。安全整数0/负数仍进入不存在语义，非整数及非法owner在SQL前拒绝。

`@gugu/core/data::createKyselyWorkspaceBindingRuntime(db,backend)`提供真实PG/SQLite事务适配，PG锁定会话行，SQLite按后端UUID编码限定owner。连接生命周期由Host负责，不建表、不授予文件根/执行权限。可选signal在事务提交前检查并触发回滚；已提交写入不因事后取消伪装成未执行。现有HTTP路由尚未注入断连signal，适配器也不强制取消服务器SQL。

本切片SQLite合成表12/12通过，保护持久化、两owner隔离、停用项、错误历史引用、非法参数零SQL以及故障/写后取消回滚。独立临时PG实例中Host路由及真实数据库3/3通过，保留旧断言，并追加公共Kysely适配对照、真实取消回滚与连接复用验证。Core工具/技能及相关查询选集23文件408通过，0失败/跳过；Core源码/测试、Web Host类型检查和diff检查通过。首次Host检查发现的括号语法错误已修复后重验。Python工作区最近邻19/19通过，5条弃用提示；这些Python测试保护目录/声明命名空间、生命周期和确认边界，不是bind/unbind/current端口的完整等价覆盖。

SQLite使用临时合成表，PG使用随机schema且实例已停止清理；未验证正式SQLite工作区迁移、真实用户库、Redis或平台执行。尚未新增Agent工作区工具，生产Run装配和完整关联资源查询仍待完成，不能升级工具迁移状态。edit-check未发现签名不兼容；application范围quality_delta无门禁，但有新增方法未调用与其他并行变更提示，不宣称全仓质量门通过。

## 已公共化的既有管理列表

`packages/core/src/workspaces/workspace-list.ts`提供`createWorkspaceLister(store,runtime)`及`WorkspaceListReadPort`。Core负责owner规范化、历史JSON偏好的默认/Python真值语义、可信运行设置组合、终端标志与列表结果投影。Host `workspace-list.ts`保留三条原有owner限定SQL，委托Core；既有`main.ts`与管理路由无需改变调用方式。没有新增工具专用数据库实现。

`@gugu/core/data::createKyselyWorkspaceListReader(db,backend)`另提供实际可复用的PG/SQLite只读适配器；连接由Host持有，不创建或迁移表。owner按对应后端编码（Core SQLite使用无连字符UUID），SQLite布尔字段转为公共boolean，计数保留数据库原生数值/文本后交公共用例投影。缺表与SQL错误传播，不把缺失schema当作空工作区。现有Host暂保留原PG适配，不因此更换其连接生命周期或SQL边界。

读取端口分别提供偏好原文、按updated_at倒序且包含停用项的工作区、owner内绑定会话计数；平台事实由可信Host提供。查询保持原管理API的三次读取语义，没有新增一致读事务或声称跨查询具有同一快照水位。`sandboxReady=false`时终端入口/PTY不能因配置启用而变为可用；列表标志不是Shell授权凭据，更不证明Linux MXC隔离已验收。

公共列表可传`list(owner,{signal})`，运行设置与三个读端口均接收可选signal。服务和实际Kysely reader在等待前后检查取消，并等待真实查询/结果处理结束后传播原取消原因，不用race提前返回。适配器不会强制终止数据库服务器上的SQL；查询耗时上限仍由可信Host/驱动配置，现有HTTP路由也尚未接入断开连接的signal。旧的一参Host调用保持不变。

## 已公共化的既有声明删除

`@gugu/core::createWorkspaceDeleter(runtime)`负责原DELETE管理API的完整数据库事务：锁定本owner声明、解除同owner会话绑定、仅停用并解绑event_id为空的同owner普通任务，最后删除声明，返回原`{ok:true,workspaceId}`。Host PG保留原SQL及事务/锁边界并委托Core；原main与路由调用无需改变。参数和owner在SQL前校验，安全整数0/负数仍为not_found。写入前后检查signal，提交前取消回滚，已提交写入不因事后取消改称未执行。

`@gugu/core/data::createKyselyWorkspaceDeletionRuntime(db,backend)`使用实际PG/SQLite事务，缺表或约束错误原样传播，不返回假成功。显式SQL不能替代schema的外键副作用：旧单列FK会清空关联提醒及跨owner错误引用的workspace，但不能停用它们；终端记录保留、只清workspace，不终止真实进程。旧file_sync_bindings的CASCADE仅验证既有PG历史清理兼容，不在Core新增其业务或重启已退役DB↔FS对账。项目、文件夹、文件和物理目录均保留；这不是物理工作区目录删除。

验证使用真实临时SQLite文件及合成单列FK表14/14，通过公共用例和实际Kysely端口验证owner/任务筛选、父资源与真实临时文件保留、四阶段失败回滚、真实缺表错误回滚及删除后取消回滚。独立临时PG随机schema4/4，原全部业务断言分别经Host和Core两种真实适配执行，并用数据库AFTER DELETE触发器故障、实际DELETE后取消，比较六张表证明更新和FK副作用均回滚；实例已停止清理。既有Host脚本端口3/3和认证路由2/2通过，这五项使用测试替身，不能替代上述PG证据。Core选集24文件422通过，相关源码/测试和Web Host类型检查、diff通过；均0失败/跳过。

Python串行基准为`tests/terminal/test_shell_workspaces.py::test_workspace_can_be_renamed_disabled_and_deleted_without_deleting_project`、`tests/scheduling/tasks/test_scheduled_task_workspace.py::test_deleting_workspace_disables_bound_scheduled_tasks`，2/2通过，2条弃用提示，保护声明删除不删项目及任务不回退默认工作区。首次运行因目标函数名拼写错误未收集成功，修正选择器后重跑，未改旧测试或放宽断言。

此用例不提供Agent危险操作确认权，不能直接作为`unlink_workspace`工具开放；该工具还需要可信持久确认、工具响应投影、平台能力及生产Harness接入。正式SQLite仍缺工作区完整schema，合成FK测试不证明owner复合FK或正式迁移验收。COMMIT响应丢失后的调用收据恢复、真实PG并发绑定/删除竞态及生产完整HTTP→数据库链仍未验收，不得自动重放未知结果。相关edit-check无调用签名不兼容；application质量检查无门禁，data范围仍有并行既有门禁及小型owner查询克隆提示，不能宣称整仓质量门通过。未修改共享schema、main、运行配置或workspace依赖。

## 与Python工具仍有差异

Python基准为`backend/agent/tools/workspaces.py`及`app/services/workspaces.py::list_workspaces_for_management/workspace_payload`。

- 工具输出`workspace_id`、snake_case关联字段，以及仅在对应关联存在时增加project_name/folder_name/directory_name。关联查询必须再次限定owner，不能因工作区记录引用某ID就泄露其他账号对象名。
- 工具列表同样包含停用项，但排序为updated_at倒序、id倒序；现有管理API只按updated_at倒序，公共化保留旧API顺序，不擅自改变其行为。
- `get_workspace`必须按工作区ID和owner读取，不能把会话当前绑定或directory/project/folder ID当工作区ID。
- 平台不支持本地工作区时的列表、详情、声明管理语义仍需显式能力边界；不能借列表接口默认local支持就开放Shell或物理目录操作。

因此本轮没有新增`list_workspaces/get_workspace` ToolDefinition，也没有返回假关联名称。两个工具仍为依赖阻塞，待完整共享领域查询和实际Harness/Host消费链验收。

## 验收证据与限制

- Core17项实际临时SQLite文件回归全部经过`createKyselyWorkspaceListReader`，不使用测试内SQL适配器：原12项保护owner计数隔离（含其他owner会话误指A工作区）、停用项/顺序/null关联、损坏偏好、Python空/非空容器真假、终端模式和sandbox能力、非法owner零读取、真实SQL错误不假成功；新增5项保护预取消、设置等待及三阶段查询结果处理等待中的取消。结果处理plugin屏障证明SQL已执行而API尚未完成，不误称此时连接仍占用。原业务断言不变；测试创建三张独立合成表，不修改共享schema，**不证明正式SQLite工作区schema或Host已接入**。
- 既有Host列表/路由/真实Host测试4/4通过，旧断言不变；独立临时PostgreSQL随机schema1/1通过，比较两种适配器对两个owner的完整输出一致，并用真实表锁及单连接Core池验证取消不提前settle、释放锁后按原reason拒绝且后续查询可用。原owner/停用/计数/运行标志断言保留。临时实例已停止并清理。
- Core工具/技能及相关SQLite查询21文件394通过、0失败/跳过。源码、Core测试和web-host类型检查通过。
- Python `test_workspace_directory_tools.py`、`test_workspace_directories.py`串行19通过、0失败/跳过，5条弃用提示；保留ID命名空间、目录生命周期与确认边界，不把这些测试当新公共端口的完整工具验收。
- edit-check未发现调用签名不兼容，diff检查通过。整树quality_delta仍有并行门限，新Host读端口小方法被与不相关表查询判为克隆/未调用；保留明确owner SQL，不为指标引入动态通用查询层，不能宣称全仓质量门通过。

未修改运行配置、共享schema、workspace/lockfile、main或路由。公共导出只在Core现有根入口追加，已与相应会话协调串行构建。


## 2026-11-15 本批共享用例与工具验收

新增 `createAgentWorkspaceQueries/createKyselyAgentWorkspaceReader`，完整读取owner关联名称、会话计数和停用项，补更新时间/ID倒序；两个工具已通过实际Host runtime/隔离PG续轮，现为已实现待接入。正式SQLite会话绑定限制仍保留，SQLite合同库不作为升级器证据；上文未注册/仍阻塞为历史结论。 完整测试、替身和限制见 [工具行为清单](node-agent-tools-parity.md#四组七工具及共享用例闭合2026-11-15)。

## 2026-11-15 工作区更新切片

update_workspace已通过共享声明更新、完整owner结果读取和Core持久收据的同一事务闭合；原Kysely适配器支持借用外层事务，并以原双库合同验证独立事务调用不变。目录显示名同步、不改变物理段；非法目标/参数/名称失败无副作用，未知提交只查收据，不重做。Host工厂以可选workspaceMutations显式装配，真实PG结果已进入Provider续轮；尚未接生产main或正式SQLite工作区升级。具体文件、回归和替身范围见[工具清单](node-agent-tools-parity.md#工作区更新与画布列表实际交付2026-11-15)。
