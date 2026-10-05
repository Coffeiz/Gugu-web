# PRD-DATA-1：用户数据可移植导出与迁移

> 状态：现有 Web 全量导出、增量导入和全量替换已实现并验收；按类型导出与项目级替换为后续目标，本版本不实施。桌面原生导入器尚未实施
> 创建：2026-09-28
> 最近更新：2026-10-05
> 关联模块：`backend/app/models/__init__.py`、`backend/app/services/storage/`、`backend/agent/memory/`、`backend/app/api/v1/`、`frontend/src/components/common/profile/`
> 背景参考：`docs/prds/【已完成】PRD-RAG-10-TS查询期数据读取与准备迁移.md`、`docs/prds/【已完成】PRD-STORAGE-1-暂存附件孤儿清理与视频转码缓存.md`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 用户业务数据按登录用户读取 | ✅ 已完成 | 项目、文件、会话、笔记等通过分域 API 读取，没有统一导出清单。 |
| 文件和聊天附件存储 | ✅ 已完成 | 元数据在数据库，文件字节由本地/对象存储抽象层读取。 |
| 长期记忆读取 | ✅ 已完成 | 个人记忆及 IM 群/成员记忆主要存于 `.agent/` 对象文件；数据库保存部分来源索引和删除屏障。 |
| 全量用户数据归档 | ✅ 已实现 | 使用版本化加密归档和持久化导出任务；已通过本地回归。 |
| Web 增量导入与全量替换 | ✅ 已验收 | 个人设置支持预检、增量导入、全量替换、任务历史和限期撤销；devserver 隔离测试账号任务链已通过。 |
| 按类型导出与替换 | 🔲 待实施 | 目标是所有可移植类型可选、可单独导出；导入按归档清单验证，并仅替换归档声明的类型。 |
| 项目级导出与替换导入 | 🔲 待实施 | 目标是可选择单个或多个项目及其关联数据导出，并在导入时只替换这些项目范围。 |
| 桌面端读取/导入归档 | 🔲 待评估 | 本 PRD 冻结可移植格式并在 Web 实现恢复；桌面原生导入器在目标应用存在后实施。 |

## 1. 背景与目标

咕咕用户数据不在单一数据库表或单一存储中：项目、日程、笔记、对话等在关系数据库；文件和聊天附件的字节在本地/对象存储；个人长期记忆与 IM 群/成员记忆保存在按用户分区的 `.agent/` 对象文件；记忆来源索引、scope 删除屏障和 RAG 索引又有部分在数据库。仅执行 `pg_dump` 会漏掉记忆文件及附件，并把当前表结构、运行字段和凭据存储细节暴露给迁移方。

现有 `/files` 批量 ZIP 只处理用户选中的文件库对象，不能覆盖用户的完整资料和对话。其 ZIP 逻辑也不是全账号导出的合适入口：导出需要完整的数据清单、跨表引用、记忆文件、聊天附件、校验清单和较大的流式对象。

本 PRD 已实现 Web 完整数据导出、增量导入和全量替换；后续目标是在同一产品能力中增加所有类型可选、任意类型子集单独导出，以及单个或多个项目范围的替换导入。此后续目标不纳入当前版本，不更新当前版本号或发布内容。所有操作继续使用同一版本化归档：可阅读的 JSONL/Markdown/JSON 加二进制附件。服务端以各领域 service、StorageBackend 和显式字段白名单读写；归档格式不依赖 PostgreSQL、当前 ORM 主键策略或物理 storage key，使 Web 与未来桌面端都能独立校验和迁移。

类型和项目范围在导出时确定并写入归档 manifest；导入不再提供第二份范围选择表单，而是验证 manifest、依赖闭合和目标映射后，按归档声明的范围执行。归档中未包含的类型或项目必须保留目标端原数据；被明确包含但记录数为零的类型表示替换后清空该类型。全量替换是包含全部可移植类型的特例。

明确不做：

- 不提供数据库原始 dump、整站备份或其他用户数据导出。
- Web 支持从兼容归档增量导入或按归档范围替换；桌面原生导入 UI/本地存储适配器另行实施，但必须遵循本 PRD 冻结的归档契约。
- 不导出密码哈希、登录会话、API Key、SMTP 密码、Bot/MCP 凭据、授权 token 或 Provider 私有推理状态；迁移后需重新配置连接凭据。
- 不导出 RAG 向量、搜索索引、缩略图、缓存、配额/用量和反思任务等可重建或运行态数据。
- 不打包 Workspace 绑定目录里的整个文件系统；只导出咕咕文件库和聊天附件的原始字节，以及安全的逻辑目录/绑定元数据。

本文中的“全量”指全部**可移植业务数据**，不包含账号登录身份、认证凭据、安全授权、审计/用量记录、运行态和可重建索引。替换不得删除当前账号或破坏其登录能力。

## 2. 功能需求

### FR-DATA1-01：只处理当前账号拥有的数据

用户从个人设置发起导出或导入。预览、创建任务、状态查询、取消、下载、回滚和删除任务均从认证主体派生 `user_id`，不得接受客户端指定的其他用户 ID。所有实体读写都沿用 `user_id`/`owner_user_id` 归属边界；从子表查询时必须通过所属父记录确认归属。Storage key 必须同时由归属记录校验并满足当前用户前缀，不能仅凭归档或客户端提供的 key 读取/写入对象。

创建任务前显示完整范围、附件大小和群聊/成员记忆包含提醒。创建动作要求用户二次确认；若账号安全层支持最近密码/MFA 校验，则复用该验证，不另造认证方式。

### FR-DATA1-02：导出完整且可迁移的业务资料

默认完整导出包括：

