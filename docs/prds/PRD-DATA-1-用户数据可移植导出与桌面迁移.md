# PRD-DATA-1：用户数据可移植导出与桌面迁移

> 状态：待实施；当前系统没有整账号可移植导出，也没有桌面端导入器
> 创建：2026-09-28
> 最近更新：2026-09-28
> 关联模块：`backend/app/models/__init__.py`、`backend/app/services/storage/`、`backend/agent/memory/`、`backend/app/api/v1/`、`frontend/src/components/common/profile/`
> 背景参考：`docs/prds/【已完成】PRD-RAG-10-TS查询期数据读取与准备迁移.md`、`docs/prds/【已完成】PRD-STORAGE-1-暂存附件孤儿清理与视频转码缓存.md`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 用户业务数据按登录用户读取 | ✅ 已完成 | 项目、文件、会话、笔记等通过分域 API 读取，没有统一导出清单。 |
| 文件和聊天附件存储 | ✅ 已完成 | 元数据在数据库，文件字节由本地/对象存储抽象层读取。 |
| 长期记忆读取 | ✅ 已完成 | 个人记忆及 IM 群/成员记忆主要存于 `.agent/` 对象文件；数据库保存部分来源索引和删除屏障。 |
| 全量用户数据归档 | 🔲 待实施 | 现有文件批量下载不含其余数据库记录、完整对话和记忆。 |
| 桌面端读取/导入归档 | 🔲 待评估 | 仓库内没有桌面端应用；本 PRD 先冻结可移植格式，桌面导入器在目标应用存在后实施。 |

## 1. 背景与目标

咕咕用户数据不在单一数据库表或单一存储中：项目、日程、笔记、对话等在关系数据库；文件和聊天附件的字节在本地/对象存储；个人长期记忆与 IM 群/成员记忆保存在按用户分区的 `.agent/` 对象文件；记忆来源索引、scope 删除屏障和 RAG 索引又有部分在数据库。仅执行 `pg_dump` 会漏掉记忆文件及附件，并把当前表结构、运行字段和凭据存储细节暴露给迁移方。

现有 `/files` 批量 ZIP 只处理用户选中的文件库对象，不能覆盖用户的完整资料和对话。其 ZIP 逻辑也不是全账号导出的合适入口：导出需要完整的数据清单、跨表引用、记忆文件、聊天附件、校验清单和较大的流式对象。

本 PRD 目标是提供用户可自行发起的完整数据归档下载。归档用版本化、可阅读的 JSONL/Markdown/JSON 加二进制附件组成，服务端仍以各领域 service、StorageBackend 和显式字段白名单读取。归档格式不依赖 PostgreSQL、当前 ORM 主键策略或物理 storage key，使未来桌面端可以独立校验和导入。

明确不做：

- 不提供数据库原始 dump、整站备份或其他用户数据导出。
- v1 不向 Web 服务回灌归档；桌面端导入器另行实现，但必须遵循本 PRD 冻结的归档契约。
- 不导出密码哈希、登录会话、API Key、SMTP 密码、Bot/MCP 凭据、授权 token 或 Provider 私有推理状态；迁移后需重新配置连接凭据。
- 不导出 RAG 向量、搜索索引、缩略图、缓存、配额/用量和反思任务等可重建或运行态数据。
- 不打包 Workspace 绑定目录里的整个文件系统；只导出咕咕文件库和聊天附件的原始字节，以及安全的逻辑目录/绑定元数据。

## 2. 功能需求

### FR-DATA1-01：只导出当前账号拥有的数据

用户从个人设置发起导出。预览、创建任务、状态查询、取消、下载和删除任务均从认证主体派生 `user_id`，不得接受客户端指定的其他用户 ID。所有实体查询都沿用 `user_id`/`owner_user_id` 归属边界；从子表查询时必须通过所属父记录确认归属。Storage key 必须同时由归属记录校验并满足当前用户前缀，不能仅凭客户端提供的 key 读取对象。

创建任务前显示完整范围、附件大小和群聊/成员记忆包含提醒。创建动作要求用户二次确认；若账号安全层支持最近密码/MFA 校验，则复用该验证，不另造认证方式。

