# Agent 会话快照与增量上下文架构重构方案

> 状态：P0-P5 已完成，已切换到 session snapshot 主链路；旧 summary / system-reminder 仅保留为兼容格式，未再作为第二套业务上下文来源。2026-08-21 收尾清理了旧 builder、无效快照字段和临时诊断脚本。
>
> 基线：`dev @ 77b6a0e`（2026-08-20）

## 1. 背景与目标

当前 Agent 已完成第一阶段的 system 前缀稳定化：静态人格、政策和技能放在
`system`，动态内容通过 `[system-reminder]` 放入 `messages`。但每轮仍会重新加载
并重新组装 memory、projects、calendar、files、channel、style、lens 等上下文。

这会带来三个问题：

1. session 内本来不变的资料反复查询、反复序列化；
2. 动态 reminder 的结构容易变化，破坏前缀缓存；
3. runtime、压缩、trace 和业务消息的生命周期边界不清晰。

本次重构目标是建立单一的 session 上下文模型：

```text
session 开始 / TTL 到期 / 压缩完成
  system + session info + history <cached> + dynamic tail

普通 run
  system + session info + history + new message <cached> + dynamic tail
```

其中 `session info` 是按 TTL/压缩重建的项目、日历、文件和 memory；`dynamic tail` 是
每轮变化的 summary、相处方式和当前时间。普通 run 不重新加载 session info，只追加真实
的 user、assistant、tool 消息和 dynamic tail。验证日志、性能 trace、Gateway ack、探针和
cache 统计永远不进入 LLM context。

## 2. 当前基线盘点

### 2.1 Prompt 组装

| 模块 | 当前实现 | 问题 |
| --- | --- | --- |
| `agent/context/builder.py` | `build_split()` 返回静态 system、动态文本、当前时间 | 动态业务数据每轮重新加载并重新序列化 |
| `agent/runner.py` | `run_collect()` / `run_stream()` 各自组装一遍上下文 | Web/IM 两条路径存在重复编排逻辑 |
| `agent/gateway/web.py` | Web 入口再次执行 loader、builder、reminder 组装 | 与 runner 的生命周期边界不统一 |
| `agent/context/message_assembly.py` | 负责 reminder、当前消息和 system 注入包装 | 与 `session_snapshot` 通过统一快照生命周期协作 |
| `agent/im/context_loader.py` | 每轮读取项目、日历、文件、记忆和渠道 | 不区分 session 初始化与普通 run |

### 2.2 历史消息与会话持久化

| 模块 | 当前实现 | 缺口 |
| --- | --- | --- |
| `ConversationSession` | 保存标题、来源、平台、snapshot hash、context epoch 和 TTL | snapshot 元数据只用于生命周期与一致性检查 |
| `ConversationMessage` | 保存 role、content、content_json、附件、群聊元数据和 `sent_at` | 不额外保存无业务用途的 sequence/run_id |
| `tokens.select_history()` | 按 token 预算从数据库历史中裁剪 | 不知道 snapshot 已覆盖到哪里，无法只构造新增尾部 |
| `compress_conv.py` | 后台将旧消息压成一条 summary | summary 和 system reminder 的生命周期耦合不清晰 |
| `context/compaction.py` | 运行时消息列表压缩并检查前缀 | 仍把 system injection 当作普通消息特殊识别 |

### 2.3 缓存与 provider 适配

| 模块 | 当前实现 | 说明 |
| --- | --- | --- |
| `loop_drivers.py` | system 使用 `cache_control`，最后一条消息设置历史缓存断点 | Provider 仍是无状态请求，下一次请求仍需携带历史 |
| `providers.py` / `llm_select.py` | 按 provider 判断主动/被动缓存能力 | TTL 属于 provider 缓存，不属于 Gugu session 状态 |
| LoopScope trace | 记录 run、round、usage、cache 命中等 | 应保持旁路，不写入 `ConversationMessage` |

### 2.4 当前上下文数据分类

> 本节记录当前代码的真实行为与目标生命周期差异。`ensure_snapshot()` 目前会把
> loader 结果整体冻结到 session；动态 tail 的位置和内容仍需按目标架构调整。

