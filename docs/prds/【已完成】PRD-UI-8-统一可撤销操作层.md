# PRD-UI-8：统一可撤销操作层

> 状态：Phase 0–4 已完成（文件库、项目、日历、思维画布、历史面板与保留期清理）
> 创建：2026-09-09
> 所属层：UI / Runtime / Domain Services
> 关联文档：[PRD-UI-2-统一实时事件更新.md](./【已完成】PRD-UI-2-统一实时事件更新.md)、[PRD-UI-7-本地交互与服务端同步一致性.md](./【已完成】PRD-UI-7-本地交互与服务端同步一致性.md)、[PRD-FS-4-顶层Workspace文件库空间.md](./PRD-FS-4-顶层Workspace文件库空间.md)、[文件存储架构方案.md](../refactor/【已完成】文件存储架构方案.md)
> 关联模块：backend/app/services/、backend/app/core/events.py、frontend/src/interaction/、frontend/src/stores/

---

## 1. 背景与目标

### 1.1 背景

项目、日历、文件库和思维画布都存在“刚刚误操作，希望撤回”的场景：

- 文件被误删、误移动、误重命名或覆盖；
- 项目字段被修改、归档或删除；
- 日历事件被修改或删除；
- 画布节点、便签、连线和位置被误改；
- 批量操作需要作为一个整体撤回，而不是逐条点击。

当前各领域有不同程度的版本和软删除能力，但没有统一的操作历史、逆操作协议和冲突处理。只在前端维护数组快照无法覆盖多标签页、刷新、IM、咕咕、定时任务和文件同步场景，也可能在资源已被其他来源修改后错误覆盖最新数据。

### 1.2 目标

1. 提供统一的服务端可撤销操作记录、逆操作和重做协议。
2. Web 页面支持 Ctrl+Z / Command+Z 撤回，支持 Ctrl+Shift+Z / Command+Shift+Z 重做。
3. 文件库、项目、日历、思维画布共享同一套操作栈、分组、权限和冲突规则。
4. 批量操作、拖拽操作和连续编辑可合并为一个用户可理解的操作。
5. 撤回前检查资源版本；资源已被其他来源修改时拒绝静默覆盖。
6. 撤回成功后复用 canonical event，让其他页面实时同步。
7. 保持 Shell、文件同步、定时任务和咕咕操作的来源边界，避免用户按 Ctrl+Z 误撤回后台操作。

### 1.3 核心结论

统一的是操作生命周期和撤回协议，不是把所有领域强行转换成同一种数据库快照。

    用户操作
       │
       ├─ 领域服务执行正向命令
       ├─ 领域适配器生成逆操作描述
       ├─ 业务事务与操作记录同事务提交
       └─ 提交后发布 canonical event

    Ctrl/Command+Z
       │
       ├─ UndoService 选择当前上下文最近可撤回操作
       ├─ 校验权限、版本和操作状态
       ├─ 调用领域适配器执行逆操作
       └─ 发布新的资源事件并标记原操作已撤回

---

## 2. 范围与非目标

### 2.1 本期范围

- 文件库：新建、删除、重命名、移动、编辑/覆盖的可撤回基础能力；
- 项目：新建、字段编辑、归档/取消归档、删除；
- 日历：新建、字段编辑、删除；
- 思维画布：节点/便签、画布项位置、画布项删除、连线创建/删除；
- 批量操作与拖拽等连续交互分组；
- Web 全局快捷键和撤回状态反馈；
- 服务端统一操作表、领域适配器和冲突检查；
- 复用现有 canonical event 与资源 revision 更新机制。

### 2.2 非目标

- 不通过恢复整库数据库快照实现撤回；
- 不自动把 Shell、文件同步、定时任务、咕咕或 IM 操作放入 Web 的 Ctrl+Z 栈；
- 不允许撤回绕过当前用户的所有权、权限或确认门；
- 不为外部 OSS 对象提供本地文件级回滚；
- 不把文本编辑器内部的每个字符都写成一条服务端操作；
- 不强制要求所有历史业务表增加同一种 deleted_at 或快照字段。

---

## 3. 设计原则

### 3.1 服务端为事实源