### FR-DATA1-02：导出完整且可迁移的业务资料

默认完整导出包括：

- 账号身份/展示资料（用户名、邮箱、显示名、头像引用、时区）和经过白名单筛选的非敏感偏好；不包括认证字段。
- Provider、SMTP、Bot、MCP 连接导出逐字段审查的非密钥配置摘要；归档和未来导入均标记为未连接/停用，用户需重新填写凭据并确认目标。URL 中的 userinfo、query token、加密字段、密钥、平台身份绑定和授权状态绝不进入归档；无法可靠剥离凭据的 endpoint 不导出并标记需重配。
- 项目、文件夹、文件元数据与文件正文、客户、日程事件、普通笔记、思维画布/节点/连线、用户自建 Skill、用户提交的反馈、Workspace 名称/逻辑绑定、定时任务定义。
- 全部保留期内的对话 session、消息正文及结构化内容、显示时间线、显式引用、工具交互记录、压缩摘要和已附着聊天附件；附件字节随包导出。`ConversationPendingQueue` 中尚未发送的正文和引用作为独立 `drafts` 类别，完整导出默认勾选、允许用户取消；仅导出被待发条目引用的草稿附件，孤立的暂存上传不导出。队列认领 token/租约等运行字段不导出。
- 仍可恢复的软删除记录保留原 `deleted_at` 状态；桌面端导入不得把这些记录当作未删除对象复活。已永久删除且物理字节已清理的对象不在导出范围。
- 用户创建的业务对象之间的关系，包括项目文件归属、文件夹树、笔记引用、画布布局/关系、日程关联及对话附件引用。

定时任务只导出定义和参数，桌面端导入时必须停用，不能因导入而自动发送通知、邮件或执行脚本。Workspace 只导出可移植的显示名和逻辑关系；绝对路径、设备本地路径及文件同步指纹不导出。

### FR-DATA1-03：导出个人与 IM 记忆源文件

个人 owner 记忆以 `.agent/` 中的源文件为准，导出当前格式的 `profile.json`、`pattern.json`、`daily.md`、`memory.md`、`summary.json`、`stance.json` 和 `lens.json`。若旧 `facts.json`/`facts.md` 或 `summary.md`/`summary.ts` 仍是唯一有效来源，也需按原始文件名放入 `memory/legacy/`，不得为了导出触发迁移写入或删除旧文件。

IM 记忆 scope 由当前 owner 的 `MemoryReflectionCursor`、`MemoryEntry`、`MemoryReflectionJob`、`MemoryScopeTombstone` 元组和对象存储中该用户 `.agent/im/` 前缀下符合 `MemoryScope` 路径/文件白名单的 scope 取并集，按 `(platform, bot_id, scope_type, scope_id)` 去重；以数据库行的 `owner_user_id` 或严格匹配的用户专属存储前缀为归属，不依赖 Bot 配置是否仍存在，也不得全局扫描对象存储或把未知 `.agent/` 文件一并打包。群 scope 导出 `profile.json`、`summary.json`、`daily.md`、`memory.md`、`members.json`；platform-user scope 导出 `profile.json`、`pattern.json`、`summary.json`、`daily.md`、`memory.md`。有删除墓碑的 scope 视为用户已请求删除：不导出其记忆正文，在独立删除标记清单中保留 scope 身份，桌面导入不得复活它。包内保留平台、Bot、scope 类型和 scope 关联，便于桌面端恢复隔离边界。

群聊/成员记忆与群聊消息可能含其他成员的个人信息；完整导出默认包含，但创建前必须明确提示，允许用户取消这类数据。IM 记忆来源映射（`MemoryEntry`/`MemorySource`）作为结构化 provenance 元数据导出，不得覆盖或替代 `.agent/` 记忆正文。删除墓碑只进入 `memory/im/deletion_markers.jsonl`，不导出待删除正文或内部删除任务状态。

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