- 账号来源/展示资料（用户名、邮箱、显示名、头像引用、时区）和经过白名单筛选的非敏感偏好；不包括认证字段。导入时用户名、邮箱和账号主身份只作来源信息，不覆盖目标账号身份；显示资料与偏好按导入模式处理。
- Provider、SMTP、Bot、MCP 连接导出逐字段审查的非密钥配置摘要；归档和未来导入均标记为未连接/停用，用户需重新填写凭据并确认目标。URL 中的 userinfo、query token、加密字段、密钥、平台身份绑定和授权状态绝不进入归档；无法可靠剥离凭据的 endpoint 不导出并标记需重配。
- 项目、文件夹、文件元数据与文件正文、客户、日程事件、普通笔记、思维画布/节点/连线、用户自建 Skill、用户提交的反馈、Workspace 名称/逻辑绑定、定时任务定义。
- 全部保留期内的对话 session、消息正文及结构化内容、显示时间线、显式引用、工具交互记录、压缩摘要和已附着聊天附件；附件字节随包导出。`ConversationPendingQueue` 中尚未发送的正文和引用作为独立 `drafts` 类别，完整导出默认勾选、允许用户取消；仅导出被待发条目引用的草稿附件，孤立的暂存上传不导出。队列认领 token/租约等运行字段不导出。
- 仍可恢复的软删除记录保留原 `deleted_at` 状态；任何导入器都不得把这些记录当作未删除对象复活。已永久删除且物理字节已清理的对象不在导出范围。
- 用户创建的业务对象之间的关系，包括项目文件归属、文件夹树、笔记引用、画布布局/关系、日程关联及对话附件引用。

导出范围可由用户选择任意可移植类型子集，单个类型也可独立生成归档；每次操作生成一份包含所选范围的归档，“全选”生成完整归档。项目相关类型支持进一步选择一个或多个项目，并将选择范围写入 manifest。项目范围导出包含所选项目和按归属规则属于这些项目的记录及文件字节；不属于所选项目的独立对象不导出，未选择的全局类型也不导出。用户同时选择全局类型时，该类型按其明确类型选择导出，不从项目选择推断或扩大范围。

可选类型覆盖 `PORTABLE_CATEGORIES` 中所有可移植业务类别；`archive_docs` 是归档文档/格式标记，不作为用户数据类型提供选择。项目过滤仅应用到在关系清单中定义了项目归属的记录；全局类型单独选择。

项目归属按 portable relation/owner 关系计算，不按名称、文件路径或当前数据库 ID 猜测。对象仅属于一个项目时随该项目导出；对象被多个项目共享或无法唯一归属时，作为共享对象在预览中单独列出，不随单项目替换覆盖。若归档中项目数据引用这类共享对象，而目标端无法通过稳定身份解析引用，预检必须阻止替换并给出可处理原因。

定时任务只导出定义和参数，任何导入模式下均必须停用，不能因导入而自动发送通知、邮件或执行脚本。Workspace 只导出可移植的显示名和逻辑关系；绝对路径、设备本地路径及文件同步指纹不导出。

### FR-DATA1-03：导出个人与 IM 记忆源文件

个人 owner 记忆以 `.agent/` 中的源文件为准，导出当前格式的 `profile.json`、`pattern.json`、`daily.md`、`memory.md`、`summary.json`、`stance.json` 和 `lens.json`。若旧 `facts.json`/`facts.md` 或 `summary.md`/`summary.ts` 仍是唯一有效来源，也需按原始文件名放入 `memory/legacy/`，不得为了导出触发迁移写入或删除旧文件。

IM 记忆 scope 由当前 owner 的 `MemoryReflectionCursor`、`MemoryEntry`、`MemoryReflectionJob`、`MemoryScopeTombstone` 元组和对象存储中该用户 `.agent/im/` 前缀下符合 `MemoryScope` 路径/文件白名单的 scope 取并集，按 `(platform, bot_id, scope_type, scope_id)` 去重；以数据库行的 `owner_user_id` 或严格匹配的用户专属存储前缀为归属，不依赖 Bot 配置是否仍存在，也不得全局扫描对象存储或把未知 `.agent/` 文件一并打包。群 scope 导出 `profile.json`、`summary.json`、`daily.md`、`memory.md`、`members.json`；platform-user scope 导出 `profile.json`、`pattern.json`、`summary.json`、`daily.md`、`memory.md`。有删除墓碑的 scope 视为用户已请求删除：不导出其记忆正文，在独立删除标记清单中保留 scope 身份，桌面导入不得复活它。包内保留平台、Bot、scope 类型和 scope 关联，便于桌面端恢复隔离边界。

群聊/成员记忆与群聊消息可能含其他成员的个人信息；完整导出默认包含，但创建前必须明确提示，允许用户取消这类数据。IM 记忆来源映射（`MemoryEntry`/`MemorySource`）作为结构化 provenance 元数据导出，不得覆盖或替代 `.agent/` 记忆正文。删除墓碑只进入 `memory/im/deletion_markers.jsonl`，不导出待删除正文或内部删除任务状态；任何导入器均按墓碑保持删除状态。

### FR-DATA1-04：使用数据库无关的归档格式

归档为 ZIP，至少包括：

```text
manifest.json                 # 格式版本、快照时间、类别/记录/字节统计
README.txt                    # 人类可读的内容说明与桌面导入约定
records/account.json
records/preferences.json
records/projects.jsonl
records/files.jsonl
records/conversations/sessions.jsonl
records/conversations/messages.jsonl
records/conversations/drafts.jsonl
records/connections.jsonl
records/mind/*.jsonl
records/calendar/*.jsonl
records/memory/*.jsonl
memory/im/deletion_markers.jsonl
memory/owner/*
memory/im/scopes.jsonl
memory/im/scopes/<portable-scope-id>/*
assets/files/<portable-object-id>/payload
assets/chat/<portable-object-id>/payload
checksums.sha256
```

