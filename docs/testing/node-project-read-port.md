# 项目管理读取公共化与工具依赖边界

## 当前共享实现

`@gugu/core`提供`createProjectListing(core,counts,now?)`、`createProjectGetter(core,counts)`、`createProjectFileCountListing(counts)`及`projectResponse`。项目读取复用原SqlDataRuntime仓储；owner、归档、软删与30日回收站过滤、排序和DTO组合迁入公共用例。可注入时钟验证回收站，不创建新项目数据库业务。Host原工厂签名保留，main/routes无需修改。

`ProjectFileCountPort`由可信Host提供：forProjects只返回指定owner的已有投影，list返回该owner的所有项目（包括归档和软删）及缺失记录的0计数，并按项目id排序。`@gugu/core/data::createKyselyProjectFileCountReader(db,backend)`是实际参数化PG/SQLite适配器，复用既有project_file_counts，不扫描files、不创建、维护或重建投影，也不关闭Host连接。空项目列表不查投影；有项目但缺表必须失败，不能假造fileCount=0。先读项目、再读计数，保持旧Host的两次读取边界，不宣称同一一致快照。

Host `projects/persistence/projects.ts`保留原PG投影SQL，将列表/详情/计数与DTO委托公共入口。projectTimestamp、projectExistsForOwner及实时readProjectFileOverview保持原职责；卡片fileCount投影不是Agent所需总文件/根文件/目录概览。未修改文件操作、路径、锁、ACL或其恢复机制。

公共DTO位于projects/project-projection.ts，Host和Core创建/更新共同复用；创建回执仍传fileCount=0，写事务、Undo快照及提交后流程未改。按Python Project.stages和ProjectResponse的标准JSON行为，语法损坏的stages_json投影为[]，合法JSON非list[dict]仍失败，合法dict中的历史未知字段保留，原文不写回。这修复旧Node读取损坏JSON直接报错、合法错误结构却成功返回的问题，不以空数组掩盖合法但不符合契约的数据。

公开doneAt/updatedAt/deletedAt现统一为正常Python数据库路径的UTC ISO字符串：T分隔、+00:00，零微秒省略小数，非零保留六位；空值为null。createdAt先归UTC再取日期，避免非UTC数据库会话的跨日错误；startDate/deadline仍为业务日期。列表/详情、创建HTTP及创建事件、更新返回及事件、恢复返回及事件共用这一投影。原严格utc解析器原样移至domain/timestamps.ts，data/codec.ts保留原import/re-export和databaseTime接口，内部canonical/存储仍为空格格式，Undo快照不套公开DTO格式。

查询可传signal，调用前、仓储及真实计数查询清理后检查；驱动拒绝与取消同时发生时传播原取消原因。真实工作结束前不提前settle，适配器不强制终止数据库SQL；现有HTTP未接入断连signal。

## 本轮验证（2026-11-14）

- 正式初始化的临时SQLite项目仓储配合**显式合成**计数表7/7：完整DTO、两owner、归档与29/31日回收站、投影读取、stage标准JSON边界、非法参数/空ID零计数SQL、缺表不假0及真实查询结果处理等待中的取消。正式SQLite目前没有计数投影表，本组只验证适配原型及明确失败边界，不证明正式投影迁移或桌面已接通。
- 独立临时PG项目读取3/3：Host/Core两种实际适配均经真实Fastify认证→路由→Core项目仓储→投影查询，验证401/404/422/互斥400、完整DTO、owner、归档/回收站、标准JSON历史兼容及原文不变、缺表固定安全500。fixture只建项目和计数投影，files表不存在，成功读取证明未绕过投影扫描文件；计数为合成播种，不验收触发器维护或真实文件后端。第三项观察pg_locks中的计数表真实服务端等待后取消，释放前不settle，释放后按原reason拒绝，单连接可复用。
- 同一隔离PG实例既有创建/更新各1项通过，PG合计5/5，保护幂等并发、owner/version CAS、同事务Undo及提交后事件。实例和随机schema均已清理。事件发布为受控依赖，不连接真实Redis。
- 既有Host路由/创建/更新及字段兼容27/27，原断言不变；这组以业务端口替身为主，与上述真实PG链分开记录。Core工具/技能和相关查询选集26文件437通过，0失败/跳过；源码、测试与Host类型检查、diff通过。
- Python新增`tests/projects/test_project_read_api.py`4/4直接真实handler基准，保护owner/DTO、归档/回收站、计数投影（真实文件存在但无投影仍为0）、详情404、标准JSON阶段历史兼容和原文不变。真实运行SQL观察用于验证不扫描files，不检查源码。另原project_trash两项及projects_core三项通过，本组9/9、0失败/跳过，2条既有弃用提示。新增基准不计作此前已存在覆盖。