具体 JSONL 文件按领域维护，不要求数据库表与归档一一对应。每条实体记录包含稳定 `portable_id`、来源类型、相关时间、软删除状态及业务字段；关联使用归档内的 typed `portable_id`，不得引用数据库物理 storage key、用户内部 UUID 或服务器路径。字段使用 UTF-8、UTC 时间和明确的 `format_version`/`record_schema`。`manifest.json` 记录导出器版本、格式版本、各文件记录数、附件字节数与 SHA-256；`checksums.sha256` 覆盖所有数据和附件文件。

ZIP 条目路径由系统生成的 portable ID 构造，不使用原始文件名拼路径。原始文件名只作为 JSON 元数据；资产条目单独记录 MIME、字节数和 SHA-256。文本/JSON 使用 ZIP 压缩，媒体和已压缩文件直接存储，避免额外 CPU 和体积开销。

### FR-DATA1-05：导出快照完整性与失败语义

关系数据库记录使用一致性事务读取，并以 keyset/分批方式序列化，不能一次将全部会话或附件载入内存。文件及附件使用 `StorageBackend.iter_chunks()` 流式读取并计算 SHA-256；读前核对归属、版本/大小，读后再次确认源记录未被改写或删除。记忆文件按明确 allowlist 逐对象读取并计算摘要。

任一选中对象缺失、归属不一致、源记录在读取期间变化、存储故障、校验不一致或打包中断时，任务必须失败并清除未完成归档；不得生成“成功但漏数据”的 ZIP。成功归档的 manifest 标注开始/完成时间及每个源对象摘要，不声称数据库、文件存储和记忆对象之间存在跨系统原子时点快照。

### FR-DATA1-06：大数据量异步生成与安全下载

使用持久化导出任务，而不是请求生命周期中的 FastAPI `BackgroundTasks` 或同步构造响应体。任务状态为 `queued`、`running`、`ready`、`failed`、`canceled`、`expired`，可报告阶段与已处理类别/字节数，但不能在状态或日志中暴露内容。

每个用户同时最多一个未完成任务；全局 worker 并发和磁盘/对象存储预算有上限。归档保存在私有临时前缀，不进入用户文件库、RAG 或公开 URL。服务端临时文件权限限制为 owner-only；临时归档静态加密或使用现有 envelope crypto 加密，下载只经短时有效、重新校验 owner 的认证路由传输。任务默认 24 小时过期，用户可取消或提前删除；过期清理删除归档字节和任务记录。下载支持大文件流式传输和断点续传，不把归档读入单个内存缓冲。

建议 API 边界：

```text
GET    /api/v1/account/data-exports/preview
POST   /api/v1/account/data-exports
GET    /api/v1/account/data-exports
GET    /api/v1/account/data-exports/{job_id}
GET    /api/v1/account/data-exports/{job_id}/download
DELETE /api/v1/account/data-exports/{job_id}
```

预览仅返回数据类别、记录数和预估字节数，不返回正文。所有 `{job_id}` 查询都必须有 `user_id` 条件。

### FR-DATA1-07：个人设置中的导出流程

个人设置新增“数据与迁移”区块，提供范围预览、IM 对话、群/成员记忆及待发草稿类别选择、开始导出、进度/错误状态、下载、取消和删除。完整导出默认包含所有可移植类别；创建前说明群聊/成员数据可能涉及他人信息，并说明连接凭据需在桌面端重新配置。错误提示使用脱敏结果和可重试建议，不显示 storage key、SQL、原始异常或数据正文。

### FR-DATA1-08：桌面端兼容和安全导入约束

本 PRD 只实现服务端导出及归档格式，不假设桌面端采用 SQLite、PostgreSQL 或现有 ORM。格式升级遵循新增字段向后兼容；移除/改名字段必须提升 `format_version` 并提供转换说明。桌面导入器未来必须先校验 manifest、所有 checksum、路径安全和引用闭合，再导入到临时区；必须幂等处理同一 archive、显式报告冲突，且不能恢复密码/Token、启动定时任务或自动连接 IM/MCP/Provider。

## 3. 技术方案

### 3.1 数据边界和现有读取原语

