# 统一实时事件更新 PRD

> 状态：🔲 待评估
> 创建：2026-08-26
> 最近更新：2026-08-26
> 所属层：UI / Runtime
> 关联模块：`backend/app/core/events.py`、`backend/app/api/v1/live.py`、`frontend/src/stores/live.ts`、`frontend/src/composables/useLiveRefresh.ts`
> 关联文档：[`PRD-LoopScope-0.2-Context-Usage-Provenance.md`](./【已完成】PRD-LoopScope-0.2-Context-Usage-Provenance.md)、[`PRD-SHELL-2-共享协作终端.md`](./PRD-SHELL-2-共享协作终端.md)

---

## 1. 背景与目标

### 1.1 背景

当前项目、日历、文件、画布、定时任务和聊天会话列表已经通过 `/api/v1/live/stream` 接收 Redis 事件，但事件大多只有资源名称。前端收到事件后再递增 `rev`，由页面或 store 重新请求完整列表。

这种方案可以工作，但存在几个问题：

- 事件语义不统一，调用方只能知道“某类数据变了”，不知道发生了什么操作以及影响了哪个实体。
- 多个页面收到同一事件后可能重复请求，批量操作时容易产生请求风暴。
- 事件没有稳定 ID、版本或游标，断线期间只能依赖重连后的错峰全量刷新。
- 文件已经有 `remove` 快路径，但其他资源仍主要依赖全量刷新，行为不一致。
- 终端输出目前是每个终端独立查询数据库后包装成 SSE，多个终端同时打开时成本较高。

同时，聊天生成流、Admin 日志流和文件下载流虽然也使用流式 HTTP，但它们的语义不同，不能简单合并为同一种资源事件。

### 1.2 目标

1. 建立统一、可扩展的业务实时事件协议。
2. 前端从“资源变更后全量刷新”为主，逐步升级为“事件驱动的本地状态更新”。
3. 通过事件版本、事件 ID 和重连补偿保证断线后最终一致。
4. 减少项目、日历、文件、画布、定时任务和会话列表的不必要请求与重渲染。
5. 保持聊天 token 流、日志 tail、文件下载流的独立生命周期和错误语义。
6. 让 Web、IM、Agent 工具和定时任务都能复用同一套业务事件发布机制。
7. 以实时事件层作为 TypeScript 后端迁移的低风险试点，先迁移协议、订阅和 BFF，不要求同步迁移业务写入与 Agent runner。

### 1.3 核心不变量

任何端成功提交会影响用户可见状态的变更，都必须发布 canonical event；任何在线页面或客户端都必须通过统一事件订阅收到该变更。

```text
Web API / QQ / 飞书 / 微信 / 定时任务 / Agent 工具
                         │
                 成功提交业务事务
                         │
                 canonical event
                         │
                  Redis 用户频道
                         │
              所有在线 Web 页面与客户端
```

因此，以下场景必须实时可见：

- 咕咕或 Web 修改项目、日历、文件、画布、定时任务后，其他已打开页面立即更新；
- QQ、飞书、微信或定时任务修改数据后，Web 页面立即更新；
- 其他 Web 标签页修改数据后，当前页面立即更新；
- Agent 工具产生的业务变更与普通 API 写入使用同一事件协议；
- 事件发送端不能因为来源不同而维护第二套刷新或广播逻辑。

---

## 2. 现状盘点

### 2.1 业务事件流

| 页面/领域 | 当前入口 | 当前消费方式 | 目标方向 |
|---|---|---|---|
| 项目 | `/live/stream` | `projects` 事件后刷新项目列表；部分自身操作用 `origin` 回声抑制 | 项目级 create/update/delete/move 增量 patch |
| 日历 | `/live/stream` | `calendar` 事件后重新加载当前月、下月和溢出事件 | 按事件操作更新对应事件，跨月事件再按 revision 校验 |
| 文件库 | `/live/stream` | 删除使用本地快路径，其他操作合并后全量刷新 | 文件/文件夹增量 patch，批量事件可携带 ID 集合 |
| 文件预览窗口 | `/live/stream` | 监听 `fileEvent` 后刷新当前文件 | 按文件版本或实体事件更新预览，必要时重新取内容 |
| 画布/笔记 | `/live/stream` | `mind` revision 变化后重新加载笔记 | 画布节点、关系和笔记按实体事件更新 |
| 定时任务 | `/live/stream` | `scheduled_tasks` 变化后重新加载列表 | 定时任务增删改直接更新列表 |
| 会话列表 | `/live/stream` | `sessions` 变化后刷新列表 | 会话元数据增量更新；消息追加使用 `session.appended` |

