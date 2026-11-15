# 全局搜索公共服务与 Agent 依赖边界

## 已公共化的现有Web业务

Core `src/search/query.ts`提供现有Web参数解析与类型；`global-search.ts`提供来源能力、查询快照、顺序调用和分组结果。来源定义和结果白名单在`sources.ts`，实际PG查询在`postgres.ts`、正式SQLite已接来源在`sqlite.ts`。公开应用入口由`@gugu/core`导出，读端口工厂由`@gugu/core/data`导出。

Host `domains/search/search.ts`保留 HTTP 路由及认证 owner 注入，生产入口直接将 Host 的 Pool 注入 Core 搜索来源和用例；Web `/api/v1/search` 和 Mind 引用建议继续使用原接口，委托同一公共业务。不在工具层复制 SQL，不引入 Agent 或 Provider 搜索框架；这属于站内结构化搜索，不等同于 RAG 迁移。

移除 Host 内部搜索工厂转发后，devserver 上搜索定向测试 4/4 通过，包含隔离 PostgreSQL 下的用户隔离和认证搜索；本轮未重新验证生产启动入口或真实部署。

来源能力由可信 Host 装配；`availableTypes` 和 `missingTypes` 均为必填的只读冻结数组，分别列出已装配和缺失的来源。非空默认查询要求全部来源就绪；存在缺项时在查询任何来源之前抛出 `GlobalSearchUnavailableError`，其 `code` 为 `conflict`，`missingTypes` 给出缺失类型。显式指定已装配来源可查询，显式请求已知但未装配来源同样报 `conflict`；空关键词仍返回空结果，原未知 types 过滤为空列表的语义保留。现有 HTTP 错误映射为 409，没有任何后端时拒绝创建服务。

| 来源 | PG实际实现 | 当前SQLite实现 |
| --- | --- | --- |
| project、client、event | 已接公共查询 | 正式临时schema真实读取已验收 |
| file、folder、note、canvas_note、skill、mcp、scheduled_task | 原Web实际查询已共享并通过隔离PG | 尚未接入来源，显式不可用；并不表示这些领域的所有表都不存在 |
| conversation | 原标题/消息查询已共享并通过隔离PG | 独立单语句来源及反斜线转义子集已验收，当前未装配；非ASCII匹配、罗马音、Worker/规模仍未完成 |

SQLite会话来源接入前必须在LIMIT前处理全部可能排序记录的时间规范/精度，不能只检查前8条或用毫秒Date排序冒称无损。未经独立真实正式schema验收，不升级该来源能力。

聊天会话交接的`sqlite-conversations.ts`最初通过`db.transaction()`触发BEGIN IMMEDIATE写保留锁。现已改为单条只读SQL：在同一语句快照中校验owner全部会话/消息时间，再按规范文本的完整微秒排序，输出受限标题和最多8条消息。共享纯SQL谓词`data/sqlite-time-sql.ts`检查Gregorian日期、固定六位小数、ASCII格式及NUL，兼容UTF8/UTF16；不修复或改写旧时间。验证仍扫描该owner全部时间，不能声称规模成本已解决。它尚未被`createKyselySqliteGlobalSearchSources`装配，当前可用来源仍为三类；独立端口测试不计入已接通数。

驱动核对：SqliteAdapter声明单连接，RuntimeDriver通过ConnectionMutex串行化acquire/release，DefaultConnectionProvider在finally归还连接，同连接consumer另由SingleConnectionProvider串行化。真实测试验证事务句柄可直接调用来源，另一顶层查询等待持有连接的事务释放后读取已提交值；不能在已占连接回调内await根db重入。现有worker普通读命令仍被runtime.transaction包裹为BEGIN IMMEDIATE，尚无搜索命令，未验收Worker端搜索。未改全局调度或手写BEGIN DEFERRED绕开连接管理。better-sqlite3同步执行不能由AbortSignal在SQL中途打断，只能等待结束清理后传播取消；单语句一致性也不承诺跨来源统一快照。

## 保留的业务与安全边界