- 关系数据经认证用户和各领域 service 读取；导出层只声明一份字段白名单与关系投影，不序列化 ORM 全列。Provider/SMTP/Bot/MCP 仅输出可迁移的非密钥设置；`encrypted_value`、SMTP password、Bot secret、MCP encrypted endpoint/headers/query/credentials、平台身份绑定和安全授权记录明确排除。MCP command 与不能安全净化的 URL 因机器相关或可能含密钥而排除。
- `File.storage_key`、`ChatAttachment.storage_key` 只用于服务端从 `get_storage()` 读取。归档记录只出现 `portable_id` 和摘要，不出现物理 key。
- 复用 `StorageBackend.iter_chunks()` 支持本地/OSS 流式读取；新增按前缀分批迭代 key 的存储接口，避免现有 `list_keys()` 为 OSS 扫描全桶才能发现用户的 IM 记忆 scope。现有 `backend/app/services/files/selection.py::build_batch_zip` 不是导出实现：它只覆盖用户选中的文件库文件，并以整对象 `get()` 读入内存。
- `.agent/` 记忆按 owner 和 `MemoryScope` 明确 allowlist 读取。对象存储只允许按 `{user_id}/.agent/im/` 前缀分页枚举，并须校验 path component 后重新构造 `MemoryScope` key；owner 的向量缓存、pattern/memory chunk 向量、embedding cache、RAG projection 与临时反思产物均不导出。
- 当前 `agent_admin.list_im_memory_scopes()` 面向管理页、跨 owner 查询且有结果上限；它以 cursor 为主，不能直接作为自助导出的完整清单。导出器要实现严格 owner 过滤并合并数据库清单与用户专属 `.agent/im/` 前缀发现结果；scope 归属以数据库行的 `owner_user_id` 或严格匹配的用户专属前缀为准，即使对应 Bot 配置已删除，也不能因此漏掉记忆文件。
- RAG `KnowledgeIndexEntry` 和 `MemoryEntry` 的区别必须写进 serializer：RAG chunks/vectors 可重建、不导出；IM `MemoryEntry`/`MemorySource` 是记忆条目来源映射，作为 provenance 元数据导出；记忆正文仍来自 scope 文件。
- 查询所有子记录必须校验根实体归属，不能因 `session_id`、`message_id`、`storage_key` 或 `scope_id` 相同而跨 owner 合并。对象存储路径使用 `_component()`/当前 scope 构造器，不接受 archive 中的任意物理路径。

### 3.2 任务和打包生命周期

新增 `DataExportJob` 持久化用户、状态、类别选项、快照起止时间、进度计数、私有 artifact key、大小、校验摘要、失败分类和过期时间；任务表本身不进入归档。Worker 从数据库 claim 带租约的任务，租约过期可接管；创建和状态转换使用 CAS/幂等键，服务重启后可恢复或清理。

先生成数据库记录快照和 archive 内对象引用，再分块拉取文件与记忆对象。压缩器直接写私有临时文件/私有对象；支持的存储后端必须能限制单任务临时空间。若磁盘空间/对象存储预算不够，在启动前失败，不覆盖用户文件，也不扫描未知目录回收空间。最终完成 checksum、ZIP 中央目录和关系引用核验后才原子切换到 `ready`。

### 3.3 文件范围

```text
backend/app/models/__init__.py                    【修改】增加 DataExportJob 持久化任务模型
backend/alembic/versions/<revision>_data_exports.py 【新增】导出任务表迁移
backend/app/api/v1/data_exports.py                 【新增】认证 API、任务归属校验和下载流
backend/app/services/data_export/
├── __init__.py                                    【新增】领域服务出口
├── inventory.py                                   【新增】导出类别、归属查询和白名单
├── serializers.py                                 【新增】领域记录与 portable_id 投影
├── memories.py                                    【新增】owner/IM 记忆 allowlist 读取
├── archive.py                                     【新增】manifest、校验和流式 ZIP
└── jobs.py                                        【新增】claim、取消、重试与过期清理
backend/app/services/storage/__init__.py           【修改】提供有分页/前缀的 key 迭代，避免 OSS 全桶扫描
backend/worker.py                                  【修改】消费有界的数据导出任务
backend/app/main.py                                【修改】注册 account/data-exports router
frontend/src/services/api.ts                       【修改】导出预览与任务 API
frontend/src/components/common/profile/ProfileModal.vue 【修改】挂载数据与迁移 pane
frontend/src/components/common/profile/ProfileDataExportPane.vue 【新增】预览、任务进度和下载 UI
backend/tests/test_data_exports.py                 【新增】归属、覆盖、完整性、超大文件、失败和过期回归
backend/tests/test_data_export_archive.py          【新增】归档格式、关系闭合与 checksum 回归
```