现有实现位置：

- 后端事件发布：`backend/app/core/events.py`
- 业务 SSE：`backend/app/api/v1/live.py`
- 前端统一连接与解析：`frontend/src/stores/live.ts`
- 通用 revision watcher：`frontend/src/composables/useLiveRefresh.ts`
- 文件细粒度消费：`frontend/src/stores/filesCache.ts`
- 会话消息增量消费：`frontend/src/components/common/gugu-chat/composables/useChatConversation.ts`

### 2.2 不属于业务事件更新的流

#### 聊天生成流

- `/api/v1/agent/chat`
- `/api/v1/agent/sessions/{session_id}/stream`
- Redis `genstream:{session_id}`

负责 token、工具调用、工具结果、文件、完成、错误、取消和断线续看。必须保留独立流，不改造成普通资源事件。

#### Admin 日志流

- `/api/v1/admin/debug/logs/stream`
- `frontend/src/views/Admin/Debug/index.vue`

负责日志文件 tail，当前每秒检查文件新增内容后推送。它需要日志 offset/序号和断线续接能力，但不应混入业务状态 store。

#### 终端输出流

- `/api/v1/terminals/{terminal_id}/events`
- `frontend/src/services/api.ts`

当前是单终端短生命周期 SSE，服务端循环查询终端事件表。后续可以迁移到统一事件总线，但终端输出事件仍应保持独立的终端过滤和顺序。

#### 文件内容流

- `/api/v1/files/{fid}/stream`

这是二进制下载流，不属于 SSE 或业务事件订阅。

---

## 3. 方案设计

### 3.1 统一业务事件模型

业务事件统一为以下结构，字段按需要可为空，但 `event_id`、`type`、`created_at` 必须存在：

```json
{
  "event_id": "evt-01J...",
  "type": "resource.changed",
  "resource": "files",
  "operation": "update",
  "entity_id": 123,
  "entity_ids": [123, 124],
  "revision": 42,
  "payload": {},
  "origin": "client-id",
  "created_at": "2026-08-26T12:00:00Z"
}
```

约束：

- `resource` 使用固定枚举：`projects`、`calendar`、`files`、`mind`、`scheduled_tasks`、`sessions`、`clients`、`im_channels`。
- `operation` 至少支持 `create`、`update`、`delete`、`move`、`append`、`refresh`。
- `revision` 是资源或用户级业务版本，不等同于数据库主键，也不等同于 Agent 的 context revision。
- `payload` 只允许放前端可用的业务字段，不放聊天正文、密钥或内部诊断信息。
- `origin` 继续用于本地乐观更新后的回声抑制。
- 批量变更优先使用 `entity_ids`，避免为每个实体发送一条大型事件。

### 3.2 后端发布层

将 `backend/app/core/events.py` 从“资源通知函数”逐步扩展为事件发布器：

1. 业务事务成功提交后再发布事件。
2. 同一次业务操作只发布一个语义明确的事件，避免先发粗粒度事件、再发重复刷新事件。
3. Agent、Web、IM、定时任务统一调用发布层。
4. 前端 UI 通知和 Agent snapshot `context_revision` 继续分离，不能因为是否刷新页面而决定是否失效 Agent snapshot。
5. 事件发布失败不回滚主业务事务，但必须保留 revision 校验或后续补偿路径。

### 3.3 前端消费层

`frontend/src/stores/live.ts` 负责三件事：