前端可以做乐观更新，但不能仅靠前端快照完成撤回。操作记录、版本检查和逆操作必须在服务端完成，保证刷新、换标签页和不同客户端行为一致。

### 3.2 领域负责语义，公共层负责流程

公共层负责：

- 选择操作；
- 操作分组；
- 状态流转；
- 权限和版本校验；
- 幂等与冲突返回；
- 事件发布；
- 保留期和清理。

领域适配器负责：

- 判断某个操作是否可撤回；
- 生成并验证逆操作参数；
- 执行领域级恢复、反向移动或字段还原；
- 返回撤回后资源状态。

公共层不得使用“把任意 JSON 写回任意表”的通用回滚逻辑，也不得执行序列化函数、SQL 或路径作为操作 payload。

### 3.3 严格冲突，不强制覆盖

每个操作保存完成时的资源版本或内容指纹。撤回时要求资源仍处于该操作产生的状态：

    当前版本 == 操作完成版本  → 允许撤回
    当前版本 != 操作完成版本  → 返回冲突，不覆盖当前修改

第一版不提供“强制撤回”按钮。用户需要先刷新并重新判断，避免撤回成为另一种危险覆盖入口。

### 3.4 外部变更不进入默认撤回栈

以下来源默认只写审计或同步日志，不进入当前 Web undo_context_id：

- Shell；
- 本地文件监听/同步 Worker；
- OSS 对账或后台修复；
- 定时任务；
- 咕咕 Agent；
- QQ、飞书、微信等 IM。

这样用户不会因为文件同步或咕咕刚刚创建文件，就在文件库页面按一次 Ctrl+Z 把后台结果撤回。后续如需支持 Agent 撤回，应提供显式 /undo 或操作卡片，并使用独立的 actor/context 策略。

---

## 4. 统一操作模型

### 4.1 操作记录

建议新增 undo_operations 表。它是可撤回操作索引和状态表，不替代各领域业务表，也不承担完整审计日志的所有用途。

| 字段 | 说明 |
|---|---|
| id | 不可猜测的操作 ID |
| user_id | 所有权主体 |
| undo_context_id | 浏览器标签页/交互上下文 ID，隔离不同页面的 Ctrl+Z 栈 |
| group_id | 一次批量操作、一次拖拽或一次编辑会话的分组 ID |
| resource | files、projects、calendar、mind |
| action | create、update、delete、move、append 等固定动作 |
| target_refs | 目标实体类型和 ID，不存可执行内容 |
| before_state | 逆操作所需的轻量业务字段快照 |
| after_state | 操作完成后的版本/关键字段摘要 |
| base_versions | 操作执行前的版本、哈希或存储指纹 |
| artifact_refs | 大文件内容、二进制版本或恢复对象的存储引用 |
| actor_type | web、agent、im、scheduled_task、sync、system |
| status | active、undone、conflicted、expired、failed |
| created_at | 操作完成时间 |
| undone_at | 实际撤回时间 |
| expires_at | 操作保留截止时间 |
| failure_code | 结构化失败原因，不写原始正文或密钥 |

before_state、after_state 和 base_versions 只允许领域适配器定义的字段。聊天正文、用户隐私、凭据和未脱敏异常不得写入操作记录。

### 4.2 操作生命周期

    active ──────> undone ──────> active
       │             │
       ├───────────> conflicted
       ├───────────> failed
       └───────────> expired

- 只有 active 操作可以进入撤回候选；
- 撤回成功后原操作变为 undone，并进入当前上下文的重做候选；
- 重做成功后原操作恢复为 active，并重新成为撤回候选；
- 冲突和失败都必须持久化原因，不能伪装成成功；
- 撤回请求使用操作 ID 幂等，重复请求返回已处理状态；
- 新的正向操作成功后，清空当前上下文中位于该操作之后的重做候选；
- 操作记录保留期结束后标记 expired，可由清理任务删除索引；
- 文件版本或恢复对象必须先于操作记录过期清理。

### 4.3 领域适配器协议

概念接口如下，具体 Python 类型和目录在实施阶段确定：

    class UndoAdapter(Protocol):
        resource: Literal["files", "projects", "calendar", "mind"]

        async def preview(self, operation, db, user_id) -> UndoPreview: ...
        async def undo(self, operation, db, user_id) -> UndoResult: ...

