# 群成员名单与按人查历史 PRD

> 状态：✅ 已实施（含 Phase 2.5/2.6/2.7/2.9/2.10 架构修订）
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
| Phase 2.5：真实场景验证发现的架构缺口 | ✅ 已完成 | 上线后实测：`speaker` 四层匹配全部依赖 `members.json`，但该文件只在 `execute_job` 反思任务时才更新（挂 15 分钟空闲收束），导致刚部署、群还没"闲下来"触发过反思时，即使目标用户的 `platform_user_id`/`platform_user_name` 早就在 `ConversationMessage` 里，也查不到——这个信息 Web 端会话列表能实时看到，`speaker` 搜索却因为绑死 `members.json` 而滞后。见 FR-IM-8-1、3.2 节修订（跟第 6 章实施清单的 "Phase 3" 编号无关，那是另一套独立编号）。 |
| Phase 2.6：speaker 名字匹配收窄漏洞 | ✅ 已完成 | Phase 2.5 把①②层改成实时查表后，②层还是"精确相等"匹配——实测复现：群友喊"小北"称呼平台显示名"moon_小北"的成员，精确匹配查不到，这正是本 PRD 最初排查的真实故障场景，Phase 2.5 只解决了"数据够不够新"，没解决"匹配够不够松"。改成 `speaker` 与历史 `platform_user_name` 互为包含（谁包含谁都算，精确相等是特例），见 FR-IM-8-1、3.2 节最新描述。 |
| Phase 2.7：members.json 写入与 LLM 反思调用解耦 | ✅ 已完成 | 实测另一个真实故障：某群反思任务因 LLM 返回 500（`anthropic.InternalServerError`，报文显示是内容审核拦截，非基础设施故障）连续失败，`_apply_output` 从未被调用，导致 `members.json` 的 `name`/`aliases`/`last_seen_at`/`message_count`——这几个纯 DB 聚合、本不需要 LLM 参与的字段——也跟着被卡住不更新。把这部分聚合和写入移到 `complete_json` 调用之前、独立 try/except，不再受 LLM 调用成败影响；`nicknames`（唯一真正需要 LLM 的字段）仍然只在拿到结果时才合并写入。见 FR-IM-8-2、3.1 节修订。 |
| Phase 2.8：Code Review 发现的 4 个问题（合并前修复） | ✅ 已完成 | 外部 code review 定位到 4 个真实 bug（均已核实）：① `members.json` 被无意中整份塞进每次群反思 LLM prompt（`current` 在写完 members.json 后读出，直接 `json.dumps` 进 `user`），群越大 token 越多、越容易再撞审核拦截；② `aliases` 字段此前完全没被 `_resolve_speaker` 用到，改名后旧消息一旦被 500~600 条保留窗口裁掉就再也查不到人（"上线几天后才坏"的典型模式）；③ `members.json` 聚合失败被 `except Exception: pass` 完全静默，持续性故障（schema/SQL/OSS 权限）会永久停更且无法排查——恰恰是本 PRD 诞生的原因；④ `_aggregate_members` 排序没有 `id` 兜底，同一 `created_at` 时行序不确定，"最新名字"的判定可能不稳。四个都已修复，见 FR-IM-8-1（新增 aliases 层）、3.1/3.4 节。 |
| Phase 2.9：Code Review 复审发现的 2 个数据生命周期问题（合并前修复） | ✅ 已完成 | 复审 Phase 2.8 修复后又发现 2 个新问题：① `members.json` 不是真正的持久名单——`_merge_members` 只保留本轮 `_aggregate_members` 还能看到的成员，成员一旦沉默太久、消息被 500~600 条保留窗口裁掉，会连人带 aliases/nicknames 一起从 `members.json` 消失（这些字段本来就是为了"退出窗口后依然能查到人"设计的，结果反而在人本身被裁出窗口时先丢了）；② `_resolve_speaker` 的"唯一名字模糊匹配立即返回"可能压过更强的精确 alias/nickname 匹配，导致静默查错人而非触发 ambiguous（比"多个候选"更危险）。两个都已修复，见 FR-IM-8-1（匹配顺序改成"先精确后模糊、来源合并判断"）、3.1 节（`_merge_members` 保留沉默成员）。 |
| Phase 2.10：Code Review 二次复审发现的 1 个 P2 性能问题（合并前修复） | ✅ 已完成 | Phase 2.9 为保证 exact alias/nickname 能参与判断，改成除 `platform_user_id` 精确命中外都无条件 `load_members()`，而 `_load_members()` 底层调的是 `read_scope(scope)`——group scope 有 `profile.json`/`summary.json`/`daily.md`/`memory.md`/`members.json` 五个文件，`read_scope()` 会把全部五个都读一遍，等于按发言人查询这条已经进了热路径的调用，每次都要多读 4 个完全用不到的文件（OSS 后端是额外的网络请求）。修复：给 `scoped_store.py` 新增 `read_scope_json(scope, filename)` 只读单个 JSON 文件，`_load_members()` 改用它只读 `members.json`。见 3.2 节。 |

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