- 关键词数组优先于旧q短语；每词最多64个Unicode码点、最多8词，AND/OR模式与每类1–200限额保留。首次await前保存查询、词数组和类型数组快照，调用方修改原对象不能切换进行中的检索。
- PG查询保留原原生ILIKE、命中数/首词精确/前缀排名和各域排序；SQLite已接三域使用实际lower/LIKE。`%`和`_`仍为既有通配行为，不替换成JS正则或字面子串扫描。
- 认证身份由Host传入；所有私有来源绑定owner，实际SQLite适配按32位UUID编码。平台MCP按原scope规则共享元数据，不返回endpoint、credential slots；Skill只返回目录元数据，不返回正文或授予加载权限。
- 文件/文件夹导航再次限定owner、软删及同项目/工作区父链；最多64层，错误根或跨owner链不泄漏名称。画布便签要求节点、画布条目和画布三者均属于该owner且未删；标题仍是搜索元数据，不改画布正文模型。
- 会话标题优先，消息按会话去重；消息候选保持最多8条，读取所有角色正文，按原命中数/创建时间排序。已保留聊天会话修复的42P18回归：消息查询使用连续$1/$2/$3参数，不再跳过$3导致默认含conversation的搜索失败。
- 任一实际来源查询失败，整体拒绝，不将前面来源的部分groups当成功返回。没有一致快照事务的新承诺，保持旧多来源逐次读取水位；本服务不写库、不授予文件或执行权限，也不接管连接池。
- 可选signal在读取前后检查；文件位置并发补充使用allSettled等待已启动的兄弟查询清理后再传播错误或取消，不race提前返回。不会强制终止服务器SQL，超时由Host/驱动提供；现有HTTP路由尚未注入断连signal。

## 最新能力边界验收

正式 SQLite 当前仅装配 project、event、client 三种来源；非空默认全来源查询因其余来源缺失而明确失败，调用方需显式选择可用子集。正式 SQLite 搜索回归 12/12、隔离 PostgreSQL 与 SQLite 会话来源对照 3/3、统一构建后的 Web/Host 隔离 PostgreSQL 搜索回归 14/14、Python `test_global_search.py` 对照 19/19 均通过，失败和跳过均为 0。PG 测试验证默认 11 来源真实查询、owner、错误和取消；临时实例与随机 schema 已清理。Core 与 Host 的类型检查和搜索/Mind 定向测试也在能力字段改为必填后通过。下列历史计数保留各轮原始覆盖范围，不替代本轮结果。

上述证据不代表 SQLite 其他来源、数据库语言匹配、桌面搜索或 Agent 工具搜索已完成。SQLite 与 PostgreSQL 的非 ASCII 匹配和罗马音仍存在后端差异；独立 SQLite conversation 来源尚未装配。桌面尚无搜索命令和能力发现链，Agent `global_search` 的 Node 工具定义和生产 Run 调用尚未验收。

## 验收证据（2026-11-14）

- 独立会话来源正式SQLite10/10、已接三源8/8，合计18/18、0失败/跳过。新增测试使用真实引擎验证UTF8/UTF16日期边界、owner trigger、未命中记录的非法时间也拒绝、读取无写入、独立写连接持有BEGIN IMMEDIATE时仍读到旧提交值、提交前后语句快照、取消等待结果处理清理、连接复用及desktop排他连接。结果处理门为受控测试钩子，取消不是SQL执行中断验收。
- 隔离临时PG与正式SQLite双库对照3/3、0失败/跳过：实际两来源比较ASCII/CJK的AND/OR、标题排名、完整微秒、全部role、候选8条后去重和限额；PG异owner数据隔离，正式SQLite异owner写入仍由原trigger拒绝。实测合成词`a\\_b`在PG命中`a_b`、SQLite命中`a\\xb`；`änne`在本轮C locale两库均不命中`Änne`，ASCII大小写均命中。测试只对齐各库原生探针，不把已知差异当等价协议。公共SQLite仍拒绝显式conversation请求。实例及随机schema已清理；未触及真实用户数据库。
- Core正式初始化的临时SQLite8/8：实际项目/联系人/日程查询经公共解析→聚合→SQL→投影，覆盖两owner、软删、命中数/精确/前缀/时间顺序、跨字段AND与OR、每类限额、短语/码点限制、未知与不支持来源、真实缺表不假成功、参数不能注入SQL、查询快照及取消等待资源清理。没有用测试内SQL实现代替生产端口；该证据只覆盖已接三来源。
- 独立临时PG实例的Host搜索集合12/12、0失败/跳过：原7项保留（含B新增42P18认证查询回归），新增5项默认全部11来源均经过真实Fastify与SQL。验证owner/软删/有效任务、平台MCP及Skill结果脱敏、坏父链/错根导航、Unicode消息片段、标题去重和候选8条。真实folders表锁下观察至少两个兄弟导航的pg_locks等待，取消后不提前settle，释放锁后原reason拒绝、可借满池连接并再次查询；clients表改名时整体拒绝而非部分成功，恢复后可再次搜索。随机schema和实例均已清理。
- PG测试使用合成领域表覆盖所有实际查询字段，认证用户/JWT为合成依赖，不连接真实账号、Redis或外部服务；不证明正式SQLite全部来源、真实生产数据库升级、RAG或付费Provider。原两项端口替身测试仍单独保留，不替代新真实PG证据。
- Python串行`tests/agent/knowledge/test_global_search.py`及`test_search_query.py`共23/23，0失败/跳过，2条既有弃用提示；保护用户隔离、软删、导航、关键词/类型/限额、Skill/MCP边界及Python拼音行为。它们的通过不证明Node已实现全部语言匹配能力。
- Core源码/测试及web-host类型检查、diff通过；统一构建在三方协调冻结后完成。edit-check未报告调用签名不兼容，旧Host工厂签名unchanged；静态图有未解析边。整树quality_delta仍有其他门禁及新搜索函数复杂度/metadata长度提示，不宣称全仓质量门通过，也不为指标改写现有安全SQL。