| 数据 | 当前实际位置 | 当前刷新时机 | 目标生命周期 | 普通 run 是否刷新 |
| --- | --- | --- | --- | --- |
| persona / policy / skills | system | 初始化 / TTL | session 固定；配置变更时失效 | 当前否 |
| 相处方式 / stance | session info 中的 dynamic context | 初始化 / TTL | **每轮反思后下一轮追加到 dynamic tail** | 当前否，目标是是 |
| summary / 当前状态 | session info 中的 dynamic context | 初始化 / TTL | **每轮反思后下一轮追加到 dynamic tail** | 当前否，目标是是 |
| profile / pattern | session info | 初始化 / TTL | TTL/压缩时更新 | 否 |
| daily / long-term memory | session info | 初始化 / TTL | TTL/压缩时更新 | 否 |
| projects | session info | 初始化 / TTL | TTL/压缩时更新 | 否 |
| calendar | session info | 初始化 / TTL | TTL/压缩时更新 | 否 |
| files | session info | 初始化 / TTL | TTL/压缩时更新 | 否 |
| channel / IM scope | session info | 初始化 / TTL | session/权限边界变化时重建 | 否 |
| style / lens | system 或 session info | 初始化 / TTL | TTL/压缩或显式设置变化时更新 | 否 |
| 当前时间 | dynamic tail | 每轮 | 每轮动态 | 是 |
| user / assistant / tool | 对话历史 | 每轮 | 只追加 | 是 |
| trace / probe / ack / cache usage | 观测平面 | 旁路记录 | 永不进入上下文 | 否 |

### 2.5 Section 动态性调查结论

- `builder.build_split()` 已将相处方式放入 dynamic 部分，并注明“每次 call 可能变化”；
  但 `session_snapshot.ensure_snapshot()` 只在首次或 TTL 到期时调用 loader，因此 stance
  实际仍被 snapshot 冻结。
- 反思任务会在每轮结束后写入 stance、summary、profile、pattern、daily 和 lens；当前
  写入不会自动使相关 session snapshot 失效，下一轮可能继续读取旧内容。
- projects、calendar、files 的 loader 注释仍描述为“每轮注入/保证最新”，但当前主链路
  已改为 session snapshot，注释与实现不一致。
- summary 的时间衰减文案在 builder 重建时计算；snapshot 不重建时，随时间流逝也不会重新
  计算衰减等级。
- 当前时间已经正确放在每轮尾部，不应重新放回 snapshot 或 system 前缀。

因此上下文应拆成三类：

1. **缓存前缀**：system、session info、已有历史消息；同一 TTL/压缩周期内保持字节稳定。
2. **每轮动态尾部**：summary、相处方式、当前时间，以及本轮新消息需要的临时动态信息。
3. **观测平面**：trace、probe、ack、cache usage，永不进入上下文。

项目、日历、文件和 memory 不做会话内持续失效；它们随 TTL 或压缩更新，当前对话中刚
发生的变化通过 tool result 和后续历史消息提供事实依据。这样既保持实时对话语义，又不
破坏缓存前缀。

## 3. 目标模型

### 3.1 Context epoch

一个 session 可以有多个 context epoch：

- session 创建时建立 epoch 1；
- idle TTL 到期时建立新的 epoch；
- 压缩成功并重建上下文时建立新的 epoch；
- 显式“刷新上下文”时建立新的 epoch。

epoch 变化代表 snapshot 重新生成，不代表新建用户可见的聊天 session。

### 3.2 Snapshot

Snapshot 是一个逻辑 checkpoint，不重复存储整段 prompt。建议最少包含：

```text
context_epoch
system_hash
session_info_hash
snapshot_hash
  created_at
expires_at
```

其中：

- `system_hash`：静态 system 的规范化 hash；
- `session_info_hash`：memory/projects/calendar/files/channel/style/lens 的整体 hash；
- `snapshot_hash`：`system + session-info + 已覆盖历史消息` 的整体 hash；
- 快照覆盖游标由规范化消息 hash 表达，不依赖额外的消息序号或 run id；
- hash 只用于一致性检查和去重，不写入 LLM prompt。

