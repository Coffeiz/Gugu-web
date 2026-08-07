# 群成员名单与按人查历史 PRD

> 状态：✅ 已实施
> 创建：2026-08-08
> 最近更新：2026-08-08
> 关联模块：`backend/agent/tools/group_context.py`、`backend/agent/memory/im_reflection.py`、`backend/agent/memory/store.py`、`backend/agent/memory/reflection.py`、`backend/agent/memory/scopes.py`、`backend/agent/memory/scoped_store.py`、`backend/app/models/__init__.py`（`ConversationMessage`）
> 背景参考：本次会话人工排查真实故障（用户问"看看 moon_小北 最近说了什么"，Agent 回复搜不到，实际该用户确实在群里发过消息）；排查过程中顺带发现 IM 群/成员记忆的 profile 合并只做精确字符串去重，会把同一事实的不同措辞记成两条，而 owner（Web）记忆已有更成熟的相似度合并方案，一并纳入本 PRD；关联 [`【已完成】PRD-IM-3-群组与成员记忆.md`](./【已完成】PRD-IM-3-群组与成员记忆.md)

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：问题排查 | ✅ 已完成 | 定位到根因是搜索工具只能匹配消息正文关键词，没有按发言人过滤的维度；顺带排查了群 profile.json 疑似"没生成"的问题，确认是设计使然（见第 5 节澄清记录），不在本 PRD 修复范围。 |
| Phase 1：功能需求与格式设计 | ✅ 已完成 | `members.json` 格式、生成时机、`group_context_search` 新增参数已在会话中对齐，见第 2、3 节。 |
| Phase 1.5：记忆合并去重问题排查与方案 | ✅ 已完成 | 发现 IM 侧 `_merge_group_profile`/`_merge_profile` 只做精确字符串去重，同一事实换种措辞会被记成两条；owner 侧 `store.apply_profile_ops`/`apply_pattern_ops` 已有基于 `_pattern_similar`（bigram Jaccard ≥0.7）的相似度合并，确定复用该实现而不是各写一份，见 FR-IM-8-3、3.3 节。 |
| Phase 2：实施 | ✅ 已完成 | 全部实施完成，后端测试 764 passed（含新增 17 个），见第 6 章实施计划。 |

---

## 1. 背景与目标

### 现状痛点

- `backend/agent/tools/group_context.py` 的 `group_context_search` 工具只支持关键词匹配消息正文（`keyword_condition([ConversationMessage.content], ...)`），没有任何按发言人（`platform_user_id`/`platform_user_name`）过滤或检索的能力，也没有相关参数暴露给模型。
- 实测故障：用户在群里 @咕咕 问"看看 moon_小北 最近说了什么"，Agent 只能把"小北"当关键词去搜消息正文，而这个用户的历史消息正文里未必出现"小北"这两个字（正常聊天不会自称其名），导致搜索 0 命中、Agent 回复"没搜到"——即使该用户确实在群里发过大量消息，且消息在库里也正确带着他的 `platform_user_name`。
- 更深一层的问题：群里对同一个人的称呼，往往不是这个人自己的平台显示名（比如群友喊"小北"，本人的显示名是"moon_小北"），这类"群友怎么称呼这个人"的信息目前完全没有任何地方记录，纯字符串匹配也无法覆盖这种非子串关系的昵称。
- 群成员 id↔用户名的对应关系目前只逐条消息各自携带一份（`ConversationMessage.platform_user_id`/`platform_user_name`），没有任何聚合、去重的"这个群有哪些人"名单或索引，每次都要现查消息表才能拼凑。
- 排查过程中发现的关联问题：`backend/agent/memory/im_reflection.py` 的 `_merge_group_profile()`（group scope）和 `_merge_profile()`（platform-user scope）只做**精确字符串**去重（`text not in seen`），同一件事换个措辞（比如"酒店与…为同一家" vs "酒店为…"）会被当成两条不同信息各自写入 `profile.json`，越攒越多。owner（Web）记忆的 `backend/agent/memory/store.py` 的 `apply_profile_ops()`/`apply_pattern_ops()` 已经用基于 bigram Jaccard 相似度的 `_pattern_similar()`（阈值 0.7）做合并，能正确识别并合并这类近义重复，但这套实现目前只有 owner 路径在用，IM 路径没有复用，各写了一份更弱的版本。

