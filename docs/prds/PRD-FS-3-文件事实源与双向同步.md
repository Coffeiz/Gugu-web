# PRD-FS-3：文件事实源与双向同步

> 状态：🟢 Phase 5 管理、观测与上线收口已完成（派生消费者按现有链路/后续专项管理）
> 创建：2026-09-06
> 最近更新：2026-09-06
> 关联模块：`backend/app/services/storage/`、`backend/app/services/files/`、`backend/app/services/workspaces.py`、`backend/app/services/filesystem_authorization.py`、`backend/agent/sandbox/`、`backend/agent/tools/shell.py`、`backend/app/api/v1/config.py`、`frontend/src/stores/filesCache.ts`、`frontend/src/stores/live.ts`
> 背景参考：[`docs/backend/storage.md`](../backend/storage.md)、[`PRD-SHELL-1-工作区Shell沙盒`](./【已完成】PRD-SHELL-1-工作区Shell沙盒.md)、[`桌面应用迁移方案`](../product/_archibe/桌面应用迁移方案.md)

## 0. 实际状态

| 能力 | 结果 | 说明 |
| --- | --- | --- |
| Web/Agent 文件写入 | 🟡 部分完成 | 业务 API 能同时更新物理存储和 `File`/`Folder`，并沿用现有文件事件；统一写入 filesync journal 的来源标记仍待后续接入。 |
| DB 变更到 UI | ✅ 已接入 | Shell 收尾和本地绑定 API 在 DB commit 前写入 outbox，提交后复用 `files` canonical refresh；事件不携带正文，投递失败由 outbox 重试。 |
| 本地存储对账 | 🟡 部分完成 | Admin 低频对账仍保留；Phase 2 增加可重试的本地 reconcile。 |
| Shell 工作区同步 | ✅ 已完成 Phase 2 | workspace Shell 命令执行前建立基线，命令结束后扫描并投影新建、修改、移动和删除。 |
| 本地目录双向同步 | 🟡 后端已接入 | 支持首次 dry-run、实际 DB→目录复制的 `mirror_out`、`mirror_in` 和受控 `bidirectional`；绑定只允许当前用户 local storage 根内目录，冲突快照与删除保护已落库。 |
| OSS 模式 Shell | ✅ 已完成边界 | OSS 模式只提供独立 Shell 沙盒，不显示项目/个人文件，不支持 workspace 绑定，也不做 OSS 文件同步。 |
| RAG、缩略图、配额联动 | 🟡 边界已复核 | 同步结果已进入 canonical 文件事件和文件统计；配额由现有账本维护，缩略图由文件服务按需/后台生成；本 PRD 不新增重复消费者，RAG 专用异步消费与失败重试另列专项。 |
| Phase 1 协议与安全基线 | ✅ 已完成 | 已固化同步绑定、journal、revision、幂等键、路径边界和 OSS workspace 拒绝规则。 |
| Phase 2 本地文件与 Shell 同步 | ✅ 后端基础能力已完成 | 已提供本地轮询候选发现器、全量 reconcile 补偿、File/Folder 投影，以及 workspace Shell 命令前基线和命令后收尾；运行时 watcher 调度与 OSS/独立 Shell 边界保持在后续收口阶段。 |
| Phase 3 本地目录双向同步 | ✅ 后端基础能力已完成 | 已提供首次绑定 dry-run、三种模式、DB→目录复制、删除保护、快照驱动的冲突处理 API，以及 commit 前 outbox + commit 后 canonical 文件事件。 |

## 1. 背景与目标

### 1.1 背景

文件当前同时存在于数据库、LocalStorageBackend、OSS、用户本地目录语义和 Shell 工作区中。Web 文件库与 Agent 文件工具经过 `FileService` 写入时，通常能同时维护 DB 元数据和物理对象；Shell 则直接在挂载目录中执行命令，因此可以创建、覆盖、移动或删除物理文件，却没有一个统一入口更新 `files`、`folders`、回收站、配额和前端缓存。

现有 `/admin/config/reconcile-storage` 能发现物理孤儿并人工 `import`，但它是低频修复工具，不能承担 Shell 命令后的实时同步。另一方面，OSS 没有本地目录可供容器直接挂载，不能把 OSS key 假装成普通文件系统路径。