适配器必须：

1. 重新查询并校验目标归属；
2. 校验 base_versions 与当前版本；
3. 只执行该领域允许的逆操作；
4. 在同一数据库事务中更新领域数据和操作状态；
5. 对文件物理对象使用存储服务，不直接拼宿主机路径；
6. 返回资源 revision 和 canonical event 所需的最小 payload。

---

## 5. 各领域逆操作设计

| 领域 | 正向操作 | 逆操作 | 特殊约束 |
|---|---|---|---|
| 文件库 | 新建文件 | 软删并进入回收站 | 不立即物理删除，保留恢复窗口 |
| 文件库 | 删除文件 | 从回收站恢复 | 原位置不存在时返回冲突，不擅自改落点 |
| 文件库 | 重命名 | 恢复旧名称并移动物理 key | 目标名称冲突时拒绝覆盖 |
| 文件库 | 移动文件/文件夹 | 移回原空间、文件夹和物理路径 | 检查父目录、版本和循环引用 |
| 文件库 | 编辑/覆盖 | 恢复旧文件版本 | 大内容使用存储版本引用，不放进 DB JSON |
| 项目 | 新建 | 软删项目及关联可恢复数据 | 删除后的文件、阶段和关系必须可恢复 |
| 项目 | 更新/归档 | 恢复变更前字段 | 使用 Project.version 防止覆盖新编辑 |
| 项目 | 删除 | 恢复项目和关联资源 | 需要明确文件、阶段和提醒恢复范围 |
| 日历 | 新建 | 删除事件及其关联提醒 | 只删除本次创建的关联数据 |
| 日历 | 更新 | 恢复事件前字段 | 使用 CalendarEvent.version |
| 日历 | 删除 | 恢复事件 | ID、提醒关系和用户归属保持不变 |
| 画布 | 创建节点/便签 | 删除该节点或画布项 | 引用节点与画布项分开处理 |
| 画布 | 移动/缩放/置顶 | 恢复旧 x/y/w/h/z/data | 连续拖拽合并为一个 group |
| 画布 | 创建/删除连线 | 删除/恢复同一 relation | 校验端点和 canvas 归属 |
| 画布 | 删除画布 | 恢复画布、画布项和关系 | 需要完整关系快照或延迟硬删除 |

### 5.1 文件内容和物理存储

文件撤回不能只恢复 File 行：

- 删除：优先复用现有回收站/tombstone；
- 重命名和移动：记录逻辑空间、文件夹、旧 storage key 和新 storage key；
- 编辑和覆盖：保留旧内容版本或 Copy-on-Write 对象；
- 物理移动失败时，数据库事务不得宣称操作成功；
- 物理对象清理必须晚于操作保留期，并由存储服务统一执行；
- Shell/同步 Worker 产生的文件变化不自动创建 Web undo 记录。

文件操作仍必须复用 FileService、StorageBackend 和现有所有权/确认门，不得由 UndoService 绕过权限直接操作文件。

### 5.2 批量和连续操作

- group_id 表示用户感知的一次操作；
- 批量删除、批量移动、批量编辑一次撤回；
- 画布 pointer down 到 pointer up 期间合并；
- 文本编辑以 debounce 或明确保存点合并，不记录每个字符；
- 分组内任一实体发生冲突时，默认整个 group 原子失败，不做部分撤回；
- 预览必须展示受影响实体数量和冲突数量。

---

## 6. 操作栈与 API

### 6.1 栈选择

操作记录按用户和 undo_context_id 建立逻辑栈：

    undo_context_id = 浏览器实例 + 标签页交互上下文
    候选 = 当前用户 + 当前 context + actor_type=web + status=active
    取 created_at 最新的一组 group_id

路由切换不应清空栈；页面刷新后由服务端重新加载最近候选。不同标签页默认不互相消费对方的撤回栈，避免一个页面撤回另一个页面的刚刚操作。

### 6.2 API 草案

#### 获取最近可撤回操作

    GET /api/v1/undo/preview?context_id=ctx_xxx