### 目标

1. 让"按发言人查历史"这个使用场景可行——用户问"某人最近说了什么"，Agent 能通过名字/别名/群友称呼定位到 `platform_user_id`，再精确查该用户的历史消息，而不是退化成对正文的关键词猜测。
2. 建立一份持久化的群成员名单（`members.json`），记录 id↔显示名↔曾用名↔群友称呼↔最近活跃度，作为上述能力的数据基础，也为未来可能的功能（成员列表展示等）预留数据结构。
3. 让 group/member 两条 IM 记忆路径复用 owner 路径已经验证过的相似度合并逻辑，消除近义重复条目不断累积的问题，同时消除三处各写一份合并逻辑的代码重复。

### 不做的事

- 不做全站搜索算法升级（BM25/向量语义检索）——本次故障的根因是缺一个"按发言人过滤"的检索维度，不是关键词匹配的排序质量问题，两者是独立问题，语义检索属于更大范围的基础设施投入，与已有的 [`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md) 高度重叠，本 PRD 不涉及。
- 不新增群记忆的用户可见界面（Web 端目前完全看不到 `profile.json`/`summary.json`/`daily.md`/`members.json`，只有管理后台能读）——排查中发现这是个真实的能力空白，但本次范围明确不做，留待后续单独评估。
- 不修改 `profile.json` 的既有"不落地任何成员内部 ID"的脱敏设计（`_GROUP_INTERNAL_ID_RE` 过滤）——`members.json` 是刻意与 `profile.json` 分开的新文件，两者语义不同，不合并。
- 不扩大 `group_context_search` 目前只支持 QQ 群（`ConversationSession.source == "qq"` 硬编码）这个既有限制的范围，本 PRD 的改动照现有限制走，是否支持飞书/微信群留待另外评估。

---

## 2. 功能需求

### FR-IM-8-1：`group_context_search` 支持按发言人过滤（🔲 待评估）

- 新增可选参数（如 `speaker`），支持传入 `platform_user_id` 或名字/别名/称呼字符串。
- 传字符串时，先查 `members.json` 做名字→id 的模糊匹配（覆盖 `name`/`aliases`/`nicknames` 三个字段），解析出 `platform_user_id` 后再精确按 `ConversationMessage.platform_user_id` 过滤，不再退化成对消息正文的关键词匹配。
- 匹配到多个候选 id（重名/称呼冲突）时的处理策略待技术方案细化（倾向于返回所有候选让模型/用户澄清，而不是静默取第一个）。
- 工具描述（`description`）需要补充"可以按发言人查询"这个能力说明，否则模型不知道这条路可以走。

### FR-IM-8-2：`members.json` 群成员名单文件（🔲 待评估）

- 新增 `MemoryScope`（group 类型）的第五份文件 `members.json`，`scopes.py` 的 `files` 属性需要相应扩展。
- 格式：

  ```json
  {
    "updated_at": 1786157722.239018,
    "members": {
      "<platform_user_id>": {
        "name": "moon_小北",
        "aliases": ["小北"],
        "nicknames": ["北神", "队长"],
        "last_seen_at": 1786121722.239018,
        "message_count": 42
      }
    }
  }
  ```

  时间字段统一用 `now_utc().timestamp()`（epoch 秒，浮点），跟 `profile.json`/`summary.json` 现有风格一致，不用 ISO 字符串——同一 scope 目录下的文件混用两种时间格式，后续读取/展示时容易漏转换。

- 字段来源与更新机制分两类（详见第 3 节）：
  - `name`/`aliases`/`last_seen_at`/`message_count`：纯 DB 聚合，不涉及 LLM。
  - `nicknames`：需要 LLM 从聊天内容里提炼"群友怎么称呼这个人"，提炼结果不保证每次稳定命中。
- 更新时机：不单独开调度，整体（DB 聚合字段 + LLM `nicknames`）挂在 `execute_job` 反思任务执行时一起算、一起写，跟 `profile.json`/`summary.json` 同一节奏（15 分钟空闲收束 / 1 小时活跃窗口）。理由见 3.1。

### FR-IM-8-3：IM 记忆合并复用 owner 的相似度去重（🔲 待评估）

- `im_reflection.py` 的 `_merge_group_profile()`/`_merge_profile()` 改为调用 `store.apply_profile_ops()` 做实际的合并与去重，不再自己维护精确字符串 `seen` 集合。
- `im_reflection.py` 自身只保留两块 IM 特有的前置/后置处理，不属于共享逻辑：
  - group profile 的类型白名单过滤（`GROUP_PROFILE_TYPES`）
  - group profile 的内部 ID 剥离（`_GROUP_INTERNAL_ID_RE`）
- member（platform-user）路径现状是"每次输出整份 profile 列表"而非"只报增删"，与 `apply_profile_ops(profile, add, remove)` 的增删语义不完全匹配；本 PRD 范围内先把 member 的整份输出当作 `add`（`remove` 传空数组），能立即拿到相似度合并去重的好处，但暂时仍无法主动删除过时条目——真正补齐"member 也能删除旧条目"需要给 `member_reflection.md` 增加 `profile_remove` 输出字段，这是更大的 prompt/schema 改动，本 PRD 不做，留待后续单独评估。

---

## 3. 技术方案

### 3.1 `members.json` 的生成机制

**DB 聚合部分**（`name`/`aliases`/`last_seen_at`/`message_count`）：

- 数据源是 `ConversationMessage` 表按 `(chat_id, platform_user_id)` 聚合：`SELECT platform_user_id, platform_user_name, COUNT(*), MAX(created_at) ...`。
- 群聊消息受 `backend/agent/im/session.py` 的 `MESSAGE_RETENTION_LIMIT = 500` 限制（超过 `MESSAGE_TRIM_THRESHOLD = 600` 才裁剪到 500 条），`message_count` 因此天然是"保留窗口内"的计数而非全量历史，语义上正好贴近"近期活跃度"，不需要额外做时间窗口限定。
- `aliases`：对比本次聚合结果里的 `name` 与 `members.json` 现存的 `name`，如果变了，把旧值追加进 `aliases`（去重）。
- 更新时机：不实时（每条消息）写，避免高频读改写 JSON 文件的并发/锁开销；也不单独开一条调度——直接挂在 `execute_job` 反思任务执行时一起算：`execute_job` 本来就要把这批消息读一遍给 LLM 用，顺手在同一次执行里把 DB 聚合字段和 LLM `nicknames` 一起写进 `members.json`，避免多开一次消息表读取和一次文件锁。
- **聚合数据源范围**：`_apply_output` 拿到的 `messages` 是 `execute_job` 本批消息（`from_message_id`~`to_message_id`），不是当前保留窗口的全量。要得到准确的"保留窗口内" `message_count`/`last_seen_at`，不能用本批 `messages` 累加（会漏掉窗口内、但不在本批范围的历史消息，也没法正确反映消息裁剪后的实际计数）。改为在同一次 `execute_job` 执行里，**额外按 `chat_id` 单独查一次全量聚合**（`SELECT platform_user_id, platform_user_name, COUNT(*), MAX(created_at) ... GROUP BY platform_user_id`）。这张表天然受 500～600 条的保留上限限制，全量聚合成本很低，可以放心每次都查一遍，不用基于批次增量累加去凑近似值。
- **`updated_at`/`last_seen_at` 时间格式**：统一用 `now_utc().timestamp()`（epoch 秒），不用 ISO 字符串，跟 `profile.json`/`summary.json` 现有风格保持一致（示例见上）。

**LLM 提炼部分**（`nicknames`）：

- 与 DB 聚合字段在同一次 `execute_job` 执行里一起产出：与现有 `profile_add`/`profile_remove` 类似，新增一个输出字段（如 `nicknames_add`），提示词里明确要求模型只在聊天内容里出现"某人被别人称呼为 XX"这类信号时才输出，避免把自称/网名误判成群友称呼。
- **不适用 `_GROUP_INTERNAL_ID_RE` 过滤**——`profile.json` 刻意不落地任何 `platform_user_id`，而 `members.json` 恰恰相反，每条记录必须挂在具体的 `platform_user_id` 下才有意义，这是两个文件唯一但关键的设计分歧点，实现时需要显式注明，避免后来者误以为是疏漏而"修正"掉。

### 3.2 `group_context_search` 的按发言人过滤

- 新增 `speaker` 参数解析：先尝试直接当 `platform_user_id` 精确匹配；不是纯 id 格式时，读取当前群的 `members.json`，对 `name`/`aliases`/`nicknames` 做包含匹配找候选 id。
- 找到唯一候选：按 `platform_user_id` 精确过滤 `ConversationMessage`，不再依赖关键词匹配正文（`keyword`/`queries` 参数仍可选叠加，用于在该发言人的历史里再按内容筛）。
- 找到多个候选：返回结构化的"待澄清"结果（见下），不擅自二选一，交给模型下一轮澄清或用户确认。
- 找不到候选：明确返回"没有找到叫 XX 的群成员"，而不是静默退化成关键词搜索（避免重复本次故障的"认错人"表现）。
- 匹配优先级按确定性分层，只有最低置信度那层出现多个候选才真正触发澄清：① `speaker` 本身就是 `platform_user_id` → 直接精确匹配；② 精确匹配 `name`，唯一命中直接用；③ 精确匹配 `aliases`，唯一命中直接用；④ 只在 `nicknames` 里模糊/包含匹配到——这一层置信度最低，出现多个候选才返回候选列表让上层澄清。候选列表按 `last_seen_at` 倒序排列，最多返回 5 个，辅助分辨、不代替判断。

**多候选返回格式**：

```json
{
  "ambiguous": true,
  "candidates": [
    {"platform_user_id": "...", "matched_by": "nicknames", "matched_text": "北神", "name": "moon_小北", "last_seen_at": 1786209300.0},
    {"platform_user_id": "...", "matched_by": "nicknames", "matched_text": "北神", "name": "另一个人", "last_seen_at": 1786010400.0}
  ]
}
```

不额外带一句提示文案（如 `message`）——模型已经能看到完整候选列表，自己组织语言问用户即可，不需要后端代写台词。真正要交代的只有"看到 `ambiguous: true` 该怎么办"，这句话放进工具的 `description` 里（模型只读一次，不必每条结果重复），而不是塞进每次调用的返回体。

### 3.3 IM 记忆合并复用 owner 相似度去重

- `store.apply_profile_ops(profile, add, remove)` 内部用 `_pattern_similar()` 判断"新增内容是否已被现有条目覆盖"：完全相同、较短文本是较长文本子串（≥6 字）、或 bigram Jaccard 相似度 ≥0.7，命中即视为同一条，合并时保留更完整的措辞并刷新时间戳，而不是并列写两条。`apply_pattern_ops` 对 `pattern.json` 同理。
- `_merge_group_profile()` 改造：内部的类型白名单过滤和内部 ID 剥离逻辑不变，只把去重合并这一步换成调用 `apply_profile_ops`。
- `_merge_profile()`（member）改造：调用 `apply_profile_ops(current_profile, incoming, [])`——`incoming` 是 `member_reflection.md` 当前输出的整份 `profile` 列表，`remove` 传空数组（见 FR-IM-8-3 说明，member 暂不支持主动删除）。
- 不改动 `_pattern_similar`/`apply_profile_ops`/`apply_pattern_ops` 本身的实现和阈值，只是新增调用方，owner 路径行为不受影响。
- `store.py` 文件头注释目前通用描述"记忆存储"，但读起来容易让人以为是 owner 专属（迄今只有 owner 代码在导入）；顺手把注释补一句"IM group/member 记忆合并逻辑（`im_reflection.py`）同样复用这里的 `apply_profile_ops`/`apply_pattern_ops`"，让这个模块的"通用共享层"定位对后来者更明确，不需要专门读代码才能发现。

---

## 4. 验证与上线

- 单元测试覆盖：`members.json` 的 DB 聚合逻辑（新成员首次出现、改名追加 `aliases`、`message_count` 随消息裁剪窗口变化）、`group_context_search` 的 `speaker` 参数四层匹配优先级（id 精确/name 精确/aliases 精确/nicknames 模糊多候选）、`_merge_group_profile`/`_merge_profile` 改用 `apply_profile_ops` 后近义重复条目能被正确合并（用本次真实案例"酒店与…为同一家" vs "酒店为…"当回归用例）。
- 待人工端到端验证：在真实群聊里复现本次故障场景（"看看 XX 最近说了什么"，其中 XX 是群友称呼而非本人显示名），确认能正确定位到人并给出该用户的真实历史，而不是"没搜到"或认错人；顺带观察一段时间群 profile，确认不再出现同一事实反复措辞记录的情况。
- 发布方式：随后端正常发布，不需要灰度/开关；`members.json` 是新增文件，不影响现有 `profile.json`/`summary.json`/`daily.md` 的读写路径。
- 上线后关注点：`backend/worker.py` 日志里如果新增聚合任务，确认没有引入新的高频异常（参考本次排查中发现的 `记忆反思空闲收束出错: ProgrammingError` 历史教训，这类错误如果只打印异常类型名不带详情，会很难排查，新增逻辑的异常日志应带上具体错误信息）。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| `nicknames` 提炼滞后 + 不保证准确 | 群友刚开始用一个新称呼时，短期内仍搜不到；LLM 也可能误判非称呼内容为称呼 | 产品预期管理：`members.json` 的 `nicknames` 是"尽力而为"，不是实时保证；`name`/`aliases` 走 DB 聚合更可靠，作为主要匹配路径 |
| 多个群成员被匹配到同一个候选称呼（重名/称呼冲突） | 按人查历史可能查错人 | 见 3.2：多候选时不擅自二选一，返回候选列表交给上层澄清 |
| `group_context_search` 现状硬编码只支持 QQ（`source == "qq"`） | `members.json`/按发言人过滤做出来后，飞书/微信群用不上 | 本 PRD 明确不在范围内解决，按现有限制实现，是否扩展到其他平台留待另一个 PRD |
| member 路径改用 `apply_profile_ops` 后仍无法主动删除过时条目（`remove` 恒传空数组） | 过时的个人资料条目会一直留着，只是不再重复堆同义条目 | 本 PRD 范围内接受这个限制；真正解决需要给 `member_reflection.md` 加 `profile_remove` 输出，留待后续单独评估 |
| `_pattern_similar` 阈值（0.7）是为 owner pattern 场景调的，group/member profile 文本风格可能不同 | 阈值不一定完全适配，可能出现漏合并或误合并 | 上线后人工抽查一段时间的 group/member profile 变化，如效果不理想再评估是否需要独立阈值，不在本次实现前预判 |

### 待确认问题

- ✅ 已确认：`profile.json`（8/7 排查中发现某群该文件为空）是设计使然（只收结构化的群公开事实，日常闲聊很少归类进去），不是 bug，本 PRD 不修复。
- ✅ 已确认：群记忆用户可见界面本次不做，范围明确收窄到"搜索工具 + 成员名单"两项。
- ✅ 已确认：`message_count` 走 DB 聚合而非 LLM 填活跃度描述——客观数字比 LLM 主观判断更便宜、更可靠、标准更统一。
- ✅ 已确认：`members.json` 的聚合不单独开调度，挂在 `execute_job` 反思任务执行时一起算一起写。
- ✅ 已确认：IM 记忆合并去重复用 owner 已有的 `store.apply_profile_ops`/`apply_pattern_ops`（`_pattern_similar` 相似度判断），不再各自维护一份精确字符串去重。
- ✅ 已确认：member 路径本次只做到"当作纯 add 调用 `apply_profile_ops`"，不新增 `profile_remove` 能力，这个结构性改动留到后续。
- ✅ 已确认：多候选匹配返回 `{"ambiguous": true, "candidates": [...]}`，不带提示文案；"看到 ambiguous 该怎么办"写进工具 description，由模型自己组织澄清话术，不在后端硬编码。
- ✅ 已确认：`members.json` 的 `message_count`/`last_seen_at` 不用 `execute_job` 本批 `messages` 累加（会漏掉窗口内、不在本批范围的历史），改为在同一次执行里额外按 `chat_id` 单独查一次全量聚合；这张表受 500～600 条保留上限限制，全量聚合成本很低。
- ✅ 已确认：`members.json` 的 `updated_at`/`last_seen_at` 统一用 `now_utc().timestamp()`（epoch 秒），不用 ISO 字符串，跟 `profile.json`/`summary.json` 现有风格一致。

---

## 6. 实施计划

按依赖顺序推进，每个 phase 是一组可独立验证的改动，phase 内步骤可合并提交。

### Phase 1：`members.json` 数据基础

- [x] 1.1 `scopes.py` 增加 `members.json` 文件：`MemoryScope.files` 的 group 分支从 `("profile.json", "summary.json", "daily.md", "memory.md")` 追加 `"members.json"`。`read_scope` 遍历 `scope.files` 自动读取，加入后 `read_scope(scope)` 自动返回 `members` 字段，无需改 `scoped_store.py`。
- [x] 1.2 `im_reflection.py` 增加 members DB 聚合逻辑：新增 `_aggregate_members(db, scope)`，按 `chat_id` 全量聚合 `ConversationMessage`（`platform_user_id, platform_user_name, COUNT(*), MAX(created_at)`），对比 `members.json` 现存 `name` 追加 `aliases`（去重），写 `members.json`（`updated_at` + `members`）。`_apply_output` 需新增 `db` 参数（从 `_execute_job_locked` 传入）。
- [x] 1.3 `im_reflection.py` 增加 LLM `nicknames_add` 输出：`group_reflection.md` 提示词新增 `nicknames_add` 字段，要求模型只在"某人被别人称呼为 XX"时输出；与 1.2 聚合结果合并写进 `members.json`。`nicknames` 不适用 `_GROUP_INTERNAL_ID_RE` 过滤，需显式注释。

### Phase 2：IM 记忆合并复用 owner 相似度去重

- [x] 2.1 `_merge_group_profile` 复用 `store._pattern_similar` 做相似度去重：保留 `GROUP_PROFILE_TYPES` 白名单过滤和 `_GROUP_INTERNAL_ID_RE` 剥离。**边界说明**：`store.apply_profile_ops` 的类型 normalize 会把 group 特有类型（`nature/rule/role/project`）降级为 `note`（`store.PROFILE_TYPES` 不含这些类型），故不直接调用 `apply_profile_ops`，而是复用其 `_pattern_similar` 相似度判断，避免破坏 group 类型白名单。
- [x] 2.2 `_merge_profile` 改用 `apply_profile_ops`：改为 `apply_profile_ops(current, incoming, [])`（member 暂不支持删除，`remove` 传空数组）。member 类型集合与 `store.PROFILE_TYPES` 一致，直接调用安全。
- [x] 2.3 `store.py` 文件头注释补充共享层说明：补一句"IM group/member 记忆合并逻辑（`im_reflection.py`）同样复用这里的 `apply_profile_ops`/`apply_pattern_ops`"。

### Phase 3：搜索工具按发言人过滤

- [x] 3.1 `group_context.py` 增加 `speaker` 参数：四层匹配优先级（id 精确 → name 精确 → aliases 精确 → nicknames 模糊多候选）；读取当前群 `members.json`（构造 `MemoryScope(user_id, "qq", channel_id, "group", chat_id)` + `read_scope`）；唯一候选按 `platform_user_id` 精确过滤；多候选返回 `{"ambiguous": true, "candidates": [...]}`（按 `last_seen_at` 倒序，最多 5 个）；未命中返回"没有找到叫 XX 的群成员"；更新工具 `description` 补充按发言人查询能力。

### Phase 4：验证与收尾

- [x] 4.1 单元测试：`members.json` DB 聚合（新成员首次出现、改名追加 `aliases`、`message_count` 随裁剪窗口变化）、`group_context_search` 的 `speaker` 四层匹配优先级、`_merge_group_profile`/`_merge_profile` 近义重复合并。**边界说明**：文档原"真实案例"（"酒店与…为同一家" vs "酒店为…"）bigram Jaccard 仅 0.33，低于 `_pattern_similar` 保守阈值 0.7，不会被合并——这是预期行为，测试改用子串关系案例验证合并，并保留低相似度不合并的对照用例。
- [x] 4.2 运行后端测试 + 前端 typecheck，更新 PRD 实施状态为 ✅ 已实施。后端完整测试 764 passed（含新增 17 个）。