### 1.2 目标

1. 建立统一的文件变更协议，让 Web、Agent、Shell 和本地目录的变更都能进入同一条 DB 投影与事件链。
2. Shell 在授权工作区内创建、修改、移动和删除文件后，文件库能够在可定义的延迟内显示正确的文件和文件夹元数据。
3. 本地目录支持受控的双向同步：外部文件变化可以进入文件库，文件库变化可以安全地落到本地目录。
4. OSS 模式下保持 Shell 与 OSS 文件库隔离，仅提供独立 Shell 沙盒，不引入 OSS 文件同步或目录挂载语义。
5. 文件 DB、物理对象、回收站、配额、缩略图、RAG 和 UI 最终一致；失败时可重试、可对账、可恢复，不静默丢文件。
6. 保留当前 ownership、filesystem policy、destructive confirm、审计和不可信路径边界，不因同步能力扩大用户权限。

### 1.3 非目标

- 不把任意宿主机目录开放给用户或 Agent；目录必须由显式绑定、归属校验和同步配置产生。
- 不允许 Shell 绕过 filesystem policy 直接访问 OSS 凭据、数据库、Docker socket 或其他用户目录。
- 不把“物理磁盘永远是真源”作为所有场景的规则；DB 的归属、删除状态、回收站和权限仍由服务端事务控制。
- 不实现 OSS 文件到 Shell 的 materialize/cache、实时同步、双向回传或目录挂载。
- 不在第一版实现无冲突保证的多设备实时协作、任意目录的通用云盘同步或二进制差分合并。
- 不删除现有 Admin 对账、孤儿导入和幽灵报告；它们继续作为全量修复和故障恢复入口。

## 2. 功能需求

### FR-FS3-001：同步对象与绑定

同步对象必须明确记录用户、来源类型、目标 workspace、逻辑空间、同步模式和协议版本。支持的来源类型至少包括：`web`、`agent`、`shell` 和 `local_directory`。`oss` 是文件存储后端，不是 Shell 同步来源。

本地目录或 Shell workspace 只能绑定到当前用户拥有的项目/文件夹。绑定、解除绑定、目录不可用、权限变化和同步停用都必须经过服务端归属校验；不能根据文件名或目录名推断用户归属。

### FR-FS3-002：统一变更记录

每个发现或产生的文件变更都必须形成结构化变更记录，至少包含：`change_id`、`user_id`、`source`、`storage_key` 或相对路径、操作类型、文件指纹、观察时间、协议版本和处理状态。

文件内容、完整路径、用户输入、凭据和文件正文不能写入普通日志。可见日志只使用脱敏摘要或 fingerprint；原始失败信息进入受限诊断日志。

### FR-FS3-003：本地物理变更发现

LocalStorageBackend 下，服务端必须支持对绑定目录的增量发现和周期性全量校验：

- 新建普通文件创建或更新 `File` 元数据，并按目录层级解析或创建受控 `Folder` 元数据。
- 修改文件更新大小、mtime、mime、指纹和版本。
- 移动或重命名文件更新 `storage_key`、`display_name`、`folder_id`，不能产生重复 DB 行。
- 删除文件进入既定删除/回收站语义；外部删除不得绕过安全网直接误删其他引用。
- 软链接、硬链接、目录穿越、特殊文件和超出绑定根目录的路径必须拒绝或忽略，并留下脱敏诊断结果。

watcher 只负责产生候选变更，最终写入必须再次执行路径、ownership、类型、大小、配额和版本校验。watcher 丢事件时必须由 reconcile 水位或全量校验补偿。

### FR-FS3-004：Shell 命令边界同步

Shell 命令使用绑定 workspace 时，命令开始前记录同步基线，命令结束后执行一次受控 reconcile；长时间命令可按配置周期产生中间候选，但不能在命令执行期间无条件刷新 UI 或抢占文件锁。

命令失败、超时、取消或容器销毁后仍必须执行尽力而为的收尾同步；收尾失败进入可重试队列，不把“命令成功”伪装成“文件已同步”。同步结果需要区分 `synced`、`partial`、`conflict`、`rejected` 和 `failed`。