具体 JSONL 文件按领域维护，不要求数据库表与归档一一对应。每份归档包含稳定且不可猜测的来源 `origin_id` 和唯一 `export_id`；同一来源账号的不同导出共享 `origin_id`，同一导出文件复制后仍保有相同 `export_id`。每条实体记录包含稳定 `portable_id`、来源类型、相关时间、软删除状态及业务字段；关联使用归档内的 typed `portable_id`，不得引用数据库物理 storage key、用户内部 UUID 或服务器路径。字段使用 UTF-8、UTC 时间和明确的 `format_version`/`record_schema`。`manifest.json` 记录导出器版本、格式版本、各文件记录数、附件字节数与 SHA-256，并逐类别声明 `included`、记录数和字节数；同时声明可选的项目范围及其稳定 portable ID、显示名和关联范围。`checksums.sha256` 覆盖所有数据和附件文件。

`manifest.categories[类型].included=true` 表示该类型被选择，即使记录数为零也必须显式声明；`included=false` 表示该类型未选择，替换时必须保留目标端该类型。对于项目相关类型，类型选择还要与项目范围求交集：所选项目范围外的同类型对象仍须保留。`complete` 仅表示归档是否覆盖全部可移植类型和全部项目，不再作为部分替换的准入条件。范围声明必须区分“全部项目”和“指定项目集合”，并能区分“未选择此项目”和“已选择但该项目当前没有该类关联记录”。范围信息与归档摘要共同绑定到预检 token，避免客户端在预检后替换类型、项目或映射。

ZIP 条目路径由系统生成的 portable ID 构造，不使用原始文件名拼路径。原始文件名只作为 JSON 元数据；资产条目单独记录 MIME、字节数和 SHA-256。文本/JSON 使用 ZIP 压缩，媒体和已压缩文件直接存储，避免额外 CPU 和体积开销。

### FR-DATA1-05：导出快照完整性与失败语义

关系数据库记录使用一致性事务读取，并以 keyset/分批方式序列化，不能一次将全部会话或附件载入内存。文件及附件使用 `StorageBackend.iter_chunks()` 流式读取并计算 SHA-256；读前核对归属、版本/大小，读后再次确认源记录未被改写或删除。记忆文件按明确 allowlist 逐对象读取并计算摘要。

任一选中对象缺失、归属不一致、源记录在读取期间变化、存储故障、校验不一致或打包中断时，任务必须失败并清除未完成归档；不得生成“成功但漏数据”的 ZIP。成功归档的 manifest 标注开始/完成时间及每个源对象摘要，不声称数据库、文件存储和记忆对象之间存在跨系统原子时点快照。

### FR-DATA1-06：持久化任务、隔离暂存和安全归档传输

导出和导入均使用持久化任务，而不是请求生命周期中的 FastAPI `BackgroundTasks` 或同步构造响应体。任务状态为 `queued`、`validating`、`staging`、`applying`、`ready`、`failed`、`canceling`、`canceled`、`rolling_back`、`rolled_back`、`expired`、`needs_recovery`；可报告阶段与已处理类别/字节数，但不能在状态或日志中暴露内容。预检也必须有明确超时与归档大小/条目数上限；耗时预检走可查询的任务，不占用长连接。

每个用户同时最多一个正在执行的导出/导入/替换任务；全局 worker 并发和磁盘/对象存储预算有上限。上传归档进入私有隔离暂存区，不进入用户文件库、RAG 或公开 URL；所有对象按 owner 隔离。服务端临时文件权限限制为 owner-only；归档、待导入数据和替换回滚快照静态加密或使用现有 envelope crypto 加密。导出下载只经短时有效、重新校验 owner 的认证路由传输。导出归档和导入暂存默认 24 小时过期；替换回滚快照保留 7 天。用户可取消尚未提交的任务或提前删除导出；过期清理删除归档字节、暂存数据、快照和任务记录。下载支持大文件流式传输和断点续传，不把归档读入单个内存缓冲。

导出创建请求携带显式类型集合及项目范围；服务端按允许类型和当前用户归属重新验证，并将实际范围写入归档与持久任务。项目筛选仅作用于有项目归属的类型；全局类型由独立类型选择控制，不随项目选择自动包含。项目范围模式必须显式区分“全部项目”和“指定项目集合”，防止空列表被误解为全量。导入应用请求仍只携带预检 token、导入模式和幂等键，不接受新的类别/项目选择；替换范围从已验证 manifest 读取。

建议 API 边界：

```text
GET    /api/v1/account/data-exports/preview
POST   /api/v1/account/data-exports
GET    /api/v1/account/data-exports
GET    /api/v1/account/data-exports/{job_id}
GET    /api/v1/account/data-exports/{job_id}/download
DELETE /api/v1/account/data-exports/{job_id}
POST   /api/v1/account/data-imports/preview       # 上传至私有暂存并预检，返回短时 import_token
POST   /api/v1/account/data-imports                # import_token + mode=incremental|replace + 确认信息
GET    /api/v1/account/data-imports
GET    /api/v1/account/data-imports/{job_id}
POST   /api/v1/account/data-imports/{job_id}/cancel
POST   /api/v1/account/data-imports/{job_id}/rollback # 仅成功的 replace，且快照未过期
```

导入预检返回短时、绑定 owner、归档摘要、类型/项目范围和目标映射的 `import_token`；执行请求不得接受客户端路径、storage key、替代范围或未经预检的 archive。异源项目与目标项目的显式映射可在预检中确认，但不能修改导出范围。token 单次消费并有过期时间。所有 `{job_id}`、`import_token`、artifact 和 rollback 查询都必须有 `user_id` 条件。导出预览按类别及所选项目返回记录数和预估字节数，不返回正文。

### FR-DATA1-07：个人设置中的数据迁移流程

