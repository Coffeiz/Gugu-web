# 统一实时事件更新 PRD

> 状态：✅ 已完成；当前后端继续由 Python/FastAPI 负责，业务事件统一使用 canonical envelope，断线通过资源级补偿刷新恢复一致性
> 创建：2026-08-26
> 最近更新：2026-08-26
> 所属层：UI / Runtime
> 关联模块：`backend/app/core/events.py`、`backend/app/api/v1/live.py`、`frontend/src/stores/live.ts`
> 关联文档：[`PRD-LoopScope-0.2-Context-Usage-Provenance.md`](./【已完成】PRD-LoopScope-0.2-Context-Usage-Provenance.md)、[`PRD-SHELL-2-共享协作终端.md`](./PRD-SHELL-2-共享协作终端.md)

---

## 1. 背景与目标

### 1.1 背景

当前项目、日历、文件、画布、定时任务和聊天会话列表通过 FastAPI `/api/v1/live/stream` 接收 Redis 事件；事件统一使用 canonical envelope。前端收到事件后按资源事件局部更新，无法安全 patch 时再按领域刷新。

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
7. 事件层继续以 Python/FastAPI 为唯一服务 owner，不再把实时事件作为 TypeScript 后端迁移试点。
8. 遵循已归档的 [`PRD-ARCH-1-TypeScript后端迁移.md`](./【已归档】PRD-ARCH-1-TypeScript后端迁移.md) 所确定的 Vue + Vite、Python/FastAPI、Python Worker、PostgreSQL + Redis 分层；TypeScript 仅保留独立 RAG 辅助模块。
9. 明确咕咕终端采用“结构化终端事件”定位：以命令、标准输出、错误输出、退出码、状态和时间为实时事件单元，而不是默认实现传统 PTY 终端模拟器。

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
| 文件预览窗口 | `/live/stream` | 监听 canonical `resourceEvent`（resource=files） | 按文件版本或实体事件更新预览，必要时重新取内容 |
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

终端的产品边界如下：

- 当前终端是“受控 Shell 会话 + 可重放事件日志”，不是 xterm.js 一类的完整终端模拟器；
- 每条命令及其 stdout、stderr、退出码、状态和发生时间作为结构化事件持久化并实时推送；
- 终端列表、工作区/会话/Run 关联、权限状态和事件输出属于同一终端领域，但不混入聊天生成流；
- 不要求当前版本支持光标控制、ANSI 全量渲染、交互式 `vim`/`top`/`less` 或持续输入型程序；
- 如果未来需要完整交互式终端，应新增 PTY + 终端模拟器模式，不能改变结构化终端事件的既有协议。

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

- `resource` 使用固定枚举：`projects`、`calendar`、`files`、`mind`、`scheduled_tasks`、`sessions`、`clients`、`im_channels`、`terminals`。
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
- 终端 UI 继续使用命令/结果事件渲染，不将结构化事件强行拼接成单一原始代码文本；命令、stdout、stderr 和状态在展示层保持可区分。
- 终端事件协议应保留未来映射到 PTY 的扩展空间，但本阶段不引入 PTY 进程生命周期和字符级输入协议。

### 3.6 实时事件 owner 边界

实时事件层保留 canonical 协议，但服务 owner 收口到 Python/FastAPI；所有写入端都必须接入同一个 canonical publisher：

```text
Python 业务写入 / Agent / IM
              │
              └─ 发布统一 canonical event
                         │
                    Redis event bus
                         │
                 FastAPI / SSE
                         │
                    Vue 前端 stores
```

FastAPI 负责接管：

- 事件 envelope、资源/操作枚举和前端消费类型；
- Redis 发布、订阅、事件过滤和重连补偿；
- `/api/v1/live/stream` FastAPI/SSE 接口（浏览器同源连接，不经过独立 TS 服务）；
- 终端事件的订阅与序列化；
- 事件协议测试和前端消费契约。

暂不迁移：

- Python 业务 API 的数据库写入事务；
- Agent runner、工具 dispatch、IM 常驻 loop 和 scheduler；
- 聊天生成流 `genstream`；
- Admin 日志 tail 和文件二进制下载流。

Python 发布端通过 Redis 使用同一份事件协议。Live 服务不得直接猜测数据库变化，也不得绕过业务事务自行生成资源事件。

---

## 4. 实施计划

### Phase 0：协议与事件盘点 ✅

- [x] 统一资源、操作、事件 ID、revision、origin 的定义。
- [x] 清点所有 `events.publish`/事件总线调用点，并标注当前仍需迁移的旧格式生产者。
- [x] 为每个资源登记事件生产者和前端消费者。
- [x] 交付事件协议类型、生产/消费清单和事件命名约定。