### 3.3 Run 增量结构

```text
Run 1:
  system + session-info + history <cached>
  user1
  assistant1
  summary + stance + run1-time <dynamic>

Run 2:
  system + session-info + history + user1 + assistant1 + user2 <cached>
  summary + stance + run2-time <dynamic>

Run 2 完成后:
  snap(hash=H2)，覆盖到 assistant2
```

由于当前 provider API 是无状态的，Run 2 的 HTTP 请求仍然需要携带 H1 对应的完整
前缀；“增量”指组装和持久化只处理 H1 之后的新消息，不是把历史从请求中删除。
前缀只要字节级稳定，provider 就可以复用缓存。

## 4. 生命周期设计

### 4.1 Session 初始化

1. 创建或读取 `ConversationSession`。
2. 若没有有效 snapshot，加载一次所有 session snapshot 数据。
3. 固定 system、session-info 和历史缓存前缀；不把 summary/stance/time 固定进 snapshot。
4. 写入 snapshot 元数据和初始 hash。
5. 在缓存前缀之后追加当前消息和 dynamic tail（summary、stance、当前时间）。

### 4.2 普通 run

1. 读取当前 snapshot 元数据，不重新加载项目、日历、文件和 memory。
2. 根据 snapshot 的规范化消息 hash 判断新增消息，并保持已有历史前缀稳定。
3. 在历史/新消息之后追加本轮 dynamic tail（summary、stance、当前时间）。
4. 执行 Agent loop，工具结果按正常 tool message 进入上下文。
5. 持久化 assistant/tool 消息。
6. 更新 snapshot 的消息 hash 和 `snapshot_hash`，不复制 snapshot 正文。

### 4.3 工具修改业务数据

工具结果本身进入当前对话，成为最新事实。普通 run 不重新加载 projects、calendar、files
或 memory；模型通过本轮 tool result 和下一轮 history 看到刚刚发生的变化。

这些 session info 只在以下时机重建：

1. 新 session；
2. 30 分钟 idle TTL 到期；
3. 压缩完成；
4. 用户显式要求刷新上下文；
5. 权限边界或 session 来源发生变化。

工具事件可以用于观测和标记“下次 TTL/压缩需重建”，但不应在每个写操作后打断当前
session 的缓存前缀。

### 4.4 Idle TTL

TTL 使用“连续闲置时间”，而不是从 session 创建时间起算：

- 每次成功完成 run 后刷新 `last_activity_at`；
- 超过 TTL 后，下一条消息触发新 epoch；
- 新 epoch 重新加载 snapshot；
- 不在旧历史中追加第二份全量 snapshot；通过 checkpoint/summary 形成新前缀。

TTL 只控制 Gugu snapshot 的刷新，不等同于 Anthropic/MiniMax 的 provider cache TTL。

### 4.5 压缩

压缩不是简单插入一条 summary，而是一次 checkpoint 重建：

1. 选择需要压缩的历史；
2. 生成 summary；
3. 保留最新消息窗口；
4. 将 summary、最新窗口和当前 session-info 组成新的 snapshot；
5. 新增 context epoch；
6. 更新 snapshot hash 和覆盖游标；
7. 后续 run 从新 snapshot 继续追加。

旧消息可归档或删除，但不能让旧 snapshot 与新 snapshot 同时作为模型上下文出现。

### 4.6 反思与实时上下文

反思是异步执行的，因此“实时更新”定义为：反思完成后，**下一次 run** 应能看到新内容，
而不是当前已经发出的回答被回写。反思产物不回填 session info，而是在下一轮作为
dynamic tail 追加。

| 反思产物 | 变化语义 | 下一轮处理 |
| --- | --- | --- |
| `perception.intent` → stance | 当前相处姿态 | 下一轮 dynamic tail |
| summary | 用户当前状态快照 | 下一轮 dynamic tail |
| profile / pattern | 稳定画像与行为模式 | TTL/压缩时更新 session info |
| daily / long-term memory | 最近事件与长期沉淀 | TTL/压缩时更新 session info |
| lens | 经过候选确认后的解读规则 | TTL/压缩时更新 system/session info |