### FR-IM-8-1：`group_context_search` 支持按发言人过滤（✅ 已完成，含 Phase 2.5/2.6/2.8/2.9 修订）

- 新增可选参数（如 `speaker`），支持传入 `platform_user_id` 或名字/曾用名/群友称呼字符串。
- **匹配层级（Phase 2.9 修订：按"匹配强度"分两级，级内合并三个来源；只有①层不读 `members.json`）**：
  1. `speaker` 本身就是 `platform_user_id` → 直接精确匹配，不查表、不读 `members.json`。
  2. **精确匹配（相等）**：合并三个来源一起判断——实时 `ConversationMessage` 的 `platform_user_name`、`members.json` 的 `aliases`（曾用名）、`members.json` 的 `nicknames`（群友称呼），任一来源里 `speaker` 与某个值**精确相等**都算命中；唯一命中直接用，多个来源/多个人精确命中同一个词才算 ambiguous。
  3. **模糊匹配（互为包含）**：②层三个来源都没有精确命中，才退回模糊匹配——同样合并三个来源，`speaker in value or value in speaker` 任一方向即算命中。
- 除①外都需要读一次 `members.json`（②③ 共用同一次加载，`load_members` 是 async 回调）。
- 只有②③层出现多个候选才触发澄清（见 3.2）。
- 工具描述（`description`）需要补充"可以按发言人查询"这个能力说明，否则模型不知道这条路可以走。

**Phase 2.5 修订的动机**：原方案把 id/name/曾用名三层匹配也一起绑在 `members.json` 上，而 `members.json` 只在反思任务（`execute_job`）执行时才更新，天然滞后（挂 15 分钟空闲收束/1 小时活跃窗口）。上线后实测：群还没触发过一次反思任务时，即使目标用户的消息早就在数据库里、`platform_user_name` 也一直对得上，`speaker` 查询依然因为 `members.json` 是空的而返回"没有找到"——但这类信息本可以实时查到（Web 端会话列表就是实时的），不该被反思任务的节奏拖累。只有"群友称呼"这个信息，因为压根不存在于数据库任何字段里、只能靠 LLM 提炼，才必须依赖 `members.json` 并接受这个滞后。

**Phase 2.6 修订的动机**：Phase 2.5 上线后用本 PRD 最初的真实故障场景复测，发现②层"精确相等"仍然查不到——"小北"不精确等于"moon_小北"。Phase 2.5 解决的是"数据够不够新"（实时查表 vs 等反思任务），没解决"匹配够不够松"（精确 vs 包含），是两个独立维度的问题，改完 2.5 才暴露出 2.6 还没修。改成互为包含匹配后，本 PRD 开头那个真实案例才算真正修复。

**Phase 2.8 修订的动机**：外部 code review 指出，PR 描述里写的"四层：id → name → aliases → nicknames"跟实际代码不符——`_resolve_speaker` 当时只有三层，`aliases` 字段虽然被 `_merge_members` 正确维护（改名时追加旧值），却从没被读取过，是彻底的 write-only 状态。问题会在"改名后、旧消息还没被裁出保留窗口"这段时间被掩盖（②层还查得到），等旧消息被裁掉才会暴露成"查不到"——典型的上线几天后才坏的问题，必须补上。

**Phase 2.9 修订的动机**：Phase 2.8 把 `aliases` 接了进去，但沿用的还是"按来源分层、层内不分强度"的结构——②层（实时名字）只要唯一命中就直接 `return`，根本不会往下看 `members.json` 里是否存在更强的精确 `aliases`/`nicknames` 匹配。外部 code review 复审指出一个真实场景：A 的曾用名精确等于"小北"，B 的当前群昵称是"小北哥"（只是模糊包含"小北"）；用户问"小北说了什么"，旧实现②层模糊匹配"小北" in "小北哥" 唯一命中，直接把这次查询判给 B，A 的精确 `aliases` 根本没有参与判断的机会——这不是 ambiguous（好歹会提示用户澄清），而是更危险的**静默查错人**。修法是把"匹配强度"（精确 > 模糊）和"匹配来源"（name/aliases/nicknames）拆成两个维度：先合并三个来源做一轮精确匹配判断，全都没有命中才退回模糊匹配，任何一级内部出现多个命中都走 ambiguous，不再有"某个来源的模糊命中可以绕过另一个来源的精确命中直接 return"的情况。代价是②③层不再能像 Phase 2.8 那样"只有查不到实时名字才读 members.json"——精确匹配判断本身就需要 `aliases`/`nicknames` 参与比较，所以除①层（id 精确匹配）外都会无条件读一次 `members.json`，这是为正确性做的必要取舍。

