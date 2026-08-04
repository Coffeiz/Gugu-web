# 群组与成员记忆 PRD

> 状态：设计完成，未实现
> 创建：2026-08-04
> 关联：[`PRD-IM-2-im-loop与gateway解耦.md`](./PRD-IM-2-im-loop与gateway解耦.md)、[`11-记忆系统.md`](../../agent/11-记忆系统.md)、[`21-群聊消息架构.md`](../../agent/21-群聊消息架构.md)、[`22-IM用户数据结构.md`](../../agent/22-IM用户数据结构.md)

## 1. 背景与目标

当前群聊已经有数据库短期消息窗口，但长期记忆仍复用 owner 记忆的设计讨论，容易出现三类问题：

- 群成员的公开信息被写入 owner 的个人 profile、pattern 或 memory。
- 群内身份、关系和协作信息被错误写入可跨群共享的平台用户记忆。
- 群资料、近期群状态和长期群知识混在一份文件里，无法分别更新、过期和删除。

本 PRD 为 `MemberAgentLoop` 和未来的群聊反思建立独立记忆层。它复用现有 memory 的读写、提取、压缩和检索能力，但不复用 owner 的 namespace、提示词边界和写入策略。

### 1.1 目标

1. 为每个 `platform + bot_id + group_id` 建立独立群组记忆。
2. 为每个 `platform + bot_id + platform_user_id` 建立独立平台用户记忆；同一 Bot 下同一平台用户的个人记忆可以跨群共享。
3. owner、member、unknown 读取不同范围；member/unknown 永远不能读取或写入 owner 私人记忆。
4. 群聊每条历史消息保留 `sender_id`、`sender_name`、时间和消息 ID，模型能区分是谁说的。
5. 记忆提取、daily 压缩和摘要更新全部异步执行，不阻塞当前回复。
6. 为成员退出、群解散、记忆删除和可见范围审计预留明确接口。

### 1.2 非目标

- 本阶段不修改 Web owner 记忆的六层结构和行为。
- 不把群聊消息自动转成 owner 的 profile、pattern、summary 或 memory。
- platform-user 只描述用户长期身份、偏好和个人状态；群内称呼、角色、关系、分工和决定必须留在 group scope。
- 不为每个群复制一套模型、工具或 Agent Loop；只新增作用域和编排策略。
- 不在 Gateway 中实现记忆读取、提取或压缩。

## 2. 核心概念

### 2.1 记忆作用域

物理 key 必须包含 bot 所属的 Gugu 账号和平台上下文：

```text
owner_user_id + platform + bot_id + scope_type + scope_id
```

其中：

| 字段 | 含义 |
|---|---|
| `owner_user_id` | Bot 所属的 Gugu 账号，决定存储归属，不代表当前发言人 |
| `platform` | `qq`、`feishu`、`wechat` 等 |
| `bot_id` | 当前 Gugu Bot，防止同一账号多个 Bot 串会话 |
| `scope_type` | `group` 或 `platform_user` |
| `scope_id` | 群 ID 或平台用户 ID |

裸 `group_id`、裸 `platform_user_id` 和 owner 的 `user_id` 都不能直接作为记忆 key。

统一原则：

- `platform-user` 记忆描述这个用户长期是谁、偏好什么、近期处于什么个人状态，可以在同一 Bot 的不同群之间共享。
- `group` 记忆描述当前群里的称呼、角色、关系、分工、决定和协作事项，永远不能借助 platform-user scope 跨群传播。
- 不同 Bot、不同平台和不同 `owner_user_id` 始终隔离。

### 2.2 文件格式

现有 owner memory 的真实实现是结构化 JSON + Markdown，而不是全部使用 `.md`。IM 记忆沿用这个约定：

```text
.agent/im/{platform}/{bot_id}/
├── groups/{group_id}/
│   ├── profile.json
│   ├── summary.json
│   ├── daily.md
│   └── memory.md
└── platform-users/{platform_user_id}/
    ├── profile.json
    ├── pattern.json
    └── summary.json
```

真实存储 key 还要带 `owner_user_id`，上图是逻辑目录。

## 3. 记忆内容分工

### 3.1 群组记忆

| 文件 | 内容 | 写入规则 |
|---|---|---|
| `profile.json` | 群名、群性质、明确群规、稳定协作约定、公开成员/角色概览 | 只记录群内公开且稳定的信息；不从昵称或一次对话推断身份 |
| `summary.json` | 当前群正在讨论的主题、近期状态、未完结的群内协作事项 | 作为短状态快照，允许被新消息覆盖，带更新时间和衰减 |
| `daily.md` | 近期群聊事件、决定、讨论过程和上下文流水 | 新内容追加在前；只收当前群可见内容 |
| `memory.md` | 从 daily 压缩出的稳定群知识和较长时间线 | 只保留可复用的群内事实，不复述整份 profile/pattern |