edit-check未发现调用签名不兼容，旧Host工厂签名unchanged；整Core quality_delta仍有其他并行门禁与新入口未调用提示，DTO与Undo快照的字段克隆不是合并二者语义的理由，不宣称全仓质量门通过。本轮新测试已登记；此前全仓元数据检查中其他范围缺登记未批量修改或宣称修复。

## 公开时间兼容回归（2026-11-14）

前述公共化阶段发现的Node空格/ISO来源不一致已在本切片修复，旧时间差异不再作为当前公开项目DTO缺口。范围只覆盖公开ProjectResponse：项目delete及Undo/redo仍只发布资源ID，不额外制造payload；操作摘要和Redis envelope自身时间、其他域协议不顺带统一。

- 新Core时间专项23项及既有读取7项（定向30/30）：经codec旧入口和新domain入口保护UTC偏移、0/123000/123456微秒、非法类型/日期/年越界原错误；真实正式SQLite创建及受控事件验证公开T与内部记录、数据库原文、Undo快照前后不变。仅改旧错误DTO精确预期，保留完整深相等，不放宽断言。
- 三方源码/测试冻结并统一构建后，标准Core unit集合77文件1467/1467，隔离PG标准集合19文件34/34，均0失败/跳过；这不是IPC、parity或所有外部服务集合。覆盖原utc的多个真实消费者，不仅项目局部测试。源码/测试、Host类型检查及diff通过。
- 独立临时PG项目回归9/9：实际Fastify读取Host/Core两种路径、create/update/restore真实事务、撤销/重做及文件恢复；Host池显式使用合成的Asia/Shanghai会话时区，真实PG触发器固定非零微秒。精确验证公开响应/事件payload一致、createdAt跨UTC日、0微秒省略与非零六位；SQL::text仍为原数据库时区/精度，内部快照未改，Undo/redo事件无新增payload并可重读新DTO。实例和schema已清理。认证、事件收集与部分存储为受控依赖，其他Undo用例使用真实临时文件；不连接真实Redis或用户数据。
- 原Host路由/创建/更新/恢复及字段回归36/36通过。此前创建/更新单测将Z/.000公开预期精确改为Python UTC ISO协议，并新增内部Undo原Z字符串不变断言；这是可观察格式缺陷修复，未删除/放宽业务断言。
- Python本轮13/13：新增管理读取文件现7项（新增3组真实数据库往返时间样本），加原live events 2、恢复1及项目Undo 3项，均0失败/跳过；两次串行运行各2条既有pypinyin弃用提示。新时间样本保护UTC/非UTC跨日、微秒、null、业务日期及持久Undo不被读取改写；不把原邻近pytest计作已覆盖完整微秒序列化。

整树quality_delta仍有其他并行门禁；迁移函数没有重新定义存储行为，edit-check未报告不兼容调用，但静态图有未解析边，不能代替上述全unit/PG证据。真实Redis、生产完整Host部署及平台执行仍未验收。源代码、测试和dist冻结窗口在回归结束后已交回，未fetch/提交/推送或触发CI。

## 剩余依赖

- 正式SQLite计数投影及文件schema、投影维护/恢复未实现。缺少这些后端时不能把原型声明为桌面完整项目管理读取。
- 公开项目时间差异已按上节关闭；这不代表正式SQLite投影、全部项目API、Undo恢复或Agent工具的其他缺口全部完成。
- Agent list_projects/get_project的排序、语义色、阶段计数/结构和实时文件概览是不同投影，不可用本管理DTO代替。未新增工具或生产Run装配，不升级工具状态。
- 真实用户库、真实文件索引/投影维护、Redis、平台执行和生产完整发布未验收。没有更改运行配置、共享schema、main、package或锁文件；root/data入口追加导出经协调串行构建。

项目创建的 Web 生产入口及 PostgreSQL 事务、Undo 和并发重放测试均使用 Core 创建存储；旧 Host 创建适配器已移除。

项目创建与回收站恢复响应直接使用 Core 的项目投影；旧 Host 投影转发已移除。隔离 PostgreSQL 删除/恢复及路由回归 10 项通过，项目回收站事务和文件存储仍由 Host 实现。