### FR-IM-8-2：`members.json` 群成员名单文件（✅ 已完成）

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

- 字段来源与更新机制分两类，**两者读写路径完全独立**（详见第 3 节，Phase 2.7 修订）：
  - `name`/`aliases`/`last_seen_at`/`message_count`：纯 DB 聚合，不涉及 LLM，在 `execute_job` 里、调用 LLM **之前**独立执行、独立写入，不受本轮 LLM 调用成败影响。
  - `nicknames`：需要 LLM 从聊天内容里提炼"群友怎么称呼这个人"，只有 LLM 调用**成功**且返回内容时才合并写入，提炼结果不保证每次稳定命中。
- 更新时机：不单独开调度，都挂在 `execute_job` 反思任务执行时机上，跟 `profile.json`/`summary.json` 同一节奏（15 分钟空闲收束 / 1 小时活跃窗口）——但节奏相同不代表耦合，见 Phase 2.7。
- **Phase 2.5 修订后的定位**：`name`/`aliases`/`last_seen_at`/`message_count` 这几个字段**不再是 `speaker` 搜索的必经路径**（搜索改走实时查询，见 FR-IM-8-1），继续保留在 `members.json` 里是为了未来可能的成员名单展示等场景（原目标 2 不变）；`nicknames` 仍然只有这一条路径，是 `members.json` 存在的核心理由。
- **Phase 2.7 修订的动机**：实测发现某群反思任务因 LLM 返回 500（`anthropic.InternalServerError`，报文 `input new_sensitive`，实为内容审核拦截而非基础设施故障）连续失败，导致 `_apply_output` 从未被调用——而 DB 聚合字段的写入原来正是挂在 `_apply_output` 里，跟着 LLM 调用一起卡死，即使这几个字段本来跟这次 LLM 调用毫无关系。这与 Phase 2.5 是同一类问题在"写"这一侧的重现（Phase 2.5 解决的是"读"这一侧的耦合），修法是把 DB 聚合部分挪到 LLM 调用之前独立执行（见 3.1），`nicknames` 才保留在 LLM 成功之后合并。

### FR-IM-8-3：IM 记忆合并复用 owner 的相似度去重（✅ 已完成）

- `im_reflection.py` 的 `_merge_group_profile()`/`_merge_profile()` 改为调用 `store.apply_profile_ops()` 做实际的合并与去重，不再自己维护精确字符串 `seen` 集合。
- `im_reflection.py` 自身只保留两块 IM 特有的前置/后置处理，不属于共享逻辑：
  - group profile 的类型白名单过滤（`GROUP_PROFILE_TYPES`）
  - group profile 的内部 ID 剥离（`_GROUP_INTERNAL_ID_RE`）
- member（platform-user）路径现状是"每次输出整份 profile 列表"而非"只报增删"，与 `apply_profile_ops(profile, add, remove)` 的增删语义不完全匹配；本 PRD 范围内先把 member 的整份输出当作 `add`（`remove` 传空数组），能立即拿到相似度合并去重的好处，但暂时仍无法主动删除过时条目——真正补齐"member 也能删除旧条目"需要给 `member_reflection.md` 增加 `profile_remove` 输出字段，这是更大的 prompt/schema 改动，本 PRD 不做，留待后续单独评估。

---

## 3. 技术方案

### 3.1 `members.json` 的生成机制

**DB 聚合部分**（`name`/`aliases`/`last_seen_at`/`message_count`）：