### FR-FS3-005：本地目录双向同步

本地目录同步支持以下模式：

- `mirror_in`：本地目录只作为外部输入，物理变化投影到文件库。
- `mirror_out`：文件库变更落到本地目录，本地目录不得反向写回。
- `bidirectional`：双方变化均可同步，必须启用版本、来源和冲突策略。

默认不得静默删除另一侧文件。同步删除必须能确认对应文件仍属于同一同步对象；无法确认时标记冲突并保留双方内容。首次绑定必须先生成 dry-run 报告，由用户选择导入、覆盖、跳过或冲突保留，不允许首次扫描直接批量覆盖。

### FR-FS3-006：OSS 模式独立沙盒

当 `storage.backend=oss` 时，Shell 只使用独立的用户 Shell 持久目录和临时构建目录：

- 不显示项目文件和个人文件入口；
- 不允许创建、切换或绑定 workspace；
- 不挂载 `/personal`、`/project` 或任何 OSS 对象；
- 不创建 OSS materialize/cache，不监听 OSS 对象变化，也不自动回传 Shell 产物；
- 文件库仍通过既有文件 API、文件工具和预签名上传路径访问。

若未来需要处理 OSS 文件，应另行设计一次性“显式下载 → 独立任务处理 → 显式上传产物”能力，不纳入本 PRD 的实时同步协议。

### FR-FS3-007：冲突与版本

同一文件在上次同步基线之后被两个来源修改时，系统必须检测冲突，而不是按到达顺序静默覆盖。冲突至少记录来源、基线指纹、双方当前指纹、发生时间和处理状态。

第一版只保证“保留双方 + 用户选择”，不自动合并二进制文件。文本自动合并必须单独验证格式、编码、大小和安全边界后再开放。冲突处理必须支持保留本地、保留云端、另存为副本和取消。

### FR-FS3-008：DB、UI 与下游事件

同步服务完成 DB 事务后发布统一 canonical 文件事件，事件至少支持新增、更新、移动、删除、冲突和同步状态变化。事件必须携带实体 ID、revision、来源和幂等 `event_id`，不携带文件正文和敏感路径。

`filesCache`、文件页面、ProjectModal、Dashboard FilePanel、RAG 索引、缩略图和配额账本分别按职责消费事件。UI 不直接监听宿主目录，也不通过轮询物理目录绕开后端。

### FR-FS3-009：对账与恢复

保留 Admin 全量对账，扩展为可查看同步对象、最近水位、待处理变更、冲突、幽灵和孤儿统计。修复操作必须逐项确认、幂等执行并复用现有 destructive confirm gate。

同步服务必须支持从 DB 变更记录和本地物理目录清单重建待处理队列。OSS 继续使用现有 Admin 对账和对象存储 API，不进入 Shell 文件同步队列。恢复流程不得用空扫描结果覆盖现有 DB，也不得在解析失败时把文件归入个人根目录。

## 3. 技术方案

### 3.1 事实源与事务边界

采用“来源变更 + DB 投影 + 物理对象动作”的分层模型：

```text
Web / Agent / Shell / Local directory / OSS
                    ↓
          Change detector + sync journal
                    ↓
       ownership / policy / version checks
                    ↓
        FileService + FolderTree DB transaction
                    ↓
       storage action / outbox / canonical event
                    ↓
          UI / RAG / thumbnail / quota
```

`File`、`Folder` 的归属、空间、回收站状态和同步 revision 由 DB 事务控制；Local/OSS 对象内容和元信息由 StorageBackend 承载。跨 DB 与物理存储不能假设原子提交，必须使用 journal、幂等键、重试和对账弥补窗口。

### 3.2 变更检测与队列

新增同步服务负责接收 watcher、Shell 收尾和 Web/Agent 写入产生的变更。Local watcher 应优先使用可用的文件系统事件接口；事件丢失、进程重启和目录批量变化通过 revision 水位与周期 reconcile 补偿。OSS 上传继续走现有 FileService/API，不接入本地 watcher。