1. 建立、重连和关闭业务事件连接。
2. 解析并校验事件 envelope。
3. 将事件分发给领域 store，而不是继续让页面自行解释原始事件。

领域 store 按以下优先级处理：

```text
delete      -> 直接删除本地实体
create      -> 使用 payload 插入本地实体
update/move -> 使用 payload patch 本地实体
append      -> 追加消息或输出
payload 缺失/版本不连续 -> 合并防抖后重新拉取
```

事件更新不能替代首次加载。页面首次进入、事件版本不连续、权限变化或 payload 不完整时仍然允许全量请求。

### 3.4 断线与一致性

业务事件需要具备以下能力：

- SSE 使用 `Last-Event-ID` 或等价 cursor 进行续接。
- Redis pub/sub 只负责低延迟分发；不能把它单独当作可靠历史队列。
- 重连时以用户级/资源级 revision 与服务端状态比较。
- 发现事件缺口时只刷新受影响资源，不再默认刷新所有页面。
- 事件处理必须幂等，重复事件不能重复插入实体或消息。
- 前端事件处理失败时记录脱敏诊断信息，不把业务正文写入日志。

### 3.5 终端事件改造

终端事件作为第二阶段的独立领域接入：

- 事件带 `terminal_id`、`sequence`、`operation` 和输出增量。
- 用户页面可以订阅全部终端，再按当前终端过滤；不为每个终端创建一条数据库轮询连接。
- 终端删除后发送终止/删除事件，客户端清理本地状态。
- 断线后按 `sequence` 补拉缺失输出，不能依靠重新打开页面猜测状态。

### 3.6 TypeScript 迁移边界

实时事件层直接纳入 TypeScript 后端迁移，但采用“协议先行、生产者渐进迁移”的方式。最终目标不是只有 TypeScript API 自己发布事件，而是所有写入端都必须接入同一个 canonical publisher：

```text
Python 业务写入 / Agent / IM
              │
              └─ 发布统一 canonical event
                         │
                    Redis event bus
                         │
              TypeScript Live API / SSE
                         │
                    Vue 前端 stores
```

第一阶段由 TypeScript 接管：

- 事件 envelope、资源/操作枚举和共享类型；
- Redis 订阅、事件过滤、游标与重连补偿；
- `/live/stream` BFF/SSE 接口；
- 终端事件的订阅与序列化；
- 事件协议测试和前端消费契约。

暂不迁移：

- Python 业务 API 的数据库写入事务；
- Agent runner、工具 dispatch、IM 常驻 loop 和 scheduler；
- 聊天生成流 `genstream`；
- Admin 日志 tail 和文件二进制下载流。

Python 发布端在迁移期间通过 Redis 使用同一份事件协议。TypeScript 事件服务不得直接猜测数据库变化，也不得绕过业务事务自行生成资源事件。等所有生产者完成统一发布后，再评估是否迁移各领域 CRUD 写入。

---

## 4. 实施计划

### Phase 0：协议与事件盘点

- 统一资源、操作、事件 ID、revision、origin 的定义。
- 清点所有 `events.publish` 调用点，补齐遗漏资源。
- 为每个资源登记事件生产者和前端消费者。
- 交付：事件协议类型、生产/消费清单、事件命名约定。

### Phase 1：统一解析与兼容消费

- 新增前端业务事件 envelope 类型和运行时校验。
- `live.ts` 统一解析事件，兼容当前 `resources` 格式。
- 将 `useLiveRefresh` 改为事件分发层的兼容适配器。
- 保留现有 refetch 行为，确保本阶段不改变业务正确性。
- 交付：统一事件 parser、重连测试、旧事件兼容测试。

### Phase 1.5：TypeScript 事件服务试点

- 在目标 TypeScript 后端目录建立 event contract、Redis consumer 和 Live SSE handler。
- 与 Python 发布端共用 canonical event JSON，不引入双重事件语义。
- 保留 Python `/live/stream` 回退入口，完成灰度切换和可观测性对比。
- 验证认证、用户隔离、断线重连、事件过滤、错误处理和优雅退出。
- 交付：TypeScript Live API、共享事件类型、迁移说明和回退开关。