- 数据源是 `ConversationMessage` 表按 `chat_id` 取原始行（`platform_user_id`/`platform_user_name`/`created_at`），**不用 SQL `GROUP BY (platform_user_id, platform_user_name)`**——按时间顺序在 Python 里逐行累加 `message_count`、更新 `name`/`last_seen_at`。这不是随手选的实现方式：实测过按 `(platform_user_id, platform_user_name)` 联合分组的写法，成员在保留窗口内改过一次群昵称就会拆成两行，逐行覆盖写只留下其中一行，`message_count` 被腰斩、`name` 还可能停在旧昵称上——已经在测试里加了改名场景的回归用例（`test_aggregate_members_rename_within_window_does_not_split_count`）。
- 群聊消息受 `backend/agent/im/session.py` 的 `MESSAGE_RETENTION_LIMIT = 500` 限制（超过 `MESSAGE_TRIM_THRESHOLD = 600` 才裁剪到 500 条），`message_count` 因此天然是"保留窗口内"的计数而非全量历史，语义上正好贴近"近期活跃度"，不需要额外做时间窗口限定；这张表体量小，全量取一遍、在 Python 里聚合的开销可以忽略。
- `aliases`：对比本次聚合结果里的 `name` 与 `members.json` 现存的 `name`，如果变了，把旧值追加进 `aliases`（去重）。
- **写入时机（Phase 2.7 修订）**：在 `_execute_job_locked` 里、**调用 LLM（`complete_json`）之前**独立执行 `_aggregate_members` + `_merge_members` 并写入 `members.json`，包一层 try/except——失败不影响本轮反思继续跑，下次任务执行时会重新聚合一次，不是丢失只是晚一轮。不实时（每条消息）写，避免高频读改写 JSON 文件的并发/锁开销；不单独开调度，复用 `execute_job` 已有的执行节奏。
- **沉默成员不删除（Phase 2.9 修订）**：`_aggregate_members` 只能聚合 `ConversationMessage` **保留窗口**（500~600 条）内还能看到的成员——成员一旦沉默太久、他的消息被裁出窗口，本轮聚合结果里就没有他了。`_merge_members` 早期实现是 `out = {}` 只填聚合结果里出现过的 `pid`，等于把这些沉默成员连人带 `aliases`/`nicknames` 一起从 `members.json` 里删掉了；而这两个字段本来就是为了"消息被裁出窗口后依然能查到人"设计的，结果反而在成员本身被裁出窗口时先丢失，跟 `members.json` 自己"持久成员名单"的定位矛盾。修法：本轮聚合看不到的旧成员原样保留 `name`/`aliases`/`nicknames`/`last_seen_at`，只把 `message_count` 归零（跟"近期活跃度"语义一致——不在窗口内就是没有近期活跃度，但人和曾用名/称呼依然存在）。
  - **为什么必须放在 LLM 调用之前，而不是像最初实现那样放在 `_apply_output` 里**：最初实现把这一步和 `nicknames` 合并写在同一个 `_apply_output` 调用里，而 `_apply_output` 只有在 `complete_json` 成功返回之后才会被执行。实测某群反思任务因 LLM 返回 500（内容审核拦截，见下）连续失败，`_apply_output` 从未运行，这几个纯 DB 字段——本来跟这次 LLM 调用毫无关系——也跟着卡住不更新。挪到 LLM 调用之前、独立包 try/except，就能保证这几个字段的更新完全不受 LLM 调用成败影响。
- **聚合数据源范围**：不能用 `execute_job` 本批 `messages`（`from_message_id`~`to_message_id`）累加（会漏掉窗口内、但不在本批范围的历史消息，也没法正确反映消息裁剪后的实际计数）。改为每次都**额外按 `chat_id` 单独查一次全量**（见上，取原始行不做 SQL 聚合）。
- **`updated_at`/`last_seen_at` 时间格式**：统一用 `now_utc().timestamp()`（epoch 秒），不用 ISO 字符串，跟 `profile.json`/`summary.json` 现有风格保持一致（示例见上）。

**LLM 提炼部分**（`nicknames`）：

- 与现有 `profile_add`/`profile_remove` 类似，新增一个输出字段（`nicknames_add`），提示词里明确要求模型只在聊天内容里出现"某人被别人称呼为 XX"这类信号时才输出，避免把自称/网名误判成群友称呼。
- **写入时机（Phase 2.7 修订）**：只有 `complete_json` 调用**成功返回**且 `nicknames_add` 非空时，才在 `_apply_output` 里重新读一次 `members.json`、用 `_apply_nicknames()` 合并追加、再写回——不重新计算 `name`/`aliases`/`last_seen_at`/`message_count`（那几个字段已经在 LLM 调用之前独立更新过了）。`_merge_members`（纯 DB 合并）和 `_apply_nicknames`（LLM 结果合并）职责严格分开，互不调用。
- **不适用 `_GROUP_INTERNAL_ID_RE` 过滤**——`profile.json` 刻意不落地任何 `platform_user_id`，而 `members.json` 恰恰相反，每条记录必须挂在具体的 `platform_user_id` 下才有意义，这是两个文件唯一但关键的设计分歧点，实现时需要显式注明，避免后来者误以为是疏漏而"修正"掉。

### 3.2 `group_context_search` 的按发言人过滤（Phase 2.5/2.6/2.8/2.9/2.10 修订）