Phase 0 交付物：

- Python 实时事件校验：`backend/app/api/v1/live.py`
- 契约导出入口：`backend/ts/packages/contracts/src/index.ts`
- 契约测试：`backend/ts/packages/contracts/test/live-events.test.ts`
- 现有生产者和消费者清单：本文第 2 节及第 3.7 节

现阶段明确的生产者包括：`backend/app/api/v1/projects.py`、`events.py`、`files.py`、`folders.py`、`trash.py`、`user_bots.py`、`backend/agent/runner.py`、`backend/agent/im/loop.py`、`backend/app/scheduled_tasks.py`、`backend/app/api/v1/mind.py`、`backend/app/core/events.py`。业务写入仍由 Python 承担，但统一发布 canonical envelope；SSE 入口由 FastAPI 提供。业务消费者是 `frontend/src/stores/live.ts` 及其下游 store；聊天生成、日志和文件下载保持独立流。

### Phase 1：统一解析与兼容消费 ✅

- [x] 新增前端业务事件 envelope 类型和运行时校验。
- [x] `live.ts` 统一解析 canonical envelope；必要的领域 refetch 仅作为 payload 不完整时的安全回退。
- [x] 将 `useLiveRefresh` 保留为事件分发层的兼容适配器。
- [x] 保留必要的领域 refetch 行为，确保本阶段不改变业务正确性。
- [x] 交付统一事件 parser；沿用现有重连补刷与旧事件兼容路径，并完成 canonical 契约测试。

Phase 1 交付物：

- 前端事件类型与校验：`frontend/src/types/live-events.ts`
- 统一事件解析：`frontend/src/stores/live.ts`
- Python 实时事件校验：`backend/app/api/v1/live.py`
- Python 实时流测试：`backend/tests/test_live_stream.py`

### Phase 1.5：实时事件服务试点 ✅

- [x] 建立 canonical event contract、Redis consumer 和 Live SSE handler。
- [x] 与 Python 发布端共用 canonical event JSON，不引入双重事件语义。
- [x] FastAPI 入口统一接管浏览器订阅；不再保留 TypeScript Live 独立服务或 Python 代理层。
- [x] 验证 JWT 认证、用户频道隔离、事件过滤、keepalive、错误处理和连接清理。
- [x] 交付 FastAPI 实时接口、前端事件类型和连接清理测试。

Phase 1.5 交付物：

- FastAPI Live API：`backend/app/api/v1/live.py`
- Live API 鉴权/频道测试：`backend/tests/test_live_stream.py`
- 运行边界说明：`backend/ts/README.md`

### Phase 2：项目、日历、定时任务增量更新 ✅

- [x] 后端补充实体 ID、操作类型和必要 payload。
- [x] 项目、日历、定时任务 store 直接 patch 本地状态。
- [x] 批量修改保留 `entity_ids`，并在 payload 不完整时回退刷新。
- [x] 交付三类资源不依赖全量列表刷新即可完成常见增删改。

Phase 2 交付物：

- 事件发布：`backend/app/core/events.py`
- 项目生产者：`backend/app/api/v1/projects.py`
- 日历生产者：`backend/app/api/v1/events.py`
- 定时任务生产者：`backend/app/api/v1/scheduled_tasks.py`
- 项目增量消费：`frontend/src/stores/projects.ts`
- 日历增量消费：`frontend/src/views/Calendar/composables/useCalendarData.ts`、`frontend/src/views/Calendar/index.vue`
- 定时任务增量消费：`frontend/src/views/Schedules/composables/useScheduledTasks.ts`

### Phase 3：文件与画布增量更新 ✅

- [x] 将文件现有 `remove` 快路径扩展为完整 create/update/move 事件，文件和文件夹 payload 使用稳定的 `kind + entity` 结构。
- [x] 文件预览继续按文件事件/版本刷新；事件 payload 缺失时回退到合并刷新。
- [x] 笔记、画布、画布项、画布便签和关系的后端写入路径统一发布 create/update/delete canonical 事件，且只在事务提交后发布。
- [x] 前端画布笔记与画布实体已支持按 `kind + entity` 事件更新，无法本地 patch 时回退加载。
- [x] 保留 `origin` 回声抑制，并对跨标签页事件做幂等本地 patch。
- [x] 交付文件、文件夹、笔记和画布完整的事件生产/消费链路。

### Phase 4：会话与终端事件统一 ✅