以当前代码所在的服务边界为准；不得在 `TS RAG worker` 实现公开导出 API，不得复制另一份 StorageBackend 或账户归属校验。Admin profile 以外的用户设置沿用现有 ProfileModal 和 pane 组合。数据库迁移通过 Alembic；前端使用现有 API 服务/Toast/ConfirmDialog 体系。

### 3.4 归档字段白名单

白名单以用户可读、可创建或可恢复的业务数据为准。`UserPreferences.data_json` 不可原样 dump，必须逐个列出允许迁移的显示/行为偏好键。消息内容、引用、附件名和用户自建 Skill 属用户内容，可进入归档但不能进入服务日志。

连接配置的 portable profile 只保留非密钥设置：Provider 的 provider/api_format/capability、经净化的 base URL、model/context/max token 和 reasoning/vision 选项；SMTP 的 host/port/user/from/use_ssl；Bot 的平台、显示名、公开 app id 和群聊/消息格式开关；MCP 的名称、transport、confirm mode、timeout、tool allowlist 及经净化后确认无凭据的 endpoint。桌面端全部导入为断开/停用状态，不带 source secret 值；机器命令、平台用户绑定 ID、无法安全净化的 endpoint 不导出，需由用户在桌面端重新配置。

排除账号密码哈希、JWT/刷新 token、邮箱变更验证 token、BYOK/API 密钥（含 ciphertext/encrypted data key）、SMTP 密码、Bot/MCP 应用密钥、文件系统授权 grant、终端 sandbox PID/socket/租约、ProviderReasoningState、pending interaction action token、反思/索引/重建 job、AuditLog/SystemLog、usage/quota ledger、向量/embedding/thumbnail 和 worker 状态。

### 3.5 错误、日志和安全

用户可见错误经过 `redact()`；日志仅记录 job ID、owner fingerprint、类别、计数、字节数、hash、失败阶段和异常类型，原始异常只按现有 `diag_log()` 策略写受限诊断。不得记录归档文件名、聊天/笔记正文、记忆正文、附件名称、凭据或 archive payload。下载响应设置 `Cache-Control: no-store`、安全 `Content-Disposition` 和 `X-Content-Type-Options: nosniff`。

导出 artifact 私有保存、加密、限期删除。认证下载不暴露永久 OSS URL；若对象存储需短时签名，也只能由 owner 授权 API 在 job 到期前签发最小范围、短 TTL 的单对象 URL，不把它写日志或任务详情。

## 4. 验证与上线