- 新增 `speaker` 参数解析，**按匹配强度分两级（Phase 2.9），除①层外都读 `members.json`**：
  1. `speaker` 本身就是 `platform_user_id` → 直接精确匹配，不查任何表、不读 `members.json`。
  2. **精确匹配（相等）**：合并三个来源一起判断——实时查 `ConversationMessage` 得到的 `platform_user_name`（`SELECT DISTINCT platform_user_id, platform_user_name FROM ... WHERE`，同群、`role='user'`、`platform_user_id IS NOT NULL`，天然覆盖"当前显示名"和"保留窗口内用过的曾用名"）、`members.json` 的 `aliases`、`members.json` 的 `nicknames`；任一来源里存在 `speaker == value` 都算命中。唯一命中直接用；多个命中（哪怕来自不同来源）走 ambiguous——精确匹配内部平级，不按来源分优先级。
  3. **模糊匹配（互为包含，`speaker in value or value in speaker`）**：②层三个来源都没有精确命中，才退回模糊匹配，同样合并三个来源一起判断唯一性/ambiguous。
- 找到唯一候选：按 `platform_user_id` 精确过滤 `ConversationMessage`，不再依赖关键词匹配正文（`keyword`/`queries` 参数仍可选叠加，用于在该发言人的历史里再按内容筛）。
- 找到多个候选：返回结构化的"待澄清"结果（见下），不擅自二选一，交给模型下一轮澄清或用户确认；`matched_by` 字段标出该候选是被 `name`/`aliases`/`nicknames` 中的哪个来源命中的（仅用于展示，不影响判断顺序）。
- 都未命中：明确返回"没有找到叫 XX 的群成员"，而不是静默退化成关键词搜索（避免重复本次故障的"认错人"表现）。
- 候选列表按 `last_seen_at` 倒序排列（优先取 `members.json` 里的值，没有才退回实时查询的时间戳——同一批种子消息时间戳可能完全相同，`members.json` 的值是反思任务全量聚合得出，更适合做稳定排序），最多返回 5 个，辅助分辨、不代替判断。

**为什么不是"先查 `members.json` 兜底，查不到再实时查"**：`members.json` 只应该覆盖它独占的那部分信息（`aliases`/`nicknames` 的内容本身），不该在"数据够不够新"这个维度上抢答——①层（id）永远优先且不需要 `members.json`；但②③层为了保证"匹配强度"判断的正确性（精确必须先于模糊，见 Phase 2.9），除①外都需要无条件读一次 `members.json` 参与比较，这跟"信息新不新"是两回事，不要混为一谈。

**Phase 2.9 关于"精确 vs 模糊"的实现要点**：`_resolve_speaker` 内部用两个独立的合并字典（`exact_hits`/`fuzzy_hits`）分别收集三个来源的命中，`fuzzy_hits` 只有在 `exact_hits` 为空时才会被计算和使用——这保证了任何一个精确匹配都会在模糊匹配之前拿到优先权，不存在"模糊命中恰好唯一、精确命中被跳过"的执行路径。

**Phase 2.10 修订的动机**：Phase 2.9 把"除①层外都无条件读 `members.json`"落地之后，`_load_members()` 底层调的是 `agent.memory.scoped_store.read_scope(scope)`——这个函数会把 `scope.files` 里的**全部**文件都读一遍，group scope 现在有 `profile.json`/`summary.json`/`daily.md`/`memory.md`/`members.json` 五个。也就是说按发言人查询（已经因为 Phase 2.9 变成热路径）每次都会连带把 `daily`/`memory` 这类跟"解析 speaker 是谁"毫无关系的数据也下载、decode、parse 一遍，OSS 后端下更是额外的网络请求。外部 code review 二次复审指出：不该为了读一个成员索引文件而加载整个 scope。修复是给 `scoped_store.py` 新增 `read_scope_json(scope, filename)`，只读、解析单个 JSON 文件；`_load_members()` 改成调 `read_scope_json(scope, "members.json")`，不再经过 `read_scope()`。`im_reflection.py` 里为反思 prompt/写入而全量读取 scope 的调用点不受影响，仍然用 `read_scope()`（那些场景本来就需要多个文件）。

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

### 3.4 Code Review 修复（Phase 2.8，另外 3 处）

