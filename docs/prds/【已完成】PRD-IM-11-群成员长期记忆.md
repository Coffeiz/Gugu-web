# 群友批量长期记忆反思

> 状态：🟡 实现与自动化回归完成，待真实多人群人工验收
> 创建：2026-08-29
> 最近更新：2026-08-29
> 关联：[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)

## 1. 目标与边界

群记忆和群友记忆是两种不同的事实来源：

- `group reflection` 只维护群本身的 `profile`、`daily`、`summary` 和 `memory`，不向群友 scope 写入个人记忆。
- 被动群消息累计 50 条后，创建一次 `member-batch` 反思任务。
- `member-batch` 使用这 50 条消息的完整群聊上下文，一次性维护本批出现的多个群友的 `profile`、`pattern`、`summary` 和高价值 `memory`。
- 主动 @ 消息不再触发成员个人反思；它可以继续参与群级活跃窗口和群本身的反思。
- 私聊仍按对象 ID 隔离存储，但复用 owner 的即时反思组件和 Prompt，不属于群友批量反思。
- 群友没有独立 `daily.md`，长期事件直接整理到成员 scope 的 `memory.md`。

核心原则：**群级 scope 决定群本身记什么，批量成员反思再按语义主体把同一批上下文分发到各成员 scope。**

## 2. 触发和任务模型

### 2.1 两条独立任务

两类任务共用 `memory:reflection` Stream、worker 和 group scope 锁，但通过 `task_type` 和独立游标分开：

| task_type | 来源 | 写入对象 | 游标 |
|---|---|---|---|
| `group` | 群级活跃窗口、15 分钟空闲收束 | 当前群 scope | `last_reflected_message_id` |
| `member-batch` | 被动群消息累计 50 条；空闲收束补偿未处理消息 | 本批出现的 platform-user scopes | `last_member_reflected_message_id` |
| `private-owner` | 每个私聊 Agent 回合完成后立即复用 owner 反思组件；空闲收束用于补偿未处理回合 | 当前私聊对象 platform-user scope | `last_reflected_message_id` |

同一批消息可以同时存在两种任务，不能用同一 idempotency range 合并。数据库任务唯一约束因此包含 `task_type`，游标也分别保存两条进度。

### 2.2 上下文

私聊不使用独立的成员反思阈值，但保留 `private_reflection.md` 作为专用 Prompt。它沿用 owner 的 profile、pattern、summary、daily 判断标准和 JSON 契约，并明确当前私聊对象是唯一记忆主体；仅通过 platform-user scope 隔离私聊对象的存储。

成员批反思读取当前群消息范围内的完整用户消息，保留每条消息的时间、昵称和稳定 `platform_user_id`。它不按成员预先过滤消息，也不为每个成员单独调用模型。

成员提示词必须区分：

- 发言人和语义主体不是同一个概念；
- 第一人称表达不代表整句话都在描述发言人；
- 引用、转述、代词、玩笑和主体不明确的内容不得猜测；
- 成员互动可以记录，但只能描述该成员自己的行为。

## 3. 成员批输出契约

`backend/agent/prompts/im/member_reflection.md` 要求一次只输出 JSON：

```json
{
  "members": [
    {
      "platform_user_id": "本批消息中真实出现的成员 ID",
      "profile": [{"type": "name|address|pronoun|background|preference|note", "text": "只描述该成员"}],
      "pattern": [{"text": "只描述该成员", "kind": "observed|inferred", "importance": 1}],
      "summary": "不超过120字的近期状态",
      "memory": "整理后的高价值长期事件，没有时为空字符串"
    }
  ]
}
```

所有字段都是本批增量。`memory` 必须是整理后的长期事件叙述，不复制原始聊天；不确定归属时宁可漏记。

落库前的硬边界：

1. `platform_user_id` 必须出现在本批消息中；已维护的 `members.json` 存在时还必须是已知成员。
2. 每个成员本批最多处理一次。
3. 每个成员单独读写 `platform-user` scope；单个成员写入失败不阻塞其他成员。
4. `memory.md` 复用事件型记忆合并和增量向量同步；`profile.json`、`pattern.json`、`summary.json` 使用现有合并语义。

## 4. 群级提示词边界

`group_reflection.md` 和 `group_compress.md` 只允许输出和写入群本身的信息。多人协作可作为群事件保留，但不得把成员个人偏好、性格、经历或状态复制到群友 scope，也不得输出 `member_memory_add`。

## 5. 修改目标

```text
backend/app/models/__init__.py
  MemoryReflectionJob.task_type
  MemoryReflectionCursor.last_member_reflected_message_id
backend/alembic/versions/20260829000004_split_im_reflection_tasks.py
backend/agent/memory/reflection_jobs.py
  被动 50 条计数、两类任务入队、主动路径不触发成员批次
backend/agent/memory/im_reflection.py
  member-batch prompt 选择、批量成员落库、独立游标推进
backend/agent/im/loop.py
  移除主动回复后的 platform-user 反思
backend/agent/prompts/im/group_reflection.md
backend/agent/prompts/im/group_compress.md
  清理成员派生输出
backend/agent/prompts/im/member_reflection.md
  完整群上下文批量成员记忆提示词
backend/tests/test_im_memory_scopes.py
backend/tests/test_memory_event_scopes.py
```

## 6. 验收清单

- [x] 群反思和成员批反思使用独立任务类型和游标。
- [x] 被动群消息累计 50 条创建 `member-batch` 任务。
- [x] 群聊主动 Agent 回合不再单独触发 platform-user 反思；私聊回合复用 owner 反思组件即时调度。
- [x] 成员批反思一次读取完整群聊上下文并批量输出多个成员。
- [x] 群级 prompt 不再输出 `member_memory_add`。
- [x] 成员 profile、pattern、summary、memory 按真实消息成员校验后分别落库。
- [x] 成员 memory 使用事件合并和 `prune=False` 增量向量同步。
- [x] 失败隔离、非法成员过滤、批量分发和游标触发回归测试通过。
- [ ] devserver 真实多人群验收：确认群记忆只含群信息，成员记忆只含明确归属信息。