队列处理必须按用户和同步对象限流，避免一个大目录阻塞所有用户。重复事件按 `source + normalized_relative_path + observed_fingerprint` 合并；处理过程不能依赖文件名作为唯一 ID。

### 3.3 本地目录与 path-mirror

本地 path-mirror 继续复用 `KeyStrategy` 和 `compose_logical_path`，同步服务只接收已解析的 workspace root 和相对路径，不自行拼接用户根目录。路径解析必须拒绝绝对路径、`..`、软链接逃逸、特殊文件和根目录外路径。

目录变化只能映射到用户已绑定的 workspace。目录名到 `Folder` 的解析必须逐级进行；无法唯一解析的目录进入冲突/人工处理，不自动创建跨空间或跨用户记录。

### 3.4 OSS 与 Shell 边界

OSS 继续由 `OSSStorageBackend` 提供文件库对象读写、预签名上传和 Admin 对账；它不参与 Shell workspace 解析。OSS 模式的 Shell policy 必须将 workspace、`/personal` 和 `/project` 解析为不可用，只返回独立 Shell 根目录。

不能通过创建空的本地目录来伪装 OSS 文件库已经挂载。OSS 文件库的读写继续经过文件 API/文件工具，Shell 产物不会因为位于独立沙盒而自动生成 `File` 记录或自动上传。

### 3.5 Shell、权限与安全

同步服务必须调用现有 `resolve_filesystem_policy`、workspace ownership 和 sandbox policy。同步发现能力不会扩大 Shell 的目录范围；危险删除、覆盖、批量移动和跨空间操作仍由业务确认门控制。

Shell 未授权、workspace 无效、同步配置停用或 sandbox 不可用时，不创建同步任务、不注入额外工具，也不尝试从物理目录猜测权限。同步失败消息经过 `redact()`，日志不记录正文、密钥和完整路径。

### 3.6 文件事件与下游一致性

同步服务复用现有 live publisher 和 `filesCache`，不新增第二套 SSE 或前端 watcher。事件发布顺序必须是：DB 事务提交 → 写入可靠 outbox/journal → 发布 canonical event；发布失败由 outbox 重试，不能回滚已提交的 DB 事务或伪造前端成功。

RAG、缩略图和配额是派生消费者。它们处理失败不回滚文件主事务，但必须保留待处理状态并由后台任务重试；文件正文不进入事件 payload。

### 3.7 文件树

```text
backend/
├── app/services/filesync/
│   ├── __init__.py                         【新增】统一同步服务入口
│   ├── protocol.py                          【新增】变更记录、幂等、路径和状态机
│   ├── reconcile.py                         【新增】候选发现、全量对账与 DB 投影
│   ├── bindings.py                           【新增】dry-run、镜像模式和冲突处理
│   ├── snapshots.py                          【新增】冲突远端快照的原子读写
│   └── outbox.py                              【新增】canonical 事件可靠投递与重试
├── app/services/storage/                    【修改】补充受控对象元信息/批量边界
├── app/services/files/                      【修改】复用 FileService 写入与删除事务
├── app/services/workspaces.py               【修改】绑定同步对象和 workspace 根目录
├── app/services/filesystem_authorization.py 【修改】同步动作复用 filesystem policy
├── app/api/v1/filesync.py                   【新增】用户状态、dry-run、冲突和恢复接口
├── app/api/v1/filesync_admin.py             【新增】Admin 状态、对账和冲突恢复接口
├── app/api/v1/config.py                     【修改】扩展 Admin 对账/恢复入口
├── agent/sandbox/                           【修改】Shell 命令前后同步钩子
├── agent/tools/shell.py                     【修改】传递同步对象和收尾状态
├── alembic/versions/                         【新增】同步对象、journal、冲突和 outbox 表迁移
├── tests/test_filesync_phase1.py             【新增】协议、本地投影、Shell 边界、冲突和 outbox 回归
├── tests/test_filesync_phase4_oss.py         【新增】OSS 边界、入口隐藏和无隐式文件同步回归
└── tests/test_filesync_phase5_admin.py       【新增】Admin 状态、脱敏、OSS 隔离和确认门回归

frontend/src/
├── api/filesync.ts                          【新增】Admin 同步状态、dry-run、冲突操作
├── stores/filesCache.ts                     【修改】消费 canonical 文件同步事件
├── stores/live.ts                            【修改】复用事件 envelope，不新增通道
├── components/filesync/                     【新增】Admin 冲突和同步状态组件
└── views/Admin/StorageAudit/index.vue       【修改】组合 Admin 同步状态和恢复入口

docs/
├── backend/storage.md                       【修改】补充同步协议与运行边界
├── prds/PRD-FS-3-文件事实源与双向同步.md   【新增】需求事实源
└── devlog/2026-09-06-filesync-phase5.md    【新增】Phase 5 实施、回滚和验证记录
```