个人设置中的导出表单允许选择全部可移植类型；类型可任意组合，至少支持单类型归档。选择项目相关数据时可选单个或多个项目，并预览将纳入的关联对象数和附件体积。首次进入时默认全选，用户可清除选择；创建前说明群聊/成员数据可能涉及他人信息，并说明连接凭据不会迁移。导入页不重复选择类型或项目范围：预检从归档 manifest 读取导出范围，验证其安全性、兼容性和关系完整性，并展示类型/项目范围、来源、对象计数、冲突、连接重配项及目标端将被替换和保留的内容。替换必须显示精确影响范围、回滚保留期和登录身份保留说明，并通过统一确认弹窗再次确认。成功替换后在期限内显示“撤销替换”。错误提示使用脱敏结果和可重试建议，不显示 storage key、SQL、原始异常或数据正文。

### FR-DATA1-08：桌面端兼容和安全导入约束

归档格式不假设 Web 或桌面端采用 SQLite、PostgreSQL 或当前 ORM。格式升级遵循新增字段向后兼容；移除/改名字段必须提升 `format_version` 并提供转换说明。Web 和未来桌面导入器均须先校验 manifest、所有 checksum、路径安全、资源上限和引用闭合，再进入隔离暂存区；不能恢复登录密码/Token、启动定时任务或自动连接 IM/MCP/Provider。Web 增量导入和替换遵循 FR-DATA1-09/10 的冲突、原子性和回滚契约。

### FR-DATA1-09：个人设置中的增量导入

用户可在“数据与迁移”中选择兼容归档并执行“增量导入”。导入前只读预检归档版本、校验和、记录数、附件体积、来源信息、将新增/跳过的对象数及不支持项；预检不得写入目标数据。确认后由持久化任务异步执行，允许查看进度、失败原因、取消尚未提交的任务。

增量导入是只增加的操作：保留目标账号原有全部数据，不覆盖、删除或复活任何已有对象。导入对象映射为目标端新 ID，归档内关系统一映射到本次导入对象；软删除记录继续保持删除状态。相同归档重复导入必须幂等；portable identity ledger 以 `(origin_id, portable_id)` 记录已导入来源对象，因此同一来源账号后续导出的新归档也不会重复创建已导入对象。目标中已存在相同来源身份的对象按“跳过并报告”处理，绝不更新其字段。名称相同但来源身份不同的对象视为独立新增；违反目标唯一约束或不能安全映射的记录属于阻断冲突，预检必须拒绝整包应用并说明原因。确认后必须全有或全无，任何应用失败都回滚本次新增，不允许以“部分成功”隐藏未导入对象。

增量导入仅处理归档 manifest 标记为包含的类型和项目范围；未包含范围绝不写入。导入不得因为完整性标记为 false 而拒绝安全的部分归档。导入的 Provider、SMTP、Bot、MCP 项仅建立未连接/停用的配置草稿，任何情况下均不复制或复用目标账号已存凭据；定时任务创建为停用。`account.json` 中的源用户名、邮箱和认证身份不应用于目标账号，账号登录、安全和授权设置保持原样。可移植的展示资料和普通偏好在目标账号没有明确冲突时导入；冲突时保留目标值并在结果中列出。

### FR-DATA1-10：个人设置中的按类型与项目范围替换

用户可选择兼容归档执行“替换归档范围”。替换范围完全由 manifest 的类型和项目选择清单确定，不是数据库、站点或账号身份替换。允许任意非空类型子集；项目级归档允许只替换一个或多个项目及其明确关联范围。完整归档全选全部类型时，行为等同于全量替换。未包含的类别和项目必须保留目标端数据；明确包含但记录数为零的类型/项目范围表示清空对应目标范围。缺少类型声明、选择范围含未知类型或项目、校验失败、依赖不闭合、无法安全映射或存在不可转换记录时，预检必须阻止应用并说明原因。

同源归档可通过 `(origin_id, portable_id)` 将源项目映射到目标已有项目。异源归档不得按名称静默覆盖；若目标存在名称相同但来源身份不同的项目，预检须提供显式目标映射或允许作为新项目导入，用户确认后把映射写入受签名/短时 token 保护的预检结果。导入执行请求不能自行改写范围或映射。没有显式映射时，不得猜测哪个目标项目应被覆盖。

替换确认页须逐类型/项目展示将被移除、导入、清空和保留的对象统计及精确范围。只有 manifest 标记包含的范围会被替换；归档未包含的项目和类别保留。账号主身份、登录凭据和安全设置保留；若选择 `connections`，目标连接配置及对应凭据会清除，归档连接只恢复为未连接草稿；定时任务导入后停用。提交前要求二次确认，并在可用时复用最近密码/MFA 校验。

替换不能先删除再导入。先将所选范围的归档校验并写入隔离暂存区，创建覆盖所选目标范围的加密回滚快照，再进入短暂的账号写入维护窗口；完成数据投影、引用核验和目标存储校验后一次性切换。任一步骤失败都要恢复切换前所选范围的数据并把任务标为失败，不得留下只替换一部分的状态。成功后提供 7 天内有效的“撤销替换”入口；撤销也只恢复本次替换范围，不影响其他类别/项目。回滚快照到期后清除。账号主身份、密码/MFA、当前登录会话、平台授权、审计/用量记录和服务器级安全配置不属于可移植业务数据，替换时保留。

替换过程中阻止该账号新的业务写入，并对进行中的导出/导入任务作互斥处理。任务须可在 worker 重启后恢复；若无法确认切换状态，进入显式待恢复状态并保留回滚快照，不能自动按“成功”或“清空后重试”处理。

## 3. 技术方案

### 3.1 数据边界和现有读取原语