- **`members.json` 不进反思 prompt**：`_execute_job_locked` 里构造喂给 LLM 的 `user` 字符串时，原来直接 `json.dumps(current, ...)`——而 `current = await read_scope(scope)` 是在刚写完 `members.json` 之后读的，`scope.files` 已经包含它，所以 `current` 里带着全部群成员的 `platform_user_id`/`name`/`aliases`/`nicknames`/时间戳/计数，整份被塞进了每一次反思调用。改法：构造 prompt 前先 `reflection_current = {k: v for k, v in current.items() if k != "members"}`，只用这份过滤后的字典建 prompt；`_apply_output` 仍然接收未过滤的 `current`（`nicknames_add` 合并等逻辑不受影响）。群越大这个问题越严重（成员越多、prompt 越大），也会让本来就有过内容审核拦截历史的这个反思调用更容易再撞上限。
- **`_aggregate_members` 排序补 `id` 兜底**：`.order_by(ConversationMessage.created_at)` 改成 `.order_by(ConversationMessage.created_at, ConversationMessage.id)`——同一 `created_at`（批量入库、或数据库时间精度有限时常见）下 SQL 行序没有保证，"取最后处理的一行当最新名字"这个逻辑必须靠稳定排序才成立；`group_context_search` 自己已经用了 `created_at + id` 双排序，这里照抄同一约定，不新造一套。
- **members 聚合异常改为记诊断日志，不再完全静默**：`except Exception: pass` 改成 `except Exception as exc: diag_log("agent.memory.im_members.aggregate", exc)`。"聚合失败不能拖垮反思"这个决策本身没错，但完全不留痕对临时性错误没问题，对持续性故障（schema 变更、SQL 写错、OSS 权限失效、序列化异常）就是灾难——会永久停止更新且没有任何排查线索，而这个 PRD 本身就是因为"真实故障排查困难"才立项的，不能在自己的实现里重蹈覆辙。

---

## 4. 验证与上线

- 单元测试覆盖：`members.json` 的 DB 聚合逻辑（新成员首次出现、改名追加 `aliases`、`message_count` 随消息裁剪窗口变化）、`group_context_search` 的 `speaker` 参数四层匹配优先级（id 精确/`ConversationMessage` 实时查名字-曾用名/`members.json` aliases 包含匹配/`members.json` nicknames 模糊多候选）、`_merge_group_profile`/`_merge_profile` 改用 `apply_profile_ops` 后近义重复条目能被正确合并（用本次真实案例"酒店与…为同一家" vs "酒店为…"当回归用例）。
- **回归重点**：刚部署、`members.json` 还是空文件（反思任务还没跑过一次）时，第①②层查询必须仍然能正确解析出 `platform_user_id`——这正是 Phase 3 要修的实际故障场景，测试要显式覆盖"`members.json` 为空但 `ConversationMessage` 里已有该用户消息"这种情况。
- 待人工端到端验证：在真实群聊里复现本次故障场景（"看看 XX 最近说了什么"，其中 XX 是群友称呼而非本人显示名），确认能正确定位到人并给出该用户的真实历史，而不是"没搜到"或认错人；顺带观察一段时间群 profile，确认不再出现同一事实反复措辞记录的情况。
- 发布方式：随后端正常发布，不需要灰度/开关；`members.json` 是新增文件，不影响现有 `profile.json`/`summary.json`/`daily.md` 的读写路径。
- 上线后关注点：`backend/worker.py` 日志里如果新增聚合任务，确认没有引入新的高频异常（参考本次排查中发现的 `记忆反思空闲收束出错: ProgrammingError` 历史教训，这类错误如果只打印异常类型名不带详情，会很难排查，新增逻辑的异常日志应带上具体错误信息）。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| `nicknames` 提炼滞后 + 不保证准确 | 群友刚开始用一个新称呼时，短期内仍搜不到；LLM 也可能误判非称呼内容为称呼 | 产品预期管理：`members.json` 的 `nicknames` 是"尽力而为"，不是实时保证；这是 Phase 2.5 修订后**唯一**还依赖 `members.json`（因而唯一会滞后）的匹配层，id/name/曾用名已经改成实时查询，不受影响 |
| 多个群成员被匹配到同一个候选称呼（重名/称呼冲突） | 按人查历史可能查错人 | 见 3.2：多候选时不擅自二选一，返回候选列表交给上层澄清 |
| `group_context_search` 现状硬编码只支持 QQ（`source == "qq"`） | `members.json`/按发言人过滤做出来后，飞书/微信群用不上 | 本 PRD 明确不在范围内解决，按现有限制实现，是否扩展到其他平台留待另一个 PRD |
| member 路径改用 `apply_profile_ops` 后仍无法主动删除过时条目（`remove` 恒传空数组） | 过时的个人资料条目会一直留着，只是不再重复堆同义条目 | 本 PRD 范围内接受这个限制；真正解决需要给 `member_reflection.md` 加 `profile_remove` 输出，留待后续单独评估 |
| `_pattern_similar` 阈值（0.7）是为 owner pattern 场景调的，group/member profile 文本风格可能不同 | 阈值不一定完全适配，可能出现漏合并或误合并 | 上线后人工抽查一段时间的 group/member profile 变化，如效果不理想再评估是否需要独立阈值，不在本次实现前预判 |
| `speaker` 名字互为包含匹配可能产生"意外命中"（比如很短的名字恰好是另一个人名字的子串） | 极端情况下可能匹配到非预期的人，但会走多候选澄清流程，不会静默给错答案 | 本 PRD 不做额外的最短长度限制；如果实测发现短名字导致大量误判候选，再评估是否需要类似 `_pattern_similar` 的长度下限（如 ≥2 字才算包含命中） |
| 某批消息被 LLM 服务商内容审核拦截（如 Phase 2.7 实测遇到的 `anthropic.InternalServerError: input new_sensitive`）会导致该批反思任务持续重试失败，达到 `MAX_RETRIES` 后状态变 `dead`，游标永久卡在这批消息之前——不只是 `members.json`，`profile.json`/`daily.md`/`summary.json` 也会一起停止更新 | 群记忆（不只是 members.json）可能长期卡在某个时间点不再更新，且没有面向用户的提示 | 本 PRD 不解决这个更通用的问题（不是 members.json 特有的，是反思任务重试机制本身的缺口）；Phase 2.7 只解决了"members.json 的 DB 字段不该被这类失败连累"，`nicknames`/`profile`/`daily` 该怎么应对内容审核拦截导致的游标卡死，留待后续单独评估 |

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
- ✅ 已确认（Phase 2.6）：`speaker` 与 `platform_user_name` 的匹配改成互为包含，不再是精确相等——这是本 PRD 最初真实故障的核心，Phase 2.5 只解决了数据实时性，没解决匹配宽松度，两者是独立维度。
- ✅ 已确认（Phase 2.7）：`members.json` 的 DB 聚合字段（`_merge_members`）与 LLM `nicknames`（`_apply_nicknames`）彻底拆成两个函数、两次独立写入，前者挪到 `complete_json` 调用之前执行，不再共享同一个失败路径。

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
- [x] 3.2（Phase 2.5 修订）把 id/name/aliases 三层从"查 `members.json`"改成"实时查 `ConversationMessage`"，只有 nicknames 那一层继续读 `members.json`（且改成惰性加载，命中前两层时不产生这次文件读）；详见 FR-IM-8-1、3.2 节最新描述。测试同步重写为 DB 驱动，覆盖曾用名、同名多候选、"命中前两层不读 members.json"三个新场景。
- [x] 3.3（Phase 2.6 修订）第②层从"精确相等"改成"互为包含"（`speaker in name or name in speaker`），补两个方向的测试（speaker 是 name 的子串 / name 是 speaker 的子串）。