- [x] 会话标题和消息追加写入 canonical `sessions` 事件 payload；前端统一解析后增量更新当前会话与会话列表。
- [x] 保留 `session.appended` 旧字段作为迁移期兼容，同时 canonical payload 成为新消费者入口。
- [x] 终端创建、输出、停止、删除、重启和重命名发布 `terminals` 事件；页面按终端过滤并增量追加输出。
- [x] 终端输出继续使用 sequence 接口补偿断线期间的缺口，统一事件用于低延迟通知和状态同步。
- [x] 删除事件清理本地终端；事件 payload 不完整时保留现有刷新/重连路径。
- [x] 交付会话与终端的统一订阅、增量消费和断线补偿链路。

### Phase 5：可靠性与性能收尾 ✅

- [x] canonical 事件在前端按 `event_id` 去重，并按资源 revision 忽略旧事件；发现 revision 缺口时触发资源级补刷。
- [x] 终端按 sequence 补偿，文件/画布/会话 payload 缺失时按领域回退刷新，重连继续使用错峰补偿。
- [x] 完成笔记/画布所有后端写入路径的 canonical 事件生产，并补齐事件生产边界回归测试。
- [x] 旧 `resources/fileOp` 与 Python Live 入口已移除；所有生产者和前端消费者统一使用 canonical envelope，`rev` 仅作为前端本地刷新计数。
- [x] FastAPI Live 服务、统一路由和运行说明已接入，协议契约与关键领域测试通过；浏览器已同源连接 FastAPI Live。
- [x] 完成协议文档、后端 overview 和前端事件消费说明的同步，并删除与 TypeScript 后端迁移相关的现行目标描述。

收尾结果：

- [x] 断线补偿采用“重连后资源级错峰 refetch”方案。它不依赖短生命周期 SSE 重放，直接以服务端资源状态校正本地状态；终端另有 sequence 补偿。该方案是本 PRD 约定的明确持久化状态补偿方案。
- [x] QQ、飞书、微信连接状态变更发布 `im_channels` canonical event；连接设置 API 与连接回收路径共用 `bump_context_revision`/事件发布边界。
- [x] 领域事件 handler 是增量更新入口；`useLiveRefresh` 仅保留为旧页面兼容适配器，不再新增调用点，现有调用与 canonical revision 共用同一补偿语义。
- [x] revision 改为 `live-revision:{user_id}:{resource}` 资源级计数，前端 `lastCanonicalRevision` 的比较边界与后端契约一致。
- [x] 已补充 Live SSE、资源 revision、RAG/Agent 写入后事件消费的回归测试；跨 Web/IM/Agent 的生产者均经过同一 canonical publisher。

Python 业务 API、Agent、IM 和 scheduler 作为数据库写入侧的事件生产者，必须调用同一个 canonical publisher；Live 路由不承担数据库写入职责，也不能各自定义事件字段或直接操作前端刷新信号。每个生产者都要验证“本端写入 → 其他在线端收到并更新”的跨端链路。

### 3.7 当前文件架构

实时事件当前以 `backend/app/api/v1/live.py` 为 HTTP/SSE owner，业务生产者继续位于 Python API、Agent、IM 和 scheduler；`backend/ts` 只保留 RAG worker 和相关构建制品。当前结构如下：

```text
backend/
├─ app/
│  ├─ core/events.py                 # Python 业务写入侧的 canonical publisher
│  └─ api/v1/                        # Python 业务 API；不包含 Live SSE 代理
├─ agent/
│  ├─ runner.py                      # 过渡期 Agent 业务生产者
│  ├─ im/                            # 过渡期 IM 业务生产者
│  └─ llm/genstream.py               # 独立的聊天生成流，不迁入业务事件流
└─ ts/
   ├─ packages/contracts/             # 独立模块需要的共享协议
   └─ workers/rag/                    # RAG tokenizer/BM25/index worker

frontend/src/
├─ stores/live.ts                     # 统一连接、解析、分发和重连
├─ composables/useLiveRefresh.ts      # 当前保留的 refetch 兼容适配器
├─ stores/projects.ts                  # 项目事件 patch
├─ stores/filesCache.ts                # 文件事件 patch
├─ stores/mind.ts                      # 画布/笔记事件 patch
├─ views/Calendar/                      # 日历事件 patch
├─ views/Schedules/                     # 定时任务事件 patch
├─ views/Terminals/                    # 终端事件与 sequence 补偿
└─ types/live-events.ts                # canonical 事件类型与校验

```

#### 历史迁移草案（已废止）

以下旧版 TS 事件服务目录仅保留为历史记录，不是当前目标，也不应继续创建或迁移：