- 关系数据经认证用户和各领域 service 读取；导出层只声明一份字段白名单与关系投影，不序列化 ORM 全列。Provider/SMTP/Bot/MCP 仅输出可迁移的非密钥设置；`encrypted_value`、SMTP password、Bot secret、MCP encrypted endpoint/headers/query/credentials、平台身份绑定和安全授权记录明确排除。MCP command 与不能安全净化的 URL 因机器相关或可能含密钥而排除。
- `File.storage_key`、`ChatAttachment.storage_key` 只用于服务端从 `get_storage()` 读取。归档记录只出现 `portable_id` 和摘要，不出现物理 key。
- 复用 `StorageBackend.iter_chunks()` 支持本地/OSS 流式读取；新增按前缀分批迭代 key 的存储接口，避免现有 `list_keys()` 为 OSS 扫描全桶才能发现用户的 IM 记忆 scope。现有 `backend/app/services/files/selection.py::build_batch_zip` 不是导出实现：它只覆盖用户选中的文件库文件，并以整对象 `get()` 读入内存。
- `.agent/` 记忆按 owner 和 `MemoryScope` 明确 allowlist 读取。对象存储只允许按 `{user_id}/.agent/im/` 前缀分页枚举，并须校验 path component 后重新构造 `MemoryScope` key；owner 的向量缓存、pattern/memory chunk 向量、embedding cache、RAG projection 与临时反思产物均不导出。
- 当前 `agent_admin.list_im_memory_scopes()` 面向管理页、跨 owner 查询且有结果上限；它以 cursor 为主，不能直接作为自助导出的完整清单。导出器要实现严格 owner 过滤并合并数据库清单与用户专属 `.agent/im/` 前缀发现结果；scope 归属以数据库行的 `owner_user_id` 或严格匹配的用户专属前缀为准，即使对应 Bot 配置已删除，也不能因此漏掉记忆文件。
- RAG `KnowledgeIndexEntry` 和 `MemoryEntry` 的区别必须写进 serializer：RAG chunks/vectors 可重建、不导出；IM `MemoryEntry`/`MemorySource` 是记忆条目来源映射，作为 provenance 元数据导出；记忆正文仍来自 scope 文件。
- 查询所有子记录必须校验根实体归属，不能因 `session_id`、`message_id`、`storage_key` 或 `scope_id` 相同而跨 owner 合并。对象存储路径使用 `_component()`/当前 scope 构造器，不接受 archive 中的任意物理路径。

### 3.2 任务、暂存和替换生命周期

新增 `DataExportJob` 与 `DataImportJob` 持久化任务，记录 owner、状态、操作模式、类别选项、归档摘要、快照/应用阶段、进度计数、私有 artifact/staging/rollback key、大小、失败分类和各自过期时间；任务表本身不进入归档。Worker 从数据库 claim 带租约的任务，租约过期可接管；创建和状态转换使用 CAS/幂等键，服务重启后可恢复或清理。重复请求使用客户端幂等键，不能重复创建或应用。

导入先将上传流式写入私有 staging，限制压缩后/解压后总字节、单文件大小、条目数、压缩比和路径深度；拒绝绝对路径、`..`、重复规范化路径、符号链接及 ZIP 特殊文件。校验 manifest/schema/checksum/引用闭合后生成预检结果。确认开始后，把数据投影到隔离暂存命名空间并预先校验目标唯一性、配额和关系；禁止直接按归档路径解压到业务目录。

增量导入应用前写入持久的 portable identity ledger 和应用检查点，确保同一来源对象重试不重复创建；使用事务/补偿日志保证失败时不留下部分数据。替换按预检结果中的类型/项目范围执行，只删除所选目标对象和其明确关联数据，并只更新对应来源身份记录；未选范围的数据和 ledger 必须保留。跨类别引用必须遵循依赖规则：引用目标若同时在本次范围内，必须随归档一同校验并映射；若目标在范围外，必须在目标账号中存在可确认映射；否则预检阻断。不得静默丢弃引用或扩大替换范围。对象存储清理、文件配额账本、附件共享引用和 `.agent/` scope 写入均须遵循同一范围边界。替换在短暂的账号写入维护窗口内生成所选范围的加密回滚快照，再把隔离数据切换为活动数据。具体实现可采用数据库事务、版本代际切换或持久化补偿日志，但外部契约必须达到全有或全无：失败恢复原范围，成功可在保留期内撤销。Worker 重启后依据已持久化切换阶段继续完成或回滚；不确定时标记 `needs_recovery` 并保留两侧数据供显式恢复，绝不能猜测后清理。

所有暂存与归档均写私有临时文件/私有对象；支持的存储后端必须能限制单任务临时空间。若磁盘空间/对象存储预算不够，在开始应用前失败，不覆盖用户文件，也不扫描未知目录回收空间。最终完成 checksum、关系引用和目标数据核验后才提交应用并标记 `ready`。

### 3.3 文件范围

```text
backend/app/models/__init__.py                    【修改】增加 DataExportJob、DataImportJob 持久化任务模型
backend/alembic/versions/<revision>_data_portability.py 【新增】导出/导入任务、portable identity ledger 与恢复状态迁移
backend/app/api/v1/data_exports.py                 【新增】认证 API、任务归属校验和下载流
backend/app/api/v1/data_imports.py                 【新增】预检、提交、进度、取消和替换撤销 API
backend/app/services/data_portability/
├── __init__.py                                    【新增】领域服务出口
├── inventory.py                                   【新增】导出类别、归属查询和白名单
├── serializers.py                                 【新增】领域记录与 portable_id 投影
├── memories.py                                    【新增】owner/IM 记忆 allowlist 读取
├── archive.py                                     【新增】manifest、校验和流式 ZIP
├── imports/validate.py                            【新增】归档安全检查、版本转换和预检
├── imports/apply_incremental.py                   【新增】只新增映射、冲突报告和幂等 ledger
├── imports/replace.py                             【新增】全量替换、维护锁和回滚
└── jobs.py                                        【新增】claim、取消、重试、恢复与过期清理
backend/app/services/storage/__init__.py           【修改】提供有分页/前缀的 key 迭代，避免 OSS 全桶扫描
backend/worker.py                                  【修改】消费有界的数据导出/导入任务
backend/app/main.py                                【修改】注册 account/data-exports 和 data-imports router
frontend/src/services/api.ts                       【修改】导出/导入预检与任务 API
frontend/src/components/common/profile/ProfileModal.vue 【修改】挂载数据与迁移 pane
frontend/src/components/common/profile/ProfileDataPortabilityPane.vue 【新增】导出、增量导入、全量替换、结果和撤销 UI
backend/tests/test_data_portability_jobs.py        【新增】任务归属、恢复、互斥和过期回归
backend/tests/test_data_imports.py                 【新增】增量幂等、冲突、替换原子性和回滚回归
backend/tests/test_data_export_archive.py          【新增】归档格式、关系闭合与 checksum 回归
```