`FileService` 仍是文件 DB 投影的业务边界，`StorageBackend` 只负责对象动作，`filesync` 负责检测、编排、journal 和冲突，不在 API、Shell 工具或前端页面复制同步逻辑。生成的 API 类型只能通过现有 OpenAPI 流程更新，不手工编辑。

Phase 5 的上线收口范围是 Admin 观测、对账/恢复确认、可靠 outbox、灰度开关、OSS 隔离和回滚边界；它不把现有配额/缩略图链路改造成第二套同步消费者，也不宣称 RAG 专用消费者已经完成。后续若接入 RAG，必须以 canonical 文件事件为唯一入口，并单独增加派生任务状态、重试和测试。

明确不应修改或复用为同步入口的内容：`backend/agent/memory/` 的 scope 文件、聊天暂存附件生命周期、LoopScope trace 存储、Docker 业务容器卷，以及前端页面自行读取宿主目录的逻辑。

## 4. 验证与上线

验证必须覆盖 LocalStorageBackend、OSSStorageBackend、Shell ephemeral 容器和现有文件 API，且使用临时目录、临时数据库和 mock OSS，不修改正式用户配置或数据。

- 本地发现：新建、覆盖、重命名、移动、删除、批量操作、空目录、嵌套目录、断电/进程重启和 watcher 丢事件后最终一致。
- Shell：命令成功、失败、超时、取消、容器销毁、配额超限和同步服务不可用时，状态不伪造成功，文件不越权。
- OSS：文件 API 的上传、读取、删除和对账不回归；Shell 不能看到或挂载 OSS 下的项目/个人文件，也不能绑定 workspace。
- 冲突：同一基线的双侧修改保留双方；删除与修改冲突不得静默丢数据；重复 journal 和重复事件不会产生重复 `File`。
- UI：File 页面、ProjectModal、Dashboard FilePanel 和其他在线标签页在收到事件后更新；断线重连后能通过 revision 补偿。
- 下游：RAG、缩略图、配额和回收站消费同步事件失败时可重试，且不阻塞文件主事务。

代码验证至少包括后端 pytest、ownership/confirm gate、compileall、前端 typecheck、前端测试和 build。具备 Docker 的环境还需运行 sandbox 安全回归；OSS 和本地目录真实 smoke 需在 devserver 执行。上线采用按同步模式和用户范围的 feature flag 灰度，默认不自动接管已有目录。

回滚时关闭同步 feature flag，停止新的 watcher worker，保留 journal、冲突记录和用户物理文件；不能通过删除 DB 记录或 `down -v` 回滚。恢复前先用 Admin 对账确认 DB、物理对象和 OSS 对象状态。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| watcher 丢事件或重复事件 | DB 与物理目录短暂不一致、重复写入 | journal 幂等键、revision 水位和周期全量 reconcile |
| Shell 命令大量生成文件 | 队列堆积、UI 事件风暴、配额超限 | 命令后批量扫描、按 workspace 合并事件、配额前后校验 |
| 外部删除与回收站语义冲突 | 用户误以为文件可恢复，或同步误删 | 删除先记录来源和基线，无法确认时转冲突，不静默物理删除 |
| OSS 文件被误挂载到 Shell | 越权、语义不一致或产生未登记副本 | OSS 模式统一拒绝 workspace、`/personal`、`/project`，只保留独立沙盒 |
| 目录重命名/项目改名 | 路径与 DB 归属错位 | 使用 ID 解析和 `KeyStrategy`，禁止名称猜测 |
| 大文件和二进制冲突 | 内存、带宽和存储成本上升 | 只传元信息/指纹进行检测，正文按受控流式传输，第一版不做二进制合并 |
| 多端同时修改 | 静默覆盖造成数据丢失 | 基线指纹 + revision 检测，冲突保留双方 |
| 同步能力扩大权限 | 跨用户或内部目录泄露 | 每次投影重新校验 ownership、policy、workspace root 和特殊文件边界 |