`summary.json` 必须保留。它和 `daily.md` 的区别是：summary 回答“现在群里处于什么状态”，daily 记录“最近发生了什么”，memory 记录“长期沉淀了什么”。

### 3.2 平台用户记忆

| 文件 | 内容 | 写入规则 |
|---|---|---|
| `profile.json` | 用户在当前 Bot 作用域下明确表达的稳定个人资料 | 只记录本人明确说过或可直接观察到的信息 |
| `pattern.json` | 表达习惯、协作偏好、可复用行为模式 | inferred 内容必须带置信度和时间，按现有衰减规则处理 |
| `summary.json` | 该用户近期在当前 IM 里的状态或话题 | 轻量快照，不等同于 owner 的完整 summary |

平台用户记忆不是 Gugu 用户 profile。即便它们映射到同一个 Gugu owner，也必须通过身份和角色策略明确决定是否可读。

`profile.json` 和 `pattern.json` 只保存稳定或可复用的个人信息；近期状态和个人话题优先进入 `summary.json` 或 daily/recent 层，必须带时间并允许衰减，不能多年后仍被当成稳定身份。

## 4. 上下文读取策略

### 4.1 owner

owner 在群聊中使用 Web/owner 的完整 Agent Loop：

```text
owner 个人完整记忆
+ 当前群 profile/summary
+ 当前群最近消息窗口（每条带 sender_id/name）
```

owner 的个人记忆可以继续读取和写入；群内公开内容只能写入当前群记忆，不能反向改变 owner 个人记忆。

owner 在群里主动调用个人项目、文件、日程、记忆或其他私人工具，视为授权将本次请求所需结果回复到当前群。不增加二次确认，也不主动扩展到 owner 未请求的其他私人内容。owner 仍使用完整 Agent Loop；member 和 unknown 永远不能借用 owner 权限。

### 4.2 member

member 使用轻量 Member Loop：

```text
当前群 profile/summary
+ 当前发言人的 platform-user profile/pattern/summary
+ 当前群最近消息窗口
+ 工具白名单
```

默认不读取当前群完整 `memory.md`，避免把较长历史和敏感群内背景直接暴露给成员；是否开放群长期记忆由群策略单独决定。member 永远不读取 owner 的 profile、pattern、summary、memory、项目、文件和日程。

### 4.3 unknown

```text
当前群公开 profile/summary
+ 当前群最近消息窗口
+ 最小工具白名单
```

unknown 只是身份解析失败时的兜底角色，不代表群外陌生人。unknown 可以读取当前群 profile/summary 和最近消息，但不加载 platform-user 个人记忆、不触发 platform-user 写入，并使用最小工具白名单。

### 4.4 历史消息格式

内部模型上下文必须保留明确发言人边界：

```text
[2026-08-04 12:30] CoffeiZzz (platform_user_id=...): 消息内容
```

真实 ID 只进入内部上下文和权限判断，不进入普通用户可见的诊断日志。昵称只用于称呼，绝不用于身份合并。

## 5. 写入、反思与压缩

### 5.1 触发时机

| 场景 | 数据库短期消息 | 群组记忆 | 平台用户记忆 |
|---|---:|---:|---:|
| 未 @ 的普通群消息 | 立即写入 | 异步批处理 | 不触发 |
| @ 咕咕并回复 | 立即写入 | 异步反思 | 仅分析当前发言人 |
| owner 在群中发言 | 立即写入 | 异步反思 | 不把 owner 当 member 写入 |
| 反思失败 | 不影响回复 | 保留数据库消息，下次重试 | 保留数据库消息，下次重试 |

可以按每 10～20 条消息、一次回复完成、群聊空闲一段时间或定时补偿扫描触发反思；具体批量阈值由实现和压测确定。回复完成只负责投递任务，不能阻塞当前回复。低频群也必须通过空闲或定时补偿进入反思。

### 5.2 反思可靠性协议

反思任务和 scope 游标分开持久化：

```text
reflection_job
- job_id
- scope
- from_message_id
- to_message_id
- idempotency_key
- extractor_version
- status / retry_count

reflection_cursor
- scope
- last_reflected_message_id
- scope_version
- updated_at
```

- 同一 scope 的反思任务串行执行。
- 同一消息范围重复投递必须幂等；建议使用 `(scope, from_message_id, to_message_id, extractor_version)` 作为幂等键。
- 游标更新必须带版本控制，避免并发反思覆盖较新的结果。
- 失败不影响主回复，任务保留并按重试策略处理；长期失败由补偿扫描再次投递。
- 同一消息可以分别进入 group 和 platform-user 两个 scope，但两个 scope 的任务、游标和写入必须独立。

### 5.3 信息类型与目标 scope