以当前代码所在的服务边界为准；不得在 `TS RAG worker` 实现公开导出 API，不得复制另一份 StorageBackend 或账户归属校验。Admin profile 以外的用户设置沿用现有 ProfileModal 和 pane 组合。数据库迁移通过 Alembic；前端使用现有 API 服务/Toast/ConfirmDialog 体系。

后续 Phase 6 基于当前实现边界迭代，不再新建一套导入/导出服务：

```text
backend/app/services/data_portability/schema.py             【修改】范围/版本化 manifest 契约
backend/app/services/data_portability/archive.py             【修改】按所选范围生成类别和项目清单
backend/app/services/data_portability/archive_validation.py 【修改】校验部分归档及范围/引用闭合
backend/app/services/data_portability/projection.py          【修改】按类型和项目归属查询记录
backend/app/services/data_portability/producers.py           【修改】组装按范围的导出对象
backend/app/services/data_portability/import_preflight.py    【修改】验证导入范围、关系与目标映射
backend/app/services/data_portability/import_apply.py        【修改】按范围执行幂等导入/替换
backend/app/services/data_portability/replace.py             【修改】范围快照、清理和恢复
backend/app/services/data_portability/worker.py              【修改】持久化范围计划及按范围切换
backend/app/services/data_portability/api_jobs.py             【修改】创建/应用请求范围校验
backend/app/services/data_portability/memories.py             【修改】按选中记忆类型/scope读写
frontend/src/components/common/profile/ProfileDataPortabilityPane.vue 【修改】类型/项目选择与范围预览
frontend/src/i18n/sections/profileData.ts                     【修改】范围、冲突和确认文案
backend/tests/test_data_portability_*.py                      【修改】后端范围与恢复行为
frontend/tests/profile/                                       【修改】导出表单与导入展示行为
```

范围计划由后端 schema/preflight 确认为唯一事实来源，并贯穿 worker、数据库清理、对象存储、配额账本及撤销；前端只展示和提交导出选择，不负责自行推导导入范围。

### 3.4 归档字段白名单

白名单以用户可读、可创建或可恢复的业务数据为准。`UserPreferences.data_json` 不可原样 dump，必须逐个列出允许迁移的显示/行为偏好键。消息内容、引用、附件名和用户自建 Skill 属用户内容，可进入归档但不能进入服务日志。

连接配置的 portable profile 只保留非密钥设置：Provider 的 provider/api_format/capability、经净化的 base URL、model/context/max token 和 reasoning/vision 选项；SMTP 的 host/port/user/from/use_ssl；Bot 的平台、显示名、公开 app id 和群聊/消息格式开关；MCP 的名称、transport、confirm mode、timeout、tool allowlist 及经净化后确认无凭据的 endpoint。Web 和桌面端导入均创建断开/停用状态，不带 source secret 值；机器命令、平台用户绑定 ID、无法安全净化的 endpoint 不导出，需由用户在目标端重新配置。替换会清除目标端原连接配置和凭据；增量导入保留原连接和凭据，只增加断开/停用的配置草稿，不把归档连接与既有 secret 拼接。

排除账号密码哈希、JWT/刷新 token、邮箱变更验证 token、BYOK/API 密钥（含 ciphertext/encrypted data key）、SMTP 密码、Bot/MCP 应用密钥、文件系统授权 grant、终端 sandbox PID/socket/租约、ProviderReasoningState、pending interaction action token、反思/索引/重建 job、AuditLog/SystemLog、usage/quota ledger、向量/embedding/thumbnail 和 worker 状态。

### 3.5 错误、日志和安全

用户可见错误经过 `redact()`；日志仅记录 job ID、owner fingerprint、类别、计数、字节数、hash、失败阶段和异常类型，原始异常只按现有 `diag_log()` 策略写受限诊断。不得记录归档文件名、聊天/笔记正文、记忆正文、附件名称、凭据或 archive payload。下载响应设置 `Cache-Control: no-store`、安全 `Content-Disposition` 和 `X-Content-Type-Options: nosniff`。

导出 artifact、导入 staging 和替换 rollback artifact 私有保存、加密、限期删除。认证下载不暴露永久 OSS URL；若对象存储需短时签名，也只能由 owner 授权 API 在 job 到期前签发最小范围、短 TTL 的单对象 URL，不把它写日志或任务详情。上传必须限制文件数和大小，并在解压时逐项校验规范化路径，防止 Zip Slip、符号链接逃逸、解压炸弹和重复路径覆盖。未完成验证的归档绝不可进入业务存储。

增量导入/替换对账号业务写入使用明确的互斥锁或维护状态：提交窗口内拒绝或排队新的冲突写入，并向用户返回可理解状态；锁必须有可恢复租约，不能因 worker 崩溃永久锁死账号。替换的 rollback artifact 不与导入源归档共用生命周期，必须在确认成功后按承诺期限保留；删除快照前先确认任务状态稳定并记录清理结果。