## 未完成项

查询规范化现已对齐当前生产Python3.14的Unicode16基准：复用`domain/values.ts::strip`，先按码点截到64，再以完整casefold键去重，保留首词原貌；公开响应query也采用同一strip。`search/unicode.ts`为完整1557项非恒等映射，未映射字符保持原样，不回退Node较新Unicode版本的lower，不做NFKC或语言特例。用Unicode16的Python运行`packages/core/scripts/generate-search-unicode.py --check`可只读校验；重建时去掉`--check`，版本不符先拒绝写入。升级Python/Unicode基准时须同时复核生成物、独立oracle和实际查询行为。

折叠用于查询去重及片段选词，不将折叠后的词送入SQL。SQLite lower/LIKE与PG ILIKE的非ASCII语义仍受后端影响；会话独立来源已追加显式反斜线ESCAPE，真实双库对照覆盖转义%/_、结尾/双反斜线、普通通配符及消息，原生ASCII子集一致。其余SQLite三来源的反斜线匹配未随此改动统一。原PG文件/文件夹search_romaji字段也不代表Python最近200条拼音/日语罗马音扫描已迁移；不能由查询/片段Unicode校验声称数据库全文匹配等价。

### 查询Unicode归一化补齐验收

新增Node3项、Python7项行为回归，覆盖ß/ss、希腊sigma、连字展开、Cherokee、土耳其字符、BOM/控制空白、截断顺序及首词保留。Node对全部Unicode标量计算折叠流SHA256，与独立Python3.14 oracle比较；同时验证strip恰为29字符，孤立代理码元保留，长内部/全空白输入结果正确。共享strip改双端单字符扫描，保留原集合，避免尾部正则失败时重复回溯。

真实正式SQLite和认证HTTP→Core→实际PG均验证AND去重影响结果、原词仍用于数据库匹配、response.query保留BOM并去除Python空白。PG使用隔离合成表，认证lookup为替身；不是生产认证或Agent Run验收。查询归一化阶段标准Core unit80文件1491/1491、定向SQLite21/21、Host搜索13/13、双库会话对照3/3、Python搜索30/30均通过，0失败/跳过，2条Python既有弃用提示。源码构建、Core测试/Host类型检查、生成物check和diff通过；临时PG及schema已清理。全树quality_delta仍有19项门禁，新增归一化无新增质量门阻断；不宣称整仓质量通过。

### 消息片段与后续反斜线验收

`searchSnippet`复用固定Unicode16的完整casefold选首个命中词，再用同版本lower定位。lower复用折叠表并增加297项差异及固定Cased/Case_Ignorable范围，按原码点线性计算Final_Sigma上下文，不依赖Node所带Unicode18的属性或大小写映射。片段沿用Python的lower索引切原文行为（含İ展开造成的位置偏移），24码点窗口先strip再仅替换LF；未命中/无词回退前60码点并保留内部换行。孤立代理码元不会错误匹配emoji的一半。

22个合成片段样例由原Python函数生成，Node和Python共同读取同一fixture断言。Node另对全部1,112,064标量的lower和两侧Sigma上下文计算独立Python摘要，覆盖单字符测试发现不了的上下文规则。认证HTTP→真实PG消息测试以ASCII needle保证实际命中，再验证ss先fold命中ß但lower无法定位时回退前60码点，以及BOM/控制空白。未把数据库locale能否匹配ß当作片段测试前提。

最新定向Node3文件44/44（查询11、片段23、独立会话10）、认证Host搜索14/14、真实PG/正式SQLite会话对照3/3、Python搜索与片段52/52通过，均0失败/跳过。Core build、Core测试/Host类型检查、生成物check与diff通过；PG实例及schema已关闭清理。ESCAPE由聊天会话实现，我方整合复验；来源仍不装配，没有生产Agent Run/Worker搜索验收。edit-check没有调用签名不兼容，整树quality_delta仍有19项门禁，不宣称全仓质量通过。

SQLite其余来源仍未开放，独立conversation来源补齐上述边界后再协调接入；不可借PG通过声称双库全部等价。Agent `global_search`尚无完整ToolDefinition、工具参数/结果映射和生产Run调用验收，不因Web搜索公共化升级工具状态。真实生产部署、用户库/Redis、索引维护及完整RAG迁移未验收；RAG仍按复用1.7.8 TypeScript方向推进，不迁Cython算法。

本轮未修改main/app、共享schema、package/lockfile、用户运行配置或前端；root/data导出已协调追加，没有提交、推送或触发CI。