| 信息类型 | 目标 scope | 规则 |
|---|---|---|
| 用户明确自述的职业、兴趣、长期身份 | platform-user | 可进入 profile；只记录本人明确表达的内容 |
| 表达习惯、回复偏好、稳定协作方式 | platform-user | 可进入 pattern；inferred 内容必须带置信度和时间 |
| 用户近期个人状态、个人话题 | platform-user summary/daily | 必须带时间并允许衰减，不直接当作永久 profile |
| 当前群里的昵称、称呼 | group profile | 只属于当前群，不能写入 platform-user |
| 当前群角色、负责人身份、项目分工 | group profile/summary | 只记录当前群语境下的明确事实 |
| 群内关系、决定、讨论和协作事项 | group daily/memory | 只处理当前群可见内容 |
| 从昵称推断真实身份 | 禁止持久化 | 不允许写入任何长期 scope |
| 从语气推断性格或敏感属性 | 禁止持久化 | 不允许写入任何长期 scope |
| 根据其他成员评价更新某人的个人 profile | 禁止持久化 | 除非本人明确自述并符合 platform-user 规则 |
| owner 私人工具结果 | 禁止写入 group/member | 可以按请求回复当前群，但不复制为群记忆 |
| 数据库已能查询的项目、文件、日程状态 | 禁止持久化 | 使用工具实时查询，不复制进长期记忆 |

### 5.4 提取边界

- 群组反思只处理当前群公开可见消息。
- 成员反思只处理当前 `platform_user_id` 的发言和明确自述。
- 不能从昵称、语气、群内他人评价推断真实身份、关系或敏感属性。
- 不能把工具返回的 owner 私人资料写入群组或 member 记忆。
- 结构化数据库已经能查到的项目、文件、日程状态不复制进长期记忆。

### 5.5 来源追踪

长期记忆条目必须能追溯来源，至少保留：

```json
{
  "source_message_ids": [],
  "source_actor_ids": [],
  "source_scope": "...",
  "extractor_version": "...",
  "created_at": "...",
  "updated_at": "..."
}
```

实现阶段优先使用 `memory_entry` + `memory_source` 关联模型，避免来源数组无限增长。来源追踪用于防止重复提取、定位记忆来源、删除派生内容，以及在提取器升级后重建记忆。

### 5.6 压缩

复用 `memory/compress.py` 的 daily→memory 思路，但 prompt、scope 和输入字段必须独立：

```text
group daily.md → group memory.md
```

不允许把群 daily 送进 owner 压缩器，也不允许压缩器写入 owner namespace。失败时保留原 daily，不覆盖已有 memory。

## 6. 文件与代码职责

```text
backend/agent/
├── memory/
│   ├── store.py              # 通用底层读写、渲染、向量缓存；保持 owner 行为兼容
│   ├── scopes.py             # MemoryScope 构造、校验和安全 key
│   ├── scoped_store.py       # 按 MemoryScope 读写 profile/summary/daily/memory
│   ├── reflection.py         # owner 反思，保持现有六层记忆行为
│   ├── im_reflection.py      # group/member 反思、边界过滤和异步任务入口
│   ├── reflection_jobs.py    # 反思任务、scope 游标、幂等和重试状态
│   ├── compress.py           # 通用 daily→memory 原语；不持有 owner 或 IM 业务判断
│   └── _llm.py               # 记忆专用结构化模型调用
├── im/
│   ├── context_policy.py     # owner/member/unknown 的可读范围
│   ├── context_loader.py     # 只读装配当前 scope 的上下文
│   ├── actor_resolver.py     # 根据平台 ID、Bot 绑定和群信息解析角色
│   ├── session.py            # DB 短期消息和 recent window；不写长期记忆
│   ├── loop.py               # 选择 Loop、触发异步反思，不实现提取算法
│   └── models.py             # PlatformMessage、ActorContext 和消息元数据
└── prompts/
    ├── reflection.md         # owner 反思 prompt
    ├── compress.md           # owner 压缩 prompt
    └── im/                   # group/member 专用 prompt（实现阶段新增）
```

职责红线：

- Gateway 只解析平台事件、附件、即时 ack 和出站协议，不碰记忆。
- `session.py` 只负责短期 DB 历史，不承担 daily/memory 写入。
- `context_policy.py` 只决定能读什么，不直接拼 prompt。
- `context_loader.py` 只读，不触发反思和压缩。
- `im_reflection.py` 是唯一的 group/member 长期记忆写入口。
- `actor_resolver.py` 是唯一的 owner/member/unknown 身份解析入口；模型、昵称和语气不能参与角色判断。
- `reflection_jobs.py` 是唯一的反思任务与 scope 游标管理入口。
- `scoped_store.py` 是唯一将逻辑 scope 转成存储 key 的入口。
- `loop.py` 只负责编排和投递异步任务，不能复制 owner reflection。