### Phase 4：验证与收尾

- [x] 4.1 单元测试：`members.json` DB 聚合（新成员首次出现、改名追加 `aliases`、`message_count` 随裁剪窗口变化）、`group_context_search` 的 `speaker` 四层匹配优先级、`_merge_group_profile`/`_merge_profile` 近义重复合并。**边界说明**：文档原"真实案例"（"酒店与…为同一家" vs "酒店为…"）bigram Jaccard 仅 0.33，低于 `_pattern_similar` 保守阈值 0.7，不会被合并——这是预期行为，测试改用子串关系案例验证合并，并保留低相似度不合并的对照用例。
- [x] 4.2 运行后端测试 + 前端 typecheck，更新 PRD 实施状态为 ✅ 已实施。后端完整测试 764 passed（含新增 17 个）。

### Phase 5（Phase 2.7 修订）：members.json 写入与 LLM 反思调用解耦

- [x] 5.1 `_merge_members(current, aggregated)` 去掉 `nicknames_add` 参数，只处理 DB 字段，不再碰 `nicknames`。
- [x] 5.2 新增 `_apply_nicknames(members, nicknames_add)`，只在 `members` 已有的 pid 上追加去重，不重新计算其他字段。
- [x] 5.3 `_execute_job_locked` 里，在 `messages = await _messages_for_job(...)` 之后、`complete_json(...)` 之前，group scope 独立执行 `_aggregate_members` + `_merge_members` + `write_scope_json`，包 try/except 静默失败（不影响本轮反思，下次任务会重新聚合）。
- [x] 5.4 `_apply_output` 去掉现在用不到的 `db` 参数（原来只为调 `_aggregate_members` 而加），调用方（`_execute_job_locked`、`agent_admin.py` 的 `apply_im_memory_maintenance`）同步改参数个数。**意外发现**：`agent_admin.py` 那处调用此前一直是用旧的 5 参数在调 6 参数的函数（`db` 参数错位），这次顺带修正，之前这条管理后台维护接口的成功路径实际上一直没被真正跑通过。
- [x] 5.5 测试同步拆分：`_merge_members` 测试只覆盖 DB 字段合并与保留既有 `nicknames`；新增 `_apply_nicknames` 独立测试（追加、忽略未知成员、去重）。

### Phase 6（Phase 2.8 修订）：Code Review 发现的 4 个问题，合并前修复