返回：

    {
      "available": true,
      "operation_id": "op_xxx",
      "group_id": "group_xxx",
      "resource": "files",
      "action": "move",
      "summary": "移动 3 个文件",
      "created_at": "2026-09-09T12:00:00Z",
      "can_undo": true,
      "conflicts": []
    }

#### 撤回

    POST /api/v1/undo
    Content-Type: application/json

    {
      "operation_id": "op_xxx",
      "context_id": "ctx_xxx"
    }

成功返回领域资源的最新状态和事件 revision；失败返回结构化错误：

- undo.not_found：操作不存在或不属于当前用户；
- undo.already_processed：操作已经撤回/过期/失败；
- undo.conflict：资源已经发生后续变化；
- undo.permission_denied：当前权限不再允许恢复；
- undo.storage_unavailable：文件物理对象恢复失败。

第一版不暴露任意 before_state 写入 API，也不接受客户端自定义逆操作。

#### 重做

    POST /api/v1/redo
    Content-Type: application/json

    {
      "operation_id": "op_xxx",
      "context_id": "ctx_xxx"
    }

重做必须重新校验撤回后资源的版本和权限；资源在撤回后被其他来源修改时返回 undo.conflict，不覆盖当前状态。重做成功后发布普通 canonical resource event，并将操作状态恢复为 active。

### 6.3 事件和实时同步

撤回成功后发布普通 canonical resource event：

    {
      "type": "resource.changed",
      "resource": "files",
      "operation": "update",
      "entity_ids": [123, 124],
      "revision": 43,
      "origin": "undo:op_xxx"
    }

撤回事件不创建第二套前端刷新机制。当前标签页可以用 origin 更新本地状态，其他标签页、客户端和页面继续通过现有 live store 消费事件。

---

## 7. 前端交互

### 7.1 快捷键规则

新增公共 UndoManager / useUndo：

- Windows/Linux 监听 Ctrl+Z；macOS 监听 Command+Z；
- Windows/Linux 监听 Ctrl+Shift+Z；macOS 监听 Command+Shift+Z 进行重做；
- input、textarea、contenteditable 和编辑器内部不拦截；
- 输入法 composition 期间不拦截；
- 模态表单、确认弹窗和上传流程中不触发全局撤回；
- 无可撤回操作时不显示错误噪音；
- 撤回进行中禁用重复提交，服务端仍以操作 ID 幂等保护；
- 撤回成功后显示可重做状态；重做进行中同样禁用重复提交；
- 失败时显示“资源已变化，无法撤回”等可理解的状态，不暴露原始异常。

### 7.2 状态反馈

普通操作成功后更新“可撤回”状态；撤回成功后显示短时 AppToast，并通过 live event 更新所有受影响组件。

批量和高影响操作可以提供“撤回”按钮，但按钮必须复用同一 UndoManager，不在各页面复制一套回滚逻辑。

### 7.3 与编辑器快捷键的边界

文件文本编辑器、画布文本输入和浏览器原生输入拥有更近的撤回优先级：

    编辑器/输入控件内部撤回
            ↓ 无内部撤回可用
    页面级 UndoManager

页面级撤回不能破坏浏览器文本输入的正常行为。

---

## 8. 权限、安全与一致性

1. 撤回必须重新执行资源所有权检查，不能只相信操作创建时的 user_id。
2. 撤回必须重新执行领域权限、Workspace 范围和文件确认门检查。
3. 文件操作只保存逻辑路径和受控 artifact 引用，不保存宿主机绝对路径。
4. 原始异常、用户正文、附件内容、Token 和密钥不得写入可见日志或操作摘要。
5. 操作状态更新与领域数据更新必须在同一数据库事务中完成。
6. canonical event 必须在事务成功提交后发布；事件发布失败通过既有 revision 补偿机制恢复。
7. 文件物理操作不能产生“数据库已撤回、物理文件却被静默覆盖”的状态；失败必须返回明确错误并保留可重试记录。
8. 不允许通过撤回恢复已经属于其他用户、已被永久清理或已失效的实体。
9. 操作记录必须有数量/时间保留上限，避免连续编辑和大批量操作无限增长。

---

## 9. 分阶段实施

### Phase 0：协议和领域盘点