## 7. 数据生命周期与隐私

1. 数据库短期群消息继续按 `platform + bot_id + chat_id` 隔离，当前保留上限由 `21-群聊消息架构.md` 维护。
2. 记忆文件按相同 scope 保存，不能因清理 Redis session 而误删长期记忆。
3. 成员记忆必须支持按 `platform_user_id` 删除；群解散或 Bot 解绑时必须支持按整个 group scope 删除。
4. 群记忆删除不影响 owner 个人记忆；owner 记忆维护也不应扫描 IM namespace。
5. 删除 member、group 或 Bot scope 时，同时按来源追踪清理或标记派生记忆。
6. 日志只记录 scope、角色、数量、版本和脱敏 ID 指纹，不记录正文、文件名或记忆内容。
7. 管理员面板未来需要区分 owner memory 与 IM memory，禁止用 owner 的“记忆维护”按钮误操作群记忆。

## 8. 实施阶段

### Phase 0：契约与边界

- [x] 确认 scope、文件格式、owner/member/unknown 读取边界。
- [x] 确认群组 summary 保留，group 不拆 short-term/long-term 文件。
- [x] 确认 platform-user 在同一 Bot 下跨群共享个人记忆，group 信息不跨群传播。
- [x] 增加信息类型 → 目标 scope 矩阵、owner 群内调用规则和 unknown 定义。
- [x] 定义 ActorResolver、反思任务/游标和来源追踪契约。

### Phase 1：身份、作用域与只读上下文

- [ ] 新增 `ActorResolver`，只根据平台 ID、Bot 绑定和群信息返回 owner/member/unknown。
- [ ] 新增 `MemoryScope` 和安全 key 构造。
- [ ] 为 owner 旧 key 增加显式兼容路径，但不改变 owner 数据。
- [ ] `context_loader` 按角色加载 group profile/summary、member 轻量记忆和消息窗口。
- [ ] 默认关闭 member 的 group memory 全量读取。
- [ ] 验证 owner/member/unknown 不会互相注入。

### Phase 2：记忆模型与异步反思

- [ ] 新增记忆条目来源追踪模型。
- [ ] 新增反思任务、scope 游标、幂等键和版本控制。
- [ ] 新增 scoped store 的读写单测和跨 Bot/跨群隔离测试。
- [ ] 新增 group/member 专用提取 prompt 和 `im_reflection.py`。
- [ ] 接入回复完成、批量消息、群聊空闲和定时补偿触发。
- [ ] 接入 group daily→memory 压缩，失败不影响主流程。

### Phase 4：生命周期与管理

- [ ] 成员记忆删除、群解散清理、Bot 解绑清理。
- [ ] 管理员面板按 scope 展示、预览和删除。
- [ ] 日志和审计测试，确认不泄露正文。

## 9. 验收清单

### 自动验收

- [ ] 同一群、不同 Bot 的记忆 key 不相同。
- [ ] 同一 Bot、不同群的 daily/memory 不互相读取。
- [ ] 同一成员在不同群的个人记忆不互相读取。
- [ ] member/unknown 不读取或写入 owner memory。
- [ ] group/member 反思失败不影响当前回复，原始 DB 消息仍保留。
- [ ] daily 压缩失败不覆盖原 daily 或已有 memory。
- [ ] 每条群历史上下文带 sender ID、sender name、message ID 和时间。
- [ ] 删除 member、group、Bot scope 后对应记忆可完整清理，其他 scope 不受影响。

### 手动验收

1. owner 在群里查询自己的项目，行为与 Web 一致；群消息只作为额外上下文。
2. member 询问 owner 的资料、文件和项目时，不能读到 owner 私人内容。
3. member 明确介绍自己后，只有该 member 的 platform-user scope 可能产生轻量记忆。
4. 两个群讨论同名项目时，互相不会召回对方的群 memory。
5. 同一用户在两个群使用不同称呼时，不发生跨群记忆合并。
6. 普通未 @ 消息只落库；后续 @ 时能读到带发言人的最近窗口。
7. 反思和压缩在后台运行时，当前回复没有额外等待。
8. 删除群记忆后重新发言，不会读到已删除的旧群资料。

## 10. 风险与决策

| 风险 | 决策 |
|---|---|
| group memory 可能包含成员敏感信息 | 默认只写群内公开、明确表达、可复用内容；后续提供删除和可见范围管理 |
| 记忆文件数量增长 | 先使用现有对象存储 key；向量缓存可重建，不把向量当主数据 |
| member 上下文过长 | 默认只读 group profile/summary + recent window，长期 memory 由群策略开启 |
| 群内容与 owner 内容边界模糊 | 通过 role + scope 双重门禁，禁止仅凭 `owner_user_id` 放行 |