## 4. 验证与上线

- 两个隔离用户分别创建相同文件名、相似 ID 和不同 scope 的 fixture；归档只能含当前 owner 的记录、memory key 和附件。
- 对照每个 manifest 类别统计，验证软删除状态、所有 typed 引用闭合、消息附件、文件层级、画布关系及 IM scope 隔离完整。
- 解压归档并独立校验所有 SHA-256、记录数、ZIP 路径、JSONL 编码和 JSON schema；篡改/缺失对象必须让任务失败，不返回可下载的 ready 状态。
- 覆盖 `.agent` 当前与 legacy 文件、group/member scopes、scope tombstone、对象不存在、OSS/本地流失败、用户并发修改/删除、worker 进程重启、租约接管、取消、24 小时过期和清理失败重试。
- 使用最大配置文件/附件边界验证内存用量与单文件大小无关；确认导出下载支持 Range，不在 API 进程缓存完整 ZIP。
- 导入预检覆盖未知/不兼容格式、缺失或错误 checksum、引用断裂、路径穿越、绝对路径、符号链接、重复规范化路径、超大解压体积、极端压缩比、超多条目和伪造 MIME；所有拒绝均发生在业务数据写入前。
- 增量导入验证目标既有数据从不被覆盖/删除、软删对象不复活、重复导入同一归档不重复创建、不同来源的同名对象按预检冲突策略处理、导入失败不留部分数据，取消仅在提交边界前成功。
- 全量替换验证全类型归档行为与现有版本一致；部分替换验证缺失类别被保留、所选类型/项目按范围覆盖、显式零记录范围被清空；同时验证账号登录/安全身份保留、连接密钥按选择清除、定时任务停用、失败/进程崩溃恢复原范围、成功后可在期限内撤销，以及快照过期清除。
- 并发行为覆盖导入与导出互斥、替换提交窗口内同账号业务写入的阻止/排队、重复提交幂等键、worker 在校验/投影/切换/回滚各边界重启后的恢复。
- 对密钥诱饵值做归档扫描，确保密码、BYOK、SMTP、Bot/MCP secret 和运行状态字段缺席；检查应用日志与受限诊断路径均无正文或凭据。
- 初次灰度开放 owner 自助导出与导入，观测排队耗时、生成/应用耗时、失败阶段、归档尺寸、下载成功率、临时空间、回滚结果和过期清理滞留数；不观测/展示内容本身。
- 不修改用户 `.env`、`config.override.json` 或用户数据目录配置；停用功能可阻止新任务并保留已生成归档至 TTL，回滚迁移不删除源业务数据。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 数据分散于数据库与对象存储，导出期间可能同时修改 | 单份归档内可能混合不同更新时间 | 记录快照窗口；数据库事务读、版本复核文件、逐对象 checksum；变化或读取失败时整任务失败，不交付部分成功包。 |
| 用户私聊、群聊和成员记忆含高度敏感正文 | 归档丢失可能泄漏本人或群成员数据 | 归档下载前显式范围确认；私有短期存储、静态加密、认证流下载、自动过期，日志只记指纹和状态。 |
| 单个账号资产可达多个 GB | 同步请求或无界并发会耗尽 Web 内存/磁盘 | 持久 job、分块 I/O、全局/每用户并发限制、启动前估算空间、可取消和 TTL 清理。 |
| Web 加密凭据绑定当前服务器主密钥 | 原密文复制到桌面不可用，解密导出也会增加泄露面；增量导入也不能把旧密钥误拼到导入配置 | 不迁移任何凭据；增量导入只创建断开的配置草稿并保留目标既有连接，替换清除目标旧连接和密钥；用户重新填写并显式启用。 |
| 导入归档可能恶意构造或规模过大 | Zip Slip、解压炸弹、重复路径或伪造引用可能导致越权写入、资源耗尽或错误关联 | 私有隔离上传、严格资源限制、规范路径/条目检查、checksum/schema/引用闭合预检；校验前不写业务数据。 |
| 按范围替换跨数据库、对象存储和 `.agent/` 文件 | 范围清理遗漏或误删未选数据，跨存储失败可能造成新旧混杂 | 维护唯一范围计划并用于快照、删除、导入、配额和撤销；使用隔离投影、维护窗口、持久化切换阶段和补偿记录；失败恢复原范围，不确定时进入 `needs_recovery` 并保留两侧数据。 |
| 增量导入重复执行或对象命名冲突 | 重复创建或误覆盖目标数据 | 来源账号身份 + portable ID ledger 保证重复导入幂等；不同来源冲突在预检中报告并跳过/拒绝，不静默覆盖。 |
| 替换期间用户仍在写入 | 新旧写入可能被替换覆盖或写入即将被清除的数据 | 只在短暂应用/切换阶段进入账号级维护窗口；预检期间不锁写，明确反馈冲突写入的排队或拒绝状态。 |
| 归档格式与未来桌面应用尚无共同数据模型 | 过早映射当前 DB 会导致迁移格式再次变更 | 用稳定 portable IDs、typed links、语义版本和 JSONL 冻结交换契约；桌面端以 adapter 导入，不以 ORM schema 为格式。 |
| 一部分 IM scope 文件在对象存储，scope 元数据分散在不同表 | 单纯按对象 key 扫描会漏记忆或带入未知内部文件；管理页清单也不是完整导出接口 | 从 owner 过滤后的 cursor/entry/job/tombstone 元组并集枚举 scope，通过 `MemoryScope` allowlist 读取；删除墓碑生成不可复活标记；禁止把整个 `.agent/` 前缀打包。 |

桌面端仓库和目标本地数据模型、桌面导入 UI 仍待后续确定；Web 的增量/替换语义、冲突预检、重复导入幂等和账号身份边界已在本 PRD 冻结。v1 不支持用户口令加密归档，服务端暂存与回滚快照由服务端加密管理。