- `backend/ts/packages/contracts/src/protocol.ts`
- `backend/ts/api/events/publisher.ts`
- `backend/ts/api/events/subscriber.ts`
- `backend/ts/api/events/cursor.ts`
- `backend/ts/api/events/resources.ts`
- `backend/ts/api/src/server.ts`
- `backend/ts/api/src/auth.ts`
- `backend/ts/api/src/routes/live.ts`
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

#### 历史迁移草案中的修改项（已废止）

- `backend/app/core/events.py`：保留为过渡生产者适配层，改为严格输出 canonical event envelope；不得继续新增旧格式事件。
- `backend/app/api/v1/mind.py`：笔记、画布及关系提交后发布完整 mind canonical event。
- `backend/agent/runner.py`、`backend/agent/im/**`、`backend/app/scheduled_tasks.py`：业务提交成功后调用统一 publisher。
- `backend/app/api/v1/projects.py`、`events.py`、`files.py`、`folders.py`、`trash.py`、`user_bots.py` 及其他写入 API：统一接入 canonical publisher。
- `backend/app/api/v1/terminals.py`：改为发布终端状态/输出事件，不再依赖每个终端各自轮询。
- `frontend/src/stores/live.ts`：从 `resources/rev` 兼容模式升级为 envelope 分发。
- `frontend/src/composables/useLiveRefresh.ts`：暂时保留为 refetch 回退层，最终由领域 handler 替代。
- `frontend/src/stores/filesCache.ts`、`projects.ts`、`mind.ts` 以及日历、任务、会话相关消费模块：增加事件 patch 和 revision 缺口回退。

#### 当前保留的兼容和独立流

下面的旧迁移说明不再作为执行计划；当前后端仍由 Python/FastAPI 负责。

- FastAPI `/api/v1/live/stream` 入口：由 `backend/app/api/v1/live.py` 提供；TS Live 实现和 `gugu-live.service` 已删除。
- `frontend/src/composables/useLiveRefresh.ts`：当前仍作为 refetch 兼容适配器，待事件消费完全收口后再评估删除。
- `backend/app/core/events.py`：保留为业务写入侧 publisher；所有事件统一生成 canonical envelope，不再接受 mind 的旧位置参数调用。
- `backend/app/api/v1/terminals.py`：终端事件仍保留 sequence 补偿和独立输出流。

- `backend/agent/llm/genstream.py`：聊天生成流仍需独立存在。
- `backend/app/api/v1/admin_debug.py`：日志 tail 是独立诊断流。
- `backend/app/api/v1/files.py` 的文件二进制 stream：不是事件订阅。

`backend/config.override.json`、`.env`、数据库运行数据和用户存储目录不属于事件架构清理范围，禁止删除或覆盖。

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
| 多个生产者重复发布事件 | 同一变更重复通知或顺序不一致 | Python 业务侧只保留一个 canonical publisher，新增生产者先登记再接入 |
| 事件生产者未覆盖 | 页面收不到跨端更新 | 以生产者清单和跨端集成测试核对，缺口期间保留受影响资源补刷 |

---

## 7. 成功指标

| 指标 | 当前值 | 目标值 |
|---|---:|---:|
| 业务资源事件格式 | 主要资源已使用统一 envelope | 新增资源必须使用统一 envelope |
| 常见单实体更新的全量 refetch | 项目、日历、任务多为全量刷新 | 项目/日历/任务/文件常见操作为 0 次全量刷新 |
| 断线后的数据一致性 | 依赖重连错峰补刷 | 通过 revision/cursor 可验证最终一致 |
| 业务事件重复处理 | live store 已按 event ID 过滤，领域处理仍分散 | 统一 event ID 幂等处理 |
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
9. FastAPI 事件服务可以在 Python 生产者持续运行时独立工作；不保留 TS Live fallback。
10. Web、QQ、飞书、微信、定时任务和 Agent 工具任一端成功变更数据后，其他在线端都能通过统一事件订阅实时看到结果。

---

## 9. 相关资源

- [`backend/app/core/events.py`](../../backend/app/core/events.py)
- [`backend/app/api/v1/live.py`](../../backend/app/api/v1/live.py)
- [`frontend/src/stores/live.ts`](../../frontend/src/stores/live.ts)
- [`frontend/src/composables/useLiveRefresh.ts`](../../frontend/src/composables/useLiveRefresh.ts)
- [`frontend/src/stores/filesCache.ts`](../../frontend/src/stores/filesCache.ts)
- [`frontend/src/components/common/gugu-chat/composables/useChatConversation.ts`](../../frontend/src/components/common/gugu-chat/composables/useChatConversation.ts)