### Phase 2：项目、日历、定时任务增量更新

- 后端补充实体 ID、操作类型和必要 payload。
- 项目、日历、定时任务 store 直接 patch 本地状态。
- 批量修改使用 `entity_ids` 和单次刷新调度。
- 交付：三类资源不依赖全量列表刷新即可完成常见增删改。

### Phase 3：文件与画布增量更新

- 将文件现有 `remove` 快路径扩展为完整 create/update/move 事件。
- 文件预览按文件版本处理内容刷新。
- 画布节点、关系、笔记按实体事件更新。
- 交付：文件和画布的事件更新、跨标签页回声抑制和一致性测试。

### Phase 4：会话与终端事件统一

- 会话列表元数据使用增量事件；消息继续使用 `session.appended`。
- 终端输出从单终端数据库轮询包装 SSE 迁移为统一终端事件订阅。
- 增加 sequence/cursor 补偿和删除后的本地清理。
- 交付：多会话、多终端并发订阅测试。

### Phase 5：可靠性与性能收尾

- 增加事件缺口、重复、乱序和重连测试。
- 统计事件命中增量更新与回退 refetch 的比例。
- 清理页面层重复 watcher、重复 refresh 和旧 `resources` 分支。
- 完成协议文档、后端 overview 和前端开发约定更新。

TypeScript 事件服务稳定后，再按独立 PR 迁移项目、文件、日历等业务生产者；每迁移一个生产者都必须保持事件协议不变，并通过对应领域的功能与回归测试。

在所有生产者迁移完成前，旧 Python API、Agent、IM 和 scheduler 仍然可以发布事件，但必须调用同一个 canonical publisher，不能各自定义事件字段或直接操作前端刷新信号。每个生产者完成迁移后，都要验证“本端写入 → 其他在线端收到并更新”的跨端链路。

### 3.7 目标文件架构

实时事件迁移完成后的目录以 `backend/ts` 为 TypeScript 事件服务边界，保留 Python 业务模块作为事件生产者的过渡实现。目标结构如下：

```text
backend/
├─ app/
│  ├─ core/events.py                 # 过渡期 Python canonical publisher 适配层
│  └─ api/v1/
│     └─ live.py                     # 过渡期 Python SSE 入口，最终下线
├─ agent/
│  ├─ runner.py                      # 过渡期 Agent 业务生产者
│  ├─ im/                            # 过渡期 IM 业务生产者
│  └─ llm/genstream.py               # 独立的聊天生成流，不迁入业务事件流
└─ ts/
   ├─ package.json
   ├─ tsconfig.json
   ├─ packages/
   │  ├─ contracts/
   │  │  └─ src/
   │  │     ├─ protocol.ts           # EventEnvelope、Resource、Operation、cursor
   │  │     └─ index.ts
   │  └─ events/
   │     └─ src/
   │        ├─ publisher.ts           # 唯一 canonical publisher
   │        ├─ subscriber.ts          # Redis 订阅、过滤、去重、补偿
   │        ├─ cursor.ts              # event_id/sequence/revision 游标
   │        └─ resources.ts           # 资源事件注册表
   ├─ apps/
   │  └─ live-api/
   │     └─ src/
   │        ├─ server.ts              # Live API/BFF 启动入口
   │        ├─ auth.ts                # 用户认证与归属校验
   │        └─ routes/live.ts         # /live/stream SSE 入口
   ├─ workers/
   │  └─ terminal-events/
   │     └─ src/
   │        ├─ index.ts               # 终端事件消费/分发
   │        └─ protocol.ts             # terminal_id/sequence/output 事件
   └─ tests/
      ├─ protocol.test.ts
      ├─ reconnect.test.ts
      └─ cross-client.test.ts

frontend/src/
├─ stores/live.ts                     # 统一连接、解析、分发和重连
├─ composables/useLiveRefresh.ts      # 过渡期兼容刷新适配器，最终删除
├─ stores/eventHandlers/              # 各领域增量 patch handler
│  ├─ projects.ts
│  ├─ calendar.ts
│  ├─ files.ts
│  ├─ mind.ts
│  ├─ scheduledTasks.ts
│  └─ sessions.ts
└─ types/live-events.ts                # 前端事件协议类型
```