## 6. 唯一实施 TODO

本阶段是后续版本目标，不纳入当前版本。现有 DATA1-001 至 DATA1-007 保留为已完成基线；以下任务未开始，实施前需按当时的仓库现状复核文件边界和归档兼容策略。

### Phase 1：冻结可移植格式和导入语义

- [x] `DATA1-001` 建立导出类别/字段 allowlist、portable archive schema、来源包身份和冲突规则；验收：增量只增加、同包幂等、跨来源冲突不覆盖、完整归档必需类别和可机器读取示例明确，并由隔离用户 fixture 验证边界。

### Phase 2：任务、隔离暂存和回滚生命周期

- [x] `DATA1-002` 增加导出/导入任务模型、portable identity ledger、worker lease/claim、私有加密 artifact/staging/rollback store、恢复和过期清理；验收：worker 重启可接管或恢复任务，用户只能访问本人 job，单用户/全局并发、互斥和空间限制生效。

### Phase 3：完整数据导出、增量导入和全量替换

- [x] `DATA1-003` 实现数据库分批投影、记忆 scope allowlist、文件/聊天附件分块读写、manifest/checksum 和安全归档验证；验收：引用闭合，任一源缺失/变化时导出失败，恶意/不完整归档在写业务数据前被拒绝。
- [x] `DATA1-004` 实现增量导入的 portable ID 映射、ledger 幂等、冲突预检、关系/文件/记忆应用和失败补偿；验收：目标原对象不被覆盖/删除，重放同一归档不重复创建，失败不留半成品。
- [x] `DATA1-005` 实现完整归档替换、账号维护窗口、加密回滚快照、切换恢复和限期撤销；验收：完整归档的数据切换成功，任何故障可恢复旧数据，登录身份保留且旧连接密钥清除。

### Phase 4：用户 API 和设置界面

- [x] `DATA1-006` 提供导出/导入预检、任务创建/查询、下载、取消、替换撤销 API 与 ProfileModal 数据迁移 pane；验收：两种导入模式清楚展示范围/冲突/影响，替换二次确认和撤销期限明确，进度和错误不泄露正文，下载认证、无缓存且支持大文件 Range。

### Phase 5：回归、安全和部署验收

- [x] `DATA1-007` 完成 Web 部署验收：本地 43 项数据可移植回归通过；devserver 隔离测试账号真实任务链通过，覆盖完整归档导出与 ZIP/checksum 校验、HTTP Range 下载、跨账号增量导入、完整替换及回滚。替换回滚后原项目集和临时验收项目均恢复，临时项目已清理。自动化回归覆盖失败恢复、流式 Range 下载和归档/暂存/回滚快照过期清理；未对真实用户账号执行替换。

### Phase 6：按类型导出、项目范围替换与导入撤回（后续版本）

- [ ] `DATA1-009` 扩展归档范围契约；验收：manifest 能表达任意可移植类型子集、单类型归档、所选项目及项目关联数据范围，并区分未选择与已选择但零记录；完整归档标记仍兼容现有格式，旧归档继续可预检和导入。
- [ ] `DATA1-010` 将所有可移植类型接入导出范围选择；验收：用户可任意组合类型、单独导出一个类型或全选；项目相关类型可选一个或多个项目；预览按类型/项目显示记录数和估算附件体积，实际归档范围与 manifest 完全一致。
- [ ] `DATA1-011` 实现范围感知的导入预检；验收：导入只从归档读取类型和项目范围，不提供重复范围选择；验证 manifest、类型/项目归属、依赖闭合及目标映射；异源项目不按名称静默覆盖，无法安全映射时阻止应用并说明原因；预检 token 绑定归档摘要、范围及映射。
- [ ] `DATA1-012` 实现按类型与项目范围的原子替换和撤销；验收：仅替换 manifest 明确包含的目标范围，未包含范围及其 portable identity ledger 保持不变；显式包含但零记录的范围会被清空；数据库、对象存储、附件引用、配额和记忆文件均按范围一致切换；失败恢复原范围，成功后的撤销也仅恢复原范围。
- [ ] `DATA1-013` 更新个人设置导出与导入界面；验收：导出页提供类型和项目选择及范围预览；导入页展示归档自带范围、映射、冲突以及将替换/保留的数据，不要求用户再次选择类型或项目；确认信息、空范围和零记录语义清楚且完成全部 i18n。
- [ ] `DATA1-014` 验证部分归档与项目级替换全链路；验收：覆盖单类型导出、任意类别子集、零记录清空、排除类别保留、单项目/多项目替换、共享对象及跨类别引用阻断、同源/异源映射、失败恢复、worker 重启恢复、范围内撤销和跨用户隔离；确认旧完整归档行为不回归。
- [ ] `DATA1-015` 为成功的增量导入提供限期撤回；验收：每个增量任务持久记录本次实际新增/创建的 portable identity、存储对象及必要的前后状态，并保存服务端加密、限期清理的撤回材料；用户可在有效期内从任务记录发起撤回，撤回作为独立幂等任务执行，并支持 worker 重启恢复。撤回必须只移除本次导入创建且仍与导入后状态一致的对象，不得覆盖目标端原有数据、误删共享附件或清除导入后新增的用户数据；若对象被后续编辑、引用或状态变化导致无法安全还原，必须在写入前整体拒绝并说明冲突，不能部分撤回或静默跳过。撤回完成后同步清理对应 portable identity ledger、配额和本次专属存储对象；过期材料自动清理，跨用户撤回必须被拒绝。

### 后续桌面端导入

- [ ] `DATA1-008` 桌面端代码库与目标 schema 确认后，新增 importer PRD 并实现此格式的校验、ID 映射和安全投影；验收：从 Web 归档恢复资料/记忆/附件，禁止自动恢复凭据或触发外部发送。