- [x] 确定 undo_operations 表和状态机。
- [x] 确定 undo_context_id 的生成、持久化和标签页隔离方式。
- [x] 盘点项目、日历、文件、画布所有写入口；Phase 1 仅接入 Web 文件写入口，其余领域按后续阶段接入。
- [x] 确定 actor 类型、批量 group 和外部同步排除规则。
- [x] 确定文件版本 artifact 的存储引用策略；清理任务在 Phase 4 统一实现。

### Phase 1：公共层与文件库

- [x] 实现 UndoService、操作注册表、版本冲突检查和幂等状态流转。
- [x] 接入 Web 文件新建、删除、重命名、移动和批量删除；Agent、Shell、同步和定时任务不进入 Web 栈。
- [x] 复用回收站实现删除撤回。
- [x] 为编辑/覆盖增加文件版本和 Copy-on-Write 恢复对象。
- [x] 实现 Web UndoManager 和快捷键边界：Ctrl/Command+Z 撤回，Ctrl/Command+Shift+Z 重做。
- [x] 覆盖操作上下文隔离、批量操作、版本冲突、文件夹树和正文 artifact 的回归测试；物理存储异常继续复用既有 FileService/Storage 测试。

### 9.1 Phase 0–1 落地清单

| 项目 | 当前实现 |
|---|---|
| 操作表 | `undo_operations`，由 Alembic `20260909000001` 创建；状态使用 `active/undone/conflicted/failed/expired` |
| 上下文 | 前端在 `sessionStorage` 生成每标签页 `UNDO_CONTEXT_ID`，写请求通过 `X-Undo-Context-ID` 传入；刷新不变，标签页隔离 |
| 操作边界 | Web 文件 REST 写入口记录操作；Agent、IM、Shell、文件同步、OSS 对账、定时任务不提供该 header，不污染 Web 栈 |
| 分组 | 每个 HTTP 写事务默认一个 `group_id`；批量删除作为一个操作记录，后续拖拽/连续编辑可在同一接口传入 group |
| 文件正文 | 正文不进入数据库 JSON；编辑/覆盖的前后版本存储在用户私有 `.undo/<operation_id>/` 引用下 |
| 冲突 | 撤回/重做前先完整预检 group 内所有对象版本；任一对象冲突则整组拒绝，不部分回滚 |
| 事件 | 成功撤回/重做后复用现有 `events.publish` 和 live event，未建立第二套刷新通道 |
| API | `GET /api/v1/undo/preview`、`POST /api/v1/undo`、`POST /api/v1/undo/redo` |

### 9.2 Phase 0–1 文件修改目录树

以下目录树只列本 PRD Phase 0–1 为撤回能力新增或修改的文件；同目录下与知识库、Shell、同步等其他事项相关的改动不属于本阶段。

```text
backend/
├── alembic/versions/
│   └── 20260909000001_add_undo_operations.py  # undo_operations 表和索引
├── app/
│   ├── api/v1/
│   │   ├── files.py                            # Web 文件写入口记录操作
│   │   ├── folders.py                          # Web 文件夹写入口记录操作
│   │   └── undo.py                             # 撤回/重做/预览 API
│   ├── models/__init__.py                      # UndoOperation ORM 模型
│   ├── services/
│   │   ├── files/selection.py                  # 删除时推进文件版本
│   │   ├── storage/file_service/files.py       # 文件更新时推进版本
│   │   └── undo/
│   │       ├── __init__.py                     # 公共服务导出
│   │       ├── files.py                         # 文件/文件夹逆操作和正文 artifact
│   │       └── service.py                       # 状态机、上下文、冲突和幂等
│   └── main.py                                 # 注册 undo 路由
└── tests/
    └── test_undo_files.py                      # 上下文、版本、正文和重做回归

frontend/
└── src/
    ├── App.vue                                 # 启停全局 UndoManager
    ├── i18n/locales/
    │   ├── en-US.ts                            # 撤回文案
    │   ├── ja-JP.ts                            # 撤回文案
    │   └── zh-CN.ts                            # 撤回文案
    ├── interaction/undo/
    │   ├── UndoManager.ts                      # 快捷键边界和调用编排
    │   └── UndoManager.test.ts                 # 快捷键回归
    └── services/api.ts                          # Undo Context 请求头和 API 客户端

docs/
└── prds/PRD-UI-8-统一可撤销操作层.md            # 协议、阶段状态和目录清单
```