- [x] 6.1 `_resolve_speaker` 新增 aliases 层（③层，②④之间）：查不到实时名字/曾用名，才读 `members.json.aliases` 做互为包含匹配，跟④层 nicknames 共用同一次 `load_members()`；补两个测试（改名后旧消息已裁出保留窗口、依然能用旧名字查到；aliases 撞车走多候选澄清）。
- [x] 6.2 `_execute_job_locked` 构造反思 prompt 前过滤掉 `current` 里的 `"members"` 键，不再把整份群成员名单塞进每次 LLM 调用。
- [x] 6.3 `_aggregate_members` 排序补 `ConversationMessage.id` 兜底，跟 `group_context_search` 已有的 `created_at + id` 双排序约定保持一致。
- [x] 6.4 members 聚合失败从 `except Exception: pass` 改成 `except Exception as exc: diag_log(...)`，持续性故障不再完全无痕。
- 6.2/6.4 未补自动化测试——需要搭 `execute_job` 全链路（DB 会话 + Redis 分布式锁 + mock `complete_json`）的测试基座，现有测试套件里还没有这类夹具，改动本身经代码走查确认逻辑正确（前者是一行 dict 过滤，后者是把 `pass` 换成一行 `diag_log` 调用），风险低，先靠人工审查兜底，需要时再补基座和用例。

### Phase 7（Phase 2.9 修订）：Code Review 复审发现的 2 个数据生命周期问题，合并前修复

- [x] 7.1 `_merge_members(current, aggregated)` 补上"保留沉默成员"逻辑：先按原逻辑处理 `aggregated` 里出现的 pid，再遍历 `current` 里剩下没被处理过的 pid，原样保留 `name`/`aliases`/`nicknames`/`last_seen_at`，只把 `message_count` 归零。补两个测试：`test_merge_members_keeps_stale_member_out_of_aggregation_window`（本轮聚合看不到的成员，aliases/nicknames 依然保留）、`test_merge_members_stale_member_reappears_next_round_keeps_history`（沉默一轮后重新出现，旧数据能正确延续）。
- [x] 7.2 `_resolve_speaker` 匹配逻辑重构：不再是"①id→②实时name→③aliases→④nicknames"四层顺序判断、任一层唯一命中就 `return`；改成"①id→②三来源合并精确匹配→③三来源合并模糊匹配"两级判断，精确匹配全都没有命中才进入模糊匹配。除①层外都无条件读一次 `members.json`（不再是"查不到实时名字才读"）。补三个测试：`test_resolve_speaker_reads_members_even_on_exact_live_name_hit`（验证②层即使实时名字精确唯一命中也会读 `members.json`）、`test_resolve_speaker_exact_alias_beats_fuzzy_live_name`（回归复现 code review 给出的静默查错人场景，验证修复后能正确命中精确 alias 而不是模糊 name）、`test_resolve_speaker_multiple_exact_matches_are_ambiguous_not_silent`（两个来源各有一个精确匹配时正确触发 ambiguous 而非随意二选一）；原 `test_resolve_speaker_does_not_read_members_when_live_hit` 拆成两个测试分别验证①层跳过 / ②层不跳过，命名同步改为 `_when_id_hit`。
- [x] 7.3 排序候选的 `last_seen_at` 取值来源调整：优先取 `members.json` 里的 `last_seen_at`，没有才退回实时查询算出的值——两个候选出现在同一批种子消息、时间戳完全相同时，全靠实时值排不出稳定顺序，而 `members.json` 的值是反思任务全量聚合得出、更适合做排序依据。
- 后端完整测试 778 passed（含新增 5 个，另有 3 个既有测试因行为变化同步改写）。

### Phase 8（Phase 2.10 修订）：Code Review 二次复审发现的 1 个 P2 性能问题，合并前修复

- [x] 8.1 `scoped_store.py` 新增 `read_scope_json(scope, filename)`：复用现有的 `_read()` 私有函数只读单个文件，JSON 解析逻辑跟 `read_scope()` 里对应分支保持一致（不存在/解析失败都返回 `{}`）；非 `.json` 文件名直接 `ValueError`，跟 `write_scope_json` 的校验风格一致。
- [x] 8.2 `group_context.py` 的 `_load_members()` 改用 `read_scope_json(scope, "members.json")`，不再经过读全部 5 个文件的 `read_scope()`。`im_reflection.py` 里为反思 prompt 构造/`_apply_output` 写入而全量读取 scope 的调用点不改动——那些场景本来就需要 `profile`/`daily`/`memory` 等多个文件，不是这次要解决的问题。
- [x] 8.3 新增 `tests/test_scoped_store.py`：`test_read_scope_json_only_reads_requested_file` 用记录调用 key 的假存储验证只读了 `members.json` 这一个 key；另外覆盖文件不存在返回 `{}`、JSON 解析失败返回 `{}`、非 `.json` 文件名报错三种边界。
- 后端完整测试 782 passed（含新增 4 个）。
