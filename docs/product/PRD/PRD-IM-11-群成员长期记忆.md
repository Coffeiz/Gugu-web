# 群成员长期记忆（从群压缩派生）PRD

> 状态：📝 草案（未实现，依赖 `PRD-MEM-2` 公共事件记忆底座）
> 创建：2026-08-10
> 关联：[`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)（本 PRD 是它的直接延伸，共享其记忆作用域、隔离和隐私边界，不重复冻结项）

## 1. 背景与目标

> 执行边界：本 PRD 不复制一套成员专属压缩器。事件章节、叙事记忆合并、内容 hash、向量同步、异常回退和 scope 删除复用 [`PRD-MEM-2-事件型长期记忆与压缩去重.md`](./PRD-MEM-2-事件型长期记忆与压缩去重.md)；本 PRD 只增加 IM 群消息的成员归因、成员校验和派生分发。

`PRD-IM-3` 已经为 `platform-user`（群成员）作用域实现了 `profile.json`/`pattern.json`/`summary.json`，但**没有 `daily.md`/`memory.md`**——群成员目前只有画像、行为模式和一句话状态快照，没有逐日流水，也没有长期叙述性记忆。

对照之下，`group` 作用域有完整的 `daily.md → memory.md` 压缩链路（`GROUP_DAILY_COMPACT_AT=1000` 触发，压缩后 `GROUP_DAILY_KEEP_RECENT=500` 条）。群本身能沉淀"这个群长期发生了什么"，但群里的个人沉淀不下来。

按 `platform-user` 独立跑一套 `daily` 累积 + 压缩（复刻 owner/group 的模式）会让 LLM 调用量随群成员数线性增长——一个 50 人的活跃群，每次该压缩时要额外起 50 次调用，不划算，也偏离 IM-3 §6.1"复用引擎、不复用策略"里"不为每个群/成员复制一套完整反思循环"的方向。

### 1.1 目标

1. 群 daily 压缩时，**同一次 LLM 调用**里让模型按 `platform_user_id` 顺带拆出"这个批次里这个人身上发生的、值得长期记住的事"，作为群压缩的副产物写入对应成员的 `memory.md`。
2. 只给这批次里**确实有实质内容**的成员写；沉默或只有寒暄的成员不生成条目。
3. 成员 `memory.md` 与群 `memory.md` 物理隔离，各自可独立读取、删除、审计，符合 IM-3 的 scope 隔离原则。
4. 把群压缩的触发阈值从 1000/500 调低到 500/300，让活跃群和活跃成员的长期记忆更新节奏更合理（不必等到攒够 1000 条群消息）。
5. 成员现有的 `profile.json`/`pattern.json`/`summary.json` 逐条实时反思路径完全不变。

### 1.2 非目标

- 不给 `platform-user` 新增独立的 `daily.md`——成员没有自己的每日流水，`memory.md` 的唯一来源是群压缩批次，不是成员自己的消息累积。
- 不改变 `profile.json`/`pattern.json`/`summary.json` 的写入时机、触发条件或内容边界（仍由现有逐条反思维护）。
- 不对每个群成员单独起 LLM 调用；一次群压缩只允许一次结构化调用产出所有成员的增量。
- 不改变 owner 记忆的任何行为，也不改变 group `profile.json`/`summary.json`/`daily.md` 的既有写入规则，只扩展 `_compact_group_daily` 的输出 schema 和分发逻辑。
- 不追溯历史——阈值调整和新逻辑只影响调整后新触发的压缩批次，不回填过去已经压缩掉的 daily。

## 2. 设计

### 2.1 触发路径（复用现有入口，不新增触发时机）

沿用 IM-3 §5.1/5.3 已冻结的群压缩触发条件（1 小时活跃窗口整理 / 15 分钟空闲收束 / 每小时补偿扫描），只改两处：

- `GROUP_DAILY_COMPACT_AT`：1000 → 500
- `GROUP_DAILY_KEEP_RECENT`：500 → 300
- `GROUP_DAILY_HARD_CAP`：1200 → 600（维持跟 compact_at 的比例，压缩失败时的安全上限同步收窄，避免长期停留在过大的未压缩窗口）

### 2.2 一次调用、双重产出

`_compact_group_daily` 现有的 LLM 调用只产出 `{"memory": "更新后的群长期记忆全文"}`。扩展为同时产出成员级增量：

```json
{
  "memory": "更新后的群长期记忆全文",
  "member_memory_add": [
    {"platform_user_id": "...", "text": "..."},
    {"platform_user_id": "...", "text": "..."}
  ]
}
```

- `member_memory_add` 只列这批次里**有实质内容**的成员；没有可记内容的成员不出现在数组里（不是给个空字符串占位）。
- prompt 明确要求"划水/附和/无实质内容的成员不要输出"，避免为凑数硬编一条。
- `text` 遵循 IM-3 §5.3/5.4 的信息类型边界——只能是该成员**本人明确表达或可直接观察到的行为**，不能是"其他成员对他的评价"或从昵称/语气推断的内容。
- 每个 `platform_user_id` 在数组里最多出现一次（同批次多条要求模型合并成一条）。

### 2.3 分发写入

压缩成功后，对 `member_memory_add` 里的每一项：

1. 校验 `platform_user_id` 属于当前群 `members.json` 里已知的成员（防止模型幻觉出不存在的 ID，或把内部标记误当成 ID 写出来）。
2. 构造该成员的 `MemoryScope(scope_type="platform-user")`，追加写入其 `memory.md`（新文件，首次写入即创建）。
3. 写入方式复用 `compress.py` 的"整理后覆盖式写入 + 保留历史脉络"原则，而不是简单 `append`——每次群压缩产出的是"这批次的增量"，需要与该成员已有 `memory.md` 合并后再整体写回（避免无限追加、可以合并重复/过时内容），合并逻辑复用 `store.py` 现有的 profile/pattern 合并模式，但作用对象是叙述性文本，参考 `compress.py::compact` 里"已有长期记忆 + 新批次 → 整理后的完整长期记忆"的处理方式。
4. 单个成员写入失败不影响群 `memory.md` 的写入和其他成员的写入；失败的成员本批次的增量丢弃（不重试、不阻塞群压缩主流程），下次群压缩批次里如果这个人还有新内容，会在新批次里重新体现。

### 2.4 为什么不拆成员单独调用

- 成本：调用量从 1 次变成 1+N 次（N = 本批次有发言的成员数），群越活跃越贵。
- 一致性：拆开调用容易在"群里同一件事，两个人各自的版本对不上"——比如一次协作决定，成员 A 和成员 B 的 `memory.md` 各自复述一遍，措辞、细节可能不一致。同一次调用里模型能看到完整群上下文，分拆写出的各人版本天然互相印证。
- 代价：需要把 prompt 从"整理群记忆"扩成"整理群记忆 + 按人拆分"，schema 更复杂，`max_tokens` 需要相应上调；这是唯一的额外成本，可接受。

## 3. 文件与代码改动范围

```text
backend/agent/memory/
├── im_reflection.py
│   ├── GROUP_DAILY_COMPACT_AT / KEEP_RECENT / HARD_CAP   # 改数值
│   └── _compact_group_daily(...)                          # 扩展 LLM 调用 schema + 分发写入逻辑（新增）
└── prompts/im/
    └── group_compress.md                                  # 扩展 prompt：要求同时产出 member_memory_add
```

不新增文件、不新增 Redis key、不新增反思任务类型——成员 `memory.md` 的写入完全挂在群压缩这一次任务的收尾步骤里，复用现有的 `memory:reflection` 队列和 scope 锁模型，不需要新的触发器或 worker 逻辑。

`scoped_store.py`（IM-3 已有）需要确认支持对 `platform-user` scope 的 `memory.md` 做"读现有内容 + 合并 + 整体写回"，如果目前只针对 `group`/`owner` 场景实现过这个模式，需要补齐通用性（不是新概念，是把已有的读-合并-写模式对 `platform-user` scope 也打开）。

### 3.1 与 MEM-2 的实现衔接

IM-11 实施时应调用 MEM-2 提供的公共事件记忆能力，而不是在 `im_reflection.py` 内重新实现一套文本合并逻辑：

| 能力 | 归属 | IM-11 用法 |
|---|---|---|
| 事件章节解析/规范化 | MEM-2 | 校验 `member_memory_add.text` 是否为事件型内容 |
| 现有 memory + 增量合并 | MEM-2 | 对每个成员整体写回 `memory.md` |
| hash、去重、冲突修正 | MEM-2 | 防止同一群压缩批次重复写入成员事件 |
| 向量同步和旧块 GC | MEM-2 | 成员 memory 写入成功后增量同步 |
| 成员归因、成员名单校验 | IM-11 | 过滤非法或不属于当前群的 `platform_user_id` |
| 群/成员失败隔离 | IM-11 | 成员写入失败不回滚群 memory |

当前实现盘点显示，`platform-user` scope 仍只有 `profile.json`、`pattern.json`、`summary.json`，因此 Phase 0 必须先补齐 scope 文件契约，再进入一次调用双重产出。

## 4. 风险与决策

| 风险 | 决策 |
|---|---|
| 模型在一次调用里要同时产出群叙述 + 按人拆分，任务变复杂，可能拉低单项质量 | prompt 明确分两段结构化要求；如果实测质量不稳定，可退回"先出群 memory，成员部分留空数组"的降级路径，不阻塞群记忆本身 |
| 模型幻觉出不存在的 `platform_user_id`，或把不该写的内容归到某个人身上 | 写入前用 `members.json` 校验 `platform_user_id` 存在；归因错误目前只能靠 prompt 约束 + 抽样人工验收降低概率，不做强保证 |
| 成员 `memory.md` 更新节奏完全依赖群压缩触发，活跃度低的群，成员记忆也更新慢 | 阈值调到 500/300 后节奏应明显快于现状（1000/500）；如果验收后仍觉得慢，后续可以单独讨论要不要给 `platform-user` 补一条独立触发路径，但不在本次范围内 |
| 一次调用产出体积变大，`max_tokens` 不够导致截断/解析失败 | 沿用现有 `compress.py` 的截断防护思路（IM-3 §5.6 群压缩上限 15000 tokens），成员部分预留额外配额，具体数值实现阶段实测调整 |
| 成员退出群/群解散后，其 `memory.md` 的清理边界 | 复用 IM-3 §2.3.5/§7 的 tombstone 两阶段删除，`platform-user` scope 的删除范围本来就包含 `memory.md`（哪怕之前从未写入过），不需要新增删除逻辑 |

## 5. 实施阶段（未开始）

### Phase 0：设计确认
- [ ] 确认本 PRD 的调用方式（一次调用双重产出）、阈值改动（500/300/600）和归因校验策略。
- [ ] 以前置 `PRD-MEM-2` Phase 0–1 的事件章节和公共写入契约为准，确认 `scoped_store.py` 对 `platform-user` scope 的 `memory.md` 读-合并-写路径；当前代码尚未具备，需先补齐。
- [ ] 确认成员事件只允许当前群消息作为来源，不能从 group profile、members.json 或他人评价反推。

### Phase 1：Prompt 与调用扩展
- [ ] 扩展 `prompts/im/group_compress.md`，要求输出 `member_memory_add`。
- [ ] `_compact_group_daily` 解析新字段，按 `platform_user_id` 校验后调用 MEM-2 公共事件写入器逐一合并写入。
- [ ] 调整 `GROUP_DAILY_COMPACT_AT/KEEP_RECENT/HARD_CAP` 为 500/300/600。
- [ ] 成员 memory 写入成功后复用 MEM-2 的 hash/向量同步；不得新增一套 IM 专属向量缓存协议。

### Phase 2：验收
- [ ] 单测：`member_memory_add` 为空数组时不产生任何成员写入；非法/不存在的 `platform_user_id` 被过滤；单个成员写入失败不影响群 memory 和其他成员。
- [ ] devserver 真实群人工验收：找一个有多人参与的活跃群批次，压缩后检查群 `memory.md` 和涉及成员的 `memory.md` 内容是否对得上、没有错误归因。
- [ ] 确认阈值调整后压缩频率符合预期，且不会因为更频繁触发而明显推高 LLM 调用成本。

## 6. 验收清单

- [ ] 群压缩只发生一次 LLM 调用，不随成员数增加调用次数。
- [ ] 没有实质内容的成员不产生 `memory.md` 写入（不生成空文件、不生成占位内容）。
- [ ] 成员 `memory.md` 内容只包含该成员本人明确表达或可直接观察到的内容，不包含他人评价或推断性内容。
- [ ] 成员 `memory.md` 写入失败不影响群 `memory.md` 的正常写入。
- [ ] 群/成员记忆各自独立，删除一方不影响另一方；成员退出/群解散的清理路径无需新增代码即可覆盖 `memory.md`。
- [ ] 阈值调整后，压缩触发频率明显快于调整前（1000/500 → 500/300）。

## 7. 与 MEM-2 的关系

两份 PRD 可以在同一开发周期推进，但不合并文档和职责：

```text
PRD-MEM-2：事件型长期记忆公共底座
  ├── owner memory.md
  ├── group memory.md
  └── platform-user memory.md

PRD-IM-11：群压缩派生成员事件记忆
  └── 复用 MEM-2 的事件合并、去重、hash、向量和删除能力
```

推荐顺序为：MEM-2 Phase 0–3 → IM-11 Phase 0–1 → 两份 PRD 各自的测试和 devserver 验收。IM-11 的 500/300/600 阈值调整应放在公共事件写入契约完成后执行，避免先增加压缩调用却无法保证成员记忆质量。