- 两个隔离用户分别创建相同文件名、相似 ID 和不同 scope 的 fixture；归档只能含当前 owner 的记录、memory key 和附件。
- 对照每个 manifest 类别统计，验证软删除状态、所有 typed 引用闭合、消息附件、文件层级、画布关系及 IM scope 隔离完整。
- 解压归档并独立校验所有 SHA-256、记录数、ZIP 路径、JSONL 编码和 JSON schema；篡改/缺失对象必须让任务失败，不返回可下载的 ready 状态。
- 覆盖 `.agent` 当前与 legacy 文件、group/member scopes、scope tombstone、对象不存在、OSS/本地流失败、用户并发修改/删除、worker 进程重启、租约接管、取消、24 小时过期和清理失败重试。
- 使用最大配置文件/附件边界验证内存用量与单文件大小无关；确认导出下载支持 Range，不在 API 进程缓存完整 ZIP。
- 对密钥诱饵值做归档扫描，确保密码、BYOK、SMTP、Bot/MCP secret 和运行状态字段缺席；检查应用日志与受限诊断路径均无正文或凭据。
- 初次灰度仅开放 owner 自助完整导出，观测排队耗时、生成耗时、失败阶段、归档尺寸、下载成功率、临时空间和过期清理滞留数；不观测/展示内容本身。
- 不修改用户 `.env`、`config.override.json` 或用户数据目录配置；停用功能可阻止新任务并保留已生成归档至 TTL，回滚迁移不删除源业务数据。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 数据分散于数据库与对象存储，导出期间可能同时修改 | 单份归档内可能混合不同更新时间 | 记录快照窗口；数据库事务读、版本复核文件、逐对象 checksum；变化或读取失败时整任务失败，不交付部分成功包。 |
| 用户私聊、群聊和成员记忆含高度敏感正文 | 归档丢失可能泄漏本人或群成员数据 | 归档下载前显式范围确认；私有短期存储、静态加密、认证流下载、自动过期，日志只记指纹和状态。 |
| 单个账号资产可达多个 GB | 同步请求或无界并发会耗尽 Web 内存/磁盘 | 持久 job、分块 I/O、全局/每用户并发限制、启动前估算空间、可取消和 TTL 清理。 |
| Web 加密凭据绑定当前服务器主密钥 | 原密文复制到桌面不可用，解密导出也会增加泄露面 | v1 只迁移安全白名单中的连接配置，不迁移任何凭据；用户在桌面端重新输入密钥并显式启用连接。 |
| 归档格式与未来桌面应用尚无共同数据模型 | 过早映射当前 DB 会导致迁移格式再次变更 | 用稳定 portable IDs、typed links、语义版本和 JSONL 冻结交换契约；桌面端以 adapter 导入，不以 ORM schema 为格式。 |
| 一部分 IM scope 文件在对象存储，scope 元数据分散在不同表 | 单纯按对象 key 扫描会漏记忆或带入未知内部文件；管理页清单也不是完整导出接口 | 从 owner 过滤后的 cursor/entry/job/tombstone 元组并集枚举 scope，通过 `MemoryScope` allowlist 读取；删除墓碑生成不可复活标记；禁止把整个 `.agent/` 前缀打包。 |

待桌面端仓库和目标本地数据模型明确后，再单独确定导入 UI、冲突策略、重复导入、账号关联及是否支持加密归档口令；这些事项不阻塞 v1 导出格式。

## 6. 唯一实施 TODO

### Phase 1：冻结可移植格式和用户数据范围

- [ ] `DATA1-001` 建立导出类别/字段 allowlist 与 portable archive schema；验收：关系型对象、软删状态、记忆文件、IM provenance、媒体资产、凭据排除和版本兼容规则均有可机器读取的格式示例，并由两组隔离用户 fixture 验证边界。

### Phase 2：任务和私有 artifact 生命周期

- [ ] `DATA1-002` 增加 Alembic 导出任务模型、worker lease/claim、取消/过期清理和私有加密 artifact store；验收：worker 重启可接管任务，用户只能列出/下载/删除本人 job，单用户/全局并发与临时空间限制生效。

### Phase 3：完整数据读取与流式归档

- [ ] `DATA1-003` 实现数据库分批投影、记忆 scope allowlist、文件/聊天附件分块读取、manifest 和校验；验收：所有记录关联可追踪，所有字节有 SHA-256，任一源缺失/变化时不产生成功的部分归档。

### Phase 4：用户 API 和设置界面

- [ ] `DATA1-004` 提供预览、任务创建/查询、下载、取消/删除 API 与 ProfileModal 数据导出 pane；验收：创建前展示范围和群成员数据提示，进度和错误状态无正文，下载为认证、无缓存、支持大文件 Range。

### Phase 5：回归、安全和部署验收

- [ ] `DATA1-005` 覆盖隔离、完整性、secret absence、存储故障、取消/重试/过期和本地/OSS 路径，执行本地后端/前端 CI 并做 devserver 大文件导出验收；验收：内存不随文件体积增长、archive 可独立校验、临时文件按 TTL 清干净，用户数据源未被改写。

### 后续桌面端导入

- [ ] `DATA1-006` 桌面端代码库与目标 schema 确认后，新增 importer PRD 并实现此格式的校验、ID 映射、冲突预览、重复导入幂等和默认停用定时任务；验收：从 Web 归档恢复资料/记忆/附件，禁止自动恢复凭据或触发外部发送。