待确认事项：

1. 本地目录双向同步的首个支持范围是“绑定到文件库目录”，还是同时支持任意用户选择的外部目录；后者需要单独的桌面/sidecar 权限模型。
2. 首版是否只同步文件元数据和完整对象，文本三方合并是否延期到后续阶段。
3. 未来是否单独设计 OSS 一次性处理任务；该能力不属于本 PRD 的实时同步范围。

## 6. 唯一实施 TODO

### Phase 1：协议与安全基线

- [x] `FS3-001` 固化同步对象、journal、revision、幂等键、冲突状态和 feature flag；已完成迁移、临时数据库、重复变更幂等和默认关闭回归。实际 `File` 投影与冲突处理留在后续 Phase。
- [x] `FS3-002` 完成同步路径的 filesystem policy 基线、workspace ownership、路径边界和 OSS 模式独立沙盒拒绝规则；已覆盖未授权、越界、软链接、特殊文件和 OSS workspace 拒绝测试。

### Phase 2：本地文件与 Shell 同步

- [x] `FS3-003` 实现本地目录轮询候选发现、全量 reconcile 补偿和 File/Folder DB 投影；已覆盖新建、修改、移动/重命名、删除、空目录、软链接拒绝和重复扫描幂等。轮询器只产出候选，实际落库统一走 reconcile，丢事件可由下一次全量扫描补偿。
- [x] `FS3-004` 接入 workspace Shell 命令前基线与命令后收尾同步；命令执行前后均返回结构化同步状态，基线失败阻止执行，收尾失败不会伪造成同步成功。独立 Shell、OSS 和非 workspace 命令保持不进入文件库投影。
- [x] `FS3-005` 将 Shell/本地绑定完成后的变更在 commit 后发布为 canonical `files` refresh，复用 `filesCache`、Data Runtime 和现有文件版本查询；不把尚未独立接入的 RAG 派生处理伪装成同步成功。

### Phase 3：本地目录双向同步

- [x] `FS3-006` 实现首次绑定 dry-run、`mirror_in`、`mirror_out` 和受控 `bidirectional` 模式；首次绑定默认不落库，确认后才应用，绑定根限制在用户 local storage 内。
- [x] `FS3-007` 实现基线指纹、删除保护、冲突记录和用户选择处理；默认不静默删除 DB 行，双向基线同时变化会阻止该路径继续投影并提供冲突处理 API。

### Phase 4：OSS 模式边界收口

- [x] `FS3-008` 在 OSS 模式关闭 workspace 绑定和项目/个人目录挂载；已统一收口 workspace CRUD、会话/定时任务/终端绑定、`/workspace` 命令和工作区工具 Schema，前端隐藏工作区与完整用户沙箱授权入口，Shell 仅保留独立沙盒。
- [x] `FS3-009` 验证 OSS 文件 API、预签名上传和 Admin 对账与独立 Shell 共存；文件同步绑定、Shell `personal/project` 脚本和隐式 File 投影均在 OSS 下拒绝或不产生记录，既有 OSS 文件库链路保持独立。

### Phase 5：管理、观测与上线收口

- [x] `FS3-010` 扩展 Admin 同步状态、对账、冲突处理和恢复入口；状态只返回脱敏运行信息，绑定支持 dry-run/执行对账，冲突和现有孤儿导入/删除均逐项经过确认，原有存储对账入口保留。
- [x] `FS3-011` 接入 outbox 后台重试、`sandbox.file_sync_enabled` 灰度开关和可回滚文档；专项回归、完整 CI 门禁、OSS 隔离和确认门验证通过。devserver 真实目录/OSS smoke 仍按上线环境执行，不自动修改生产配置。