#### 新增文件

- `backend/ts/packages/contracts/src/protocol.ts`
- `backend/ts/packages/events/src/publisher.ts`
- `backend/ts/packages/events/src/subscriber.ts`
- `backend/ts/packages/events/src/cursor.ts`
- `backend/ts/packages/events/src/resources.ts`
- `backend/ts/apps/live-api/src/server.ts`
- `backend/ts/apps/live-api/src/auth.ts`
- `backend/ts/apps/live-api/src/routes/live.ts`
- `backend/ts/workers/terminal-events/src/index.ts`
- `backend/ts/workers/terminal-events/src/protocol.ts`
- `backend/ts/tests/protocol.test.ts`
- `backend/ts/tests/reconnect.test.ts`
- `backend/ts/tests/cross-client.test.ts`
- `frontend/src/types/live-events.ts`
- `frontend/src/stores/eventHandlers/projects.ts`
- `frontend/src/stores/eventHandlers/calendar.ts`
- `frontend/src/stores/eventHandlers/files.ts`
- `frontend/src/stores/eventHandlers/mind.ts`
- `frontend/src/stores/eventHandlers/scheduledTasks.ts`
- `frontend/src/stores/eventHandlers/sessions.ts`

#### 修改文件

- `backend/app/core/events.py`：保留为过渡生产者适配层，改为严格输出 canonical event envelope；不得继续新增旧格式事件。
- `backend/app/api/v1/live.py`：过渡期间代理到 TypeScript Live API，或保留为可回退入口。
- `backend/agent/runner.py`、`backend/agent/im/**`、`backend/app/scheduled_tasks.py`：业务提交成功后调用统一 publisher。
- `backend/app/api/v1/projects.py`、`events.py`、`files.py`、`folders.py`、`trash.py`、`user_bots.py` 及其他写入 API：统一接入 canonical publisher。
- `backend/app/api/v1/terminals.py`：改为发布终端状态/输出事件，不再依赖每个终端各自轮询。
- `frontend/src/stores/live.ts`：从 `resources/rev` 兼容模式升级为 envelope 分发。
- `frontend/src/composables/useLiveRefresh.ts`：暂时保留为 refetch 回退层，最终由领域 handler 替代。
- `frontend/src/stores/filesCache.ts`、`projects.ts`、`mind.ts` 以及日历、任务、会话相关消费模块：增加事件 patch 和 revision 缺口回退。

#### 最终删除或退出职责的文件

这些文件不能在迁移初期直接删除，必须在所有生产者切换并完成回归后处理：

- `backend/app/api/v1/live.py`：删除 Python `/live/stream` 旧入口，由 TypeScript Live API 接管。
- `frontend/src/composables/useLiveRefresh.ts`：删除资源 `rev` watcher 兼容层，页面改为直接使用事件 handler。
- `backend/app/core/events.py` 中旧的 `resources/fileOp` 拼装分支：删除旧 envelope 逻辑，保留必要的 Python publisher 调用适配，直到最后一个 Python 生产者迁移完成。
- `backend/app/api/v1/terminals.py` 中按终端循环查询并包装 SSE 的实现：删除该实现，保留终端 CRUD 和权限接口。

以下文件明确不删除：

- `backend/agent/llm/genstream.py`：聊天生成流仍需独立存在。
- `backend/app/api/v1/admin_debug.py`：日志 tail 是独立诊断流。
- `backend/app/api/v1/files.py` 的文件二进制 stream：不是事件订阅。

迁移过程中不得删除 `backend/config.override.json`、`.env`、数据库运行数据或任何用户存储目录；这些不属于代码架构清理范围。

---

## 5. 非目标