### 4.7 压缩边界实现约束

压缩器只处理 conversation/message 区域，不处理 snapshot 固定前缀和 dynamic tail：

```text
snapshot prefix (system / session-info / 固定 reminder)
        ↓ 原样保留
message history + tool rounds + current message
        ↓ 只压缩这里
compacted summary + recent messages
        ↓
重新拼接 dynamic tail (stance / summary / current time)
```

`PromptMessages.fixed_prefix_size` 是装配层与压缩器之间的边界契约。压缩后仍通过
`replace_conversation()` 保留 dynamic tail；snapshot 正文不复制、不进入摘要，只有
checkpoint hash / covered message cursor 在 run 完成或压缩完成后更新。普通 list 调用的
`fixed_prefix_size=0` 仅用于旧历史和兼容测试。

反思事件不能把原始用户消息、assistant 正文或 LLM 验证日志写进可见日志，也不能把事件
元数据放进模型 prompt；事件只负责使 section 失效。

## 5. 观测平面隔离

以下内容只允许写入 trace / audit / diagnostics，不得进入 `ConversationMessage` 或
snapshot hash：

- runtime / gateway ack；
- probe 和 debug log；
- 性能耗时、round 计数、cache read/write 统计；
- provider 原始响应元数据；
- 验证脚本输出；
- 内部 session id、trace id、snapshot hash 本身。

模型只接收：

- system；
- session snapshot；
- user / assistant 历史；
- 必要且经过整理的 tool result；
- 当前 run 的时间信息。

### 5.1 Snapshot trace schema

LoopScope 的 snapshot 生命周期事件使用独立的 context span，schema version 为 `1`：

```json
{
  "schema_version": 1,
  "phase": "hit | rebuild",
  "context_epoch": 2,
  "snapshot_hash": "sha256",
  "session_info_hash": "sha256",
  "covered_message_id": 123,
  "expires_at": "2026-08-21T12:30:00+00:00"
}
```

该对象只写入 LoopScope trace，不写入 `ConversationMessage`、`session_context` 或模型
messages。`snapshot_hash`、`session_info_hash` 只用于观测和一致性核验；业务正文、用户
消息、工具结果、Gateway ack、probe、cache usage 和内部 trace id 均不进入该事件。
没有 active LoopScope run 的 IM/离线路径会静默跳过观测，不影响主链路。

## 6. 分阶段实施 TODO

### P0：数据模型与 hash

- [x] 给 `ConversationSession` 增加 context epoch、snapshot hash、session-info hash 和 TTL。
- [x] 给消息补齐稳定的 `sent_at`；不再新增无业务用途的 sequence/run_id 元数据。
- [x] 实现规范化 prompt hash，排除 cache_control、trace 和内部元数据。
- [x] 增加 snapshot/checkpoint 数据库迁移，并在 devserver 回退基线后升级到新 P0 head。

### P1：统一组装入口

- [x] 抽出唯一的 session snapshot/context service，runner/web 通过 `ensure_snapshot` 共用生命周期。
- [x] 将 projects、memory、calendar、files、channel、style、lens 限定为 snapshot 初始化或 TTL 重建加载。
- [x] 将当前时间、当前消息和临时 reminder 固定为 run 尾部消息；固定 snapshot reminder 不再携带时间。
- [x] 保持同一 epoch 内 system 字节级稳定。

### P2：增量 run

- [x] 按规范化消息 hash 保存覆盖状态；普通 run 的业务 snapshot 只追加当前 run 的消息 hash。模型历史由 `context/session_history.py` 按 session baseline 连续读取，不再使用会滑动的最近 N 条 token 窗口。
- [x] 普通 run 不执行完整业务 loader；Web/IM 仅在新 session 或 TTL 过期时加载。
- [x] run 完成后更新 snapshot hash；压缩完成后同步更新 `baseline_message_id` / `baseline_message_hash`，不复制完整 snapshot 正文。
- [x] Web、QQ、飞书、微信共用 `session_snapshot` 生命周期（IM 仍保留权限过滤策略）。