### 9.3 Phase 2 项目与日历修改目录树

以下目录树只列 Phase 2 为项目/日历撤回能力新增或修改的文件；项目删除不再硬删除，
关联文件、文件夹、事件和提醒由领域适配器按同一操作记录恢复。

```text
backend/
├── alembic/versions/
│   └── 20260909000002_add_project_event_deleted_at.py  # 项目和日历事件软删除字段
├── app/
│   ├── api/v1/
│   │   ├── projects.py                                  # 项目正向操作、回收站和关联资源快照
│   │   ├── events.py                                    # 日历正向操作与提醒关系保留
│   │   ├── undo.py                                      # 多资源撤回事件广播
│   │   ├── folders.py                                   # 项目文件夹关联边界
│   │   ├── scheduled_tasks.py                           # 事件提醒关联边界
│   │   ├── search.py                                    # 全局搜索排除软删除资源
│   │   └── mind.py                                      # 引用候选排除软删除资源
│   ├── core/projects.py                                 # 项目更新排除已删除项目
│   ├── models/__init__.py                               # Project/CalendarEvent.deleted_at
│   ├── services/
│   │   ├── calendar.py                                  # 日历读取排除软删除事件
│   │   ├── projects.py                                  # 项目读取、计数和所有权边界
│   │   ├── overview.py                                  # 总览排除软删除项目/事件
│   │   ├── canvas/service.py                            # 画布引用排除软删除项目/事件
│   │   ├── files/browser.py                             # 文件库项目树排除软删除项目
│   │   └── undo/domains.py                              # 项目/日历领域逆操作适配器
└── tests/
    └── test_undo_domains.py                             # 项目/日历恢复、提醒和冲突回归
```

### Phase 2：项目与日历

- [x] 接入项目创建、字段编辑、归档和删除。
- [x] 将项目删除改为可恢复语义：项目、项目文件/文件夹、关联日历事件保留原 ID；关联提醒仅停用，撤回时原样恢复；项目回收站保留 30 天后自动清理。
- [x] 接入日历事件创建、编辑和删除；删除事件改为软删除并保留提醒关系。
- [x] 验证版本冲突、提醒关系和跨资源 live 更新；撤回/重做发布项目、文件、日历和提醒资源事件。

### Phase 3：思维画布

- [x] 接入全局节点、画布便签、画布项和关系的创建/删除。
- [x] 以一次画布拖拽/缩放/置顶请求作为单个 group，避免为一次连续手势拆出无意义的多条记录。
- [x] 处理全局节点与画布视图项分离后的逆操作顺序；恢复保持原主键，不重建关系端点。
- [x] 覆盖删除画布及其项/关系的整体恢复；画布、画布项和关系使用软删除保留恢复窗口。

### 9.4 Phase 3 思维画布修改目录树

以下目录树只列 Phase 3 为画布撤回能力新增或修改的文件。思维画布已有的 Agent 批处理和布局代码未因本阶段重复列出。

```text
backend/
├── alembic/versions/
│   └── 20260909000003_add_mind_undo_state.py  # 画布、画布项、关系软删除字段
├── app/
│   ├── api/v1/mind.py                          # 节点、画布、画布项和关系写入记录
│   ├── core/mind.py                            # 软删关系重新建立时复用原关系
│   ├── core/mind_canvas.py                     # 画布便签项软删除，保留原主键
│   ├── models/__init__.py                      # MindMap/MindCanvasItem/MindRelation.deleted_at
│   ├── services/canvas/service.py              # 画布树查询过滤与软删除
│   └── services/undo/
│       ├── mind.py                             # 思维画布快照、冲突检查和逆操作
│       └── service.py                          # 注册 mind 领域适配器
└── tests/
    └── test_undo_mind.py                       # 节点、项、关系、整图恢复和冲突回归

frontend/
└── src/services/api.ts                         # 统一撤回请求元数据，保留画布 group 扩展
```

### Phase 4：跨端增强