- 不把聊天 token 流改成资源事件。
- 不把 Admin 日志 tail 和业务数据事件混用。
- 不把二进制文件下载改成 SSE。
- 不要求一次性删除所有全量 API；全量 API 仍用于首次加载、权限变化和事件缺口恢复。
- 不用前端事件推断 Agent snapshot 是否需要刷新；snapshot freshness 继续由后端 context revision 管理。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 事件丢失 | 页面状态过期 | revision 校验、重连补偿和资源级回退刷新 |
| 事件重复或乱序 | 重复实体、顺序错误 | event ID 去重、sequence/revision 校验、处理幂等 |
| payload 不完整 | 本地 patch 产生脏数据 | payload 不足时回退到受影响资源的 refetch |
| 多页面重复消费 | 请求和渲染增加 | 统一 live store 分发、资源级防抖 |
| 业务提交前发布事件 | 页面读到未提交数据 | 所有发布点放在事务成功提交之后 |
| Redis pub/sub 不可靠 | 断线期间漏事件 | 不依赖 pub/sub 作为历史队列，以 revision 做最终一致性校验 |
| 聊天流与业务事件混用 | 取消、续看和顺序语义损坏 | 保持 chat/genstream 独立通道 |
| Python 与 TypeScript 双写事件 | 同一变更重复通知或顺序不一致 | 迁移期间只允许一个 canonical publisher，TypeScript 先接收再逐个迁移生产者 |
| 事件服务先于生产者迁移 | 收不到完整事件或出现旧格式 | 保留旧入口回退，先做 envelope 兼容解析并逐项切换生产者 |

---

## 7. 成功指标

| 指标 | 当前值 | 目标值 |
|---|---:|---:|
| 业务资源事件格式 | `resources` 粗粒度为主 | 100% 使用统一 envelope |
| 常见单实体更新的全量 refetch | 项目、日历、任务多为全量刷新 | 项目/日历/任务/文件常见操作为 0 次全量刷新 |
| 断线后的数据一致性 | 依赖重连错峰补刷 | 通过 revision/cursor 可验证最终一致 |
| 业务事件重复处理 | 各 store 分散处理 | 统一 event ID 幂等处理 |
| 聊天生成流独立性 | 独立 | 保持独立 |
| 终端订阅连接数 | 每个终端独立连接 | 每个用户/页面按需共享订阅 |

---

## 8. 验收标准

1. Web 页面只需订阅统一 live store，不直接解析后端原始事件。
2. 项目、日历、文件、画布、定时任务和会话事件均包含资源、操作和实体定位信息。
3. 常见单实体增删改可以直接更新本地 store；payload 不足时能回退刷新。
4. 重连、重复、乱序和事件缺口不会造成重复数据或永久 stale。
5. `origin` 回声抑制继续有效，跨标签页和 IM/Agent 变更能够同步。
6. 聊天生成、Admin 日志、终端输出和文件下载的流式语义没有被破坏。
7. 终端删除、停止、重启后的状态能通过事件正确同步。
8. 相关自动化测试覆盖后端发布、前端解析、增量 patch、回退刷新和重连补偿。
9. TypeScript 事件服务可以在 Python 生产者仍运行时独立工作，并具备明确回退路径。
10. Web、QQ、飞书、微信、定时任务和 Agent 工具任一端成功变更数据后，其他在线端都能通过统一事件订阅实时看到结果。

---

## 9. 相关资源

- [`backend/app/core/events.py`](../../backend/app/core/events.py)
- [`backend/app/api/v1/live.py`](../../backend/app/api/v1/live.py)
- [`frontend/src/stores/live.ts`](../../frontend/src/stores/live.ts)
- [`frontend/src/composables/useLiveRefresh.ts`](../../frontend/src/composables/useLiveRefresh.ts)
- [`frontend/src/stores/filesCache.ts`](../../frontend/src/stores/filesCache.ts)
- [`frontend/src/components/common/gugu-chat/composables/useChatConversation.ts`](../../frontend/src/components/common/gugu-chat/composables/useChatConversation.ts)