### P3：TTL 与显式刷新

- [x] 实现 30 分钟 idle TTL 检查。
- [x] 提供 `invalidate_snapshot()` 显式刷新服务入口，下一轮按当前权限重建。
- [x] snapshot 重建时重新读取权限、channel、style/lens 并递增 epoch。
- [x] 增加 snapshot 命中、TTL 到期和稳定 reminder 的回归测试。

### P4：压缩与迁移

- [x] 现有 summary 压缩完成后写入 snapshot checkpoint 和覆盖游标。
- [x] 组装主链路不再读取 legacy runtime section；`system-reminder` 只作为模型可见的稳定/尾部消息格式，compaction 的旧格式识别仅作历史兼容。
- [x] 旧 session 首次进入新链路时只生成一次新 snapshot。
- [x] 压缩后只保留一个 summary checkpoint，不同时插入新旧全量业务 snapshot。

### P4.5：Section 动态失效（调查后新增）

- [x] 将 behavior/stance 从 session info 中拆出，反思完成后下一轮追加到 dynamic tail。
- [x] 将 summary 从 session info 中拆出，反思完成后下一轮追加到 dynamic tail。
- [x] 保持 projects、calendar、files、profile、pattern、daily、long-term memory 只在 TTL/压缩时更新。
- [x] 保持 lens、style 和权限边界在 TTL/压缩或显式变化时更新，不做普通 run 持续刷新。
- [x] 调整消息组装顺序：`system + session info + history + new message <cached> + dynamic tail`；tool round 与 follow-up 也插入尾部之前。
- [x] 为动态尾部、TTL 重建、压缩重建分别补充 session 级回归测试，确保动态内容不污染缓存前缀。

### P5：观测与验收

- [x] 明确 trace schema 与 ConversationMessage 的边界。
- [x] 增加 snapshot hash、covered cursor、TTL 命中/重建的脱敏 trace。
- [x] 增加 Web/IM、普通 run、tool round、TTL、压缩、群聊的回归测试。
- [x] 使用相同对话连续运行 3 轮，确认第二轮以后只新增真实消息尾部。
- [x] 在 LoopScope 对比 `input_tokens`、`cache_read_input_tokens` 和 snapshot hash。

#### P5 验收记录（2026-08-21）

- `backend/tests/test_session_snapshot.py`：覆盖规范化 hash、观测元数据隔离、TTL 命中/重建、checkpoint hash、动态尾部和 cache boundary；snapshot trace 只保留 hash/epoch/TTL 元数据。
- `backend/tests/test_core_loop_characterization.py`、`backend/tests/test_loopscope_usage.py`：覆盖 Web/runner 普通 round、tool/follow-up、LoopScope usage 和无 active run 的 IM wrapper。
- `backend/tests/test_im_identity.py`、`backend/tests/test_scheduled_group_imctx.py`：覆盖 IM 会话与群聊上下文边界；`backend/tests/test_compaction.py`、`backend/tests/test_session_snapshot.py` 覆盖压缩和 checkpoint 重建契约。
- 已用同一会话连续运行 3 轮核对：后续 round 保留稳定前缀，只追加真实 user/assistant/tool 消息和 dynamic tail；LoopScope 同时展示 input/cache usage 与 snapshot hash。
- 观测事件 schema 与正文隔离回归通过；trace、probe、ack、cache usage 不进入 `ConversationMessage` 或 snapshot hash。

## 7. 验收标准

1. 同一 session 普通 run 不重新加载 memory/projects/calendar/files。
2. `system` 与 session-info 在 epoch 内字节级不变。
3. Run N+1 的新增 prompt 只包含 run N+1 之后的新内容。
4. 上一轮结束后生成新的 snapshot hash，且不会在上下文中重复插入整块 snapshot。
5. TTL 到期或压缩时只重建一次新的 snapshot。
6. trace、probe、ack 和性能日志不进入 LLM input。
7. 历史消息保留发送时间，模型侧时间格式稳定且不破坏缓存前缀。
8. Web 与各 IM 入口的最终 messages 结构一致。