- [ ] 操作历史面板和更早操作的选择性撤回（暂不提供入口，后续按需实现）。
- [x] 增加 Ctrl+Shift+Z / Command+Shift+Z 重做，并验证撤回/重做栈清空规则（快捷键已在 Phase 1 实现，本阶段补齐历史与分支回归）。
- [x] 评估显式 /undo 是否需要支持咕咕/IM 操作：本期不接入 Web 撤回栈；后续若需要，使用独立 actor/context 和明确操作卡片。
- [x] 增加后台保留期清理、artifact 清理和审计统计。

#### 9.5 Phase 4 修改目录树

```text
backend/
├── app/main.py                         # 每小时接入撤回记录与正文 artifact 清理
├── app/api/v1/undo.py                   # 历史摘要与统计 API
├── app/services/undo/service.py         # 历史、统计、过期清理和过期保护
└── tests/test_undo_phase4.py            # 历史隔离、脱敏和 artifact 清理回归

frontend/
├── src/App.vue                          # 挂载全局历史面板
├── src/services/api.ts                   # 历史/统计 API 类型与请求
└── src/i18n/locales/                     # 中/英/日文案
```

---

## 10. 验收标准

### 公共层

- [x] 同一 Web 标签页按一次 Ctrl/Command+Z，只撤回该上下文最近一个完整 group。
- [x] 刷新页面后仍能看到最近可撤回操作。
- [x] 两个标签页不会互相消费对方的撤回栈。
- [x] 重复提交同一个 operation ID 不会重复执行逆操作。
- [x] 资源版本变化后撤回被拒绝，不覆盖新状态。
- [x] Ctrl+Shift+Z / Command+Shift+Z 能重做最近一次成功撤回的操作。
- [x] 重做前资源版本变化时被拒绝，不覆盖后续修改。
- [x] 撤回后产生新的正向操作时，旧的重做候选被清空。
- [x] 撤回成功后其他在线页面通过 canonical event 更新。

### 文件库

- [ ] 新建、删除、重命名、移动和批量操作均可撤回。
- [ ] 删除撤回不会绕过回收站和文件所有权检查。
- [ ] 编辑/覆盖撤回能够恢复旧内容，且不把大正文直接写入操作表。
- [ ] 物理存储失败时数据库和操作状态可解释、可重试。
- [ ] Shell、同步 Worker、OSS 对账和咕咕操作默认不污染 Web Ctrl+Z 栈。

### 项目、日历、画布

- [x] 项目字段和归档状态可撤回，删除恢复范围明确。
- [x] 日历事件及其提醒关系可撤回。
- [x] 画布节点、便签、连线、位置和删除操作可撤回。
- [x] 拖拽和批量操作不会生成大量无意义的操作记录。
- [x] 所有领域均使用同一公共 API、状态机、冲突错误和前端反馈组件。

### 测试与发布

- [x] 后端公共层单元测试、领域适配器测试和并发冲突测试。
- [ ] 文件物理存储/回收站/版本恢复测试。
- [x] 前端快捷键、输入框边界、批量撤回和 live event 回归。
- [x] Web 多标签页、刷新、权限变化和操作过期验收。
- [x] 不把撤回操作的正文、附件内容、凭据和宿主机路径写入可见日志。

---

## 11. 风险与取舍

| 风险 | 处理方式 |
|---|---|
| 各领域逆操作语义差异大 | 统一公共流程，领域适配器保留语义实现 |
| 文件内容版本占用存储 | Copy-on-Write、保留期和后台清理；先支持小文件与明确保存点 |
| 多来源操作顺序混乱 | 使用 undo_context_id、actor_type、version 和 canonical event |
| 撤回覆盖其他来源最新修改 | 严格版本检查，冲突时拒绝，不提供默认强制覆盖 |
| 前端快捷键破坏文本编辑 | 输入控件、IME、编辑器内部优先级规则 |
| 删除恢复范围不明确 | 第一版以操作 group 记录完整关联对象，预览展示影响范围 |
| 操作记录无限增长 | 数量上限、时间 TTL、artifact 与索引分阶段清理 |

最终目标不是让所有数据都拥有无限历史，而是让用户对最近一次明确业务操作拥有可靠、可解释且不会误伤新修改的撤回能力。
