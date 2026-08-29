# 事件型长期记忆与压缩去重

> 状态：Phase 0–4 已完成，Phase 5 待实施

> 执行边界：记忆反思与事件压缩的 provider 分支、稳定前缀组装、重试和审计统一由 [PRD-AGENT-5：ContextBranch 反思与压缩统一架构](PRD-AGENT-5-ContextBranch反思与压缩统一架构.md) 维护；本 PRD 只定义事件记忆的领域规则与持久化。
> 创建：2026-08-24
> 关联文档：[`docs/agent/07-MEMORY-AND-REFLECTION.md`](../agent/07-MEMORY-AND-REFLECTION.md)、[`PRD-MEM-1-记忆召回工具与混合检索.md`](./PRD-MEM-1-记忆召回工具与混合检索.md)、[`PRD-RAG-1-统一知识召回与索引.md`](./PRD-RAG-1-统一知识召回与索引.md)
> 目标：明确 profile、pattern、memory 的边界，把 memory.md 收敛为事件/对话记忆，并在 daily 压缩时用少量 RAG 历史参考减少重复。

## 1. 背景

当前系统已经把记忆拆成 `profile.json`、`pattern.json`、`daily.md` 和 `memory.md`，但长期记忆的写入语义仍然容易被理解成“把 daily 继续压成一篇长期摘要”。随着 RAG 引入，这种模式有两个问题：

- 具体事件、对话背景和阶段过程不适合被过度概括；
- 压缩模型如果只看到当前 daily 批次，容易重复写入已有事件，或无法识别历史上已经记录过的相同事件。

本 PRD 不把所有内容都塞进 `memory`，而是进一步固定三类记忆的职责，并让长期记忆优先保存可检索的事件事实。

## 2. 记忆边界

| 类型 | 主要问题 | 存储 | 生命周期 | 是否进入事件 RAG |
|---|---|---|---|---|
| `profile` | 用户是谁、稳定身份和属性是什么 | `profile.json` | 增量维护，不衰减 | 否 |
| `pattern` | 用户长期做事/决策/协作习惯是什么 | `pattern.json` | 增量维护，带置信度和衰减 | 否，必要时作为压缩边界参考 |
| `daily` | 最近发生了什么 | `daily.md` | 近期缓冲，达到水位后进入压缩 | 尚未压缩时不作为长期事件索引 |
| `memory` | 发生过哪些事件、对话和阶段过程 | `memory.md` | 事件历史持续保留，可重组章节 | 是 |

`profile` 和 `pattern` 的存储、增量去重、衰减和维护策略保持现状；只调整上下文直注入水位：每个来源最多直注入 50 条，超过部分继续保留并交给当前 scope 的 RAG 按需召回。该限制不删除原始条目，也不把 profile 改造成带置信度的事件索引。

### 2.1 `memory` 应该记录什么

适合进入 `memory`：

- 具体事件的起因、过程、结果和后续约定；
- 用户对某个项目、功能、人物或问题的讨论背景；
- 一段时间内形成的决策过程和变更原因；
- 对话中以后可能需要恢复的上下文，而不是单句偏好结论。

不适合进入 `memory`：

- 用户姓名、所在地等稳定画像，应进入 `profile`；
- “用户喜欢简洁回复”等可复用行为规则，应进入 `pattern`；
- 仅用于当前回复、不会影响未来理解的临时细节；
- 模型自行推断、没有用户事实依据的结论。

## 3. `memory.md` 结构

长期记忆使用事件章节，不再把整个文件当作无结构连续摘要：

```md
## 记录长期记忆：2026-08-24 图片搜索功能

用户测试了相似图搜索，确认结果分数只用于排序，不能直接当作事实置信度。
后续分析图片时，需要结合标题、来源、图片内容和用户补充信息判断。

## 记录长期记忆：2026-08-23 上下文缓存优化

用户验证了多轮对话缓存命中率明显提升，并决定保留稳定的历史前缀结构。
```

### 3.1 章节规则

- 一级标题统一使用 `## 记录长期记忆：<事件标题>`；
- 标题应描述事件、主题或阶段，不使用泛化的“长期记忆”标题；
- 正文保留发生时间、背景、关键事实、结果和后续约定；
- 同一事件后续有新进展时，优先合并到原章节，而不是创建重复章节；
- 事件发生修正时保留修正关系，例如“原结论 → 后续修正”；
- 章节内容必须来自用户消息、工具结果或明确可验证的系统事实，不允许模型脑补；
- `profile` 和 `pattern` 可以作为去重边界参考，但不得把它们原样复制进事件记忆。

## 4. daily 压缩与 RAG 去重

### 4.1 压缩输入

当 `daily.md` 达到现有压缩水位时，压缩模型接收：

1. 当前待沉淀的 daily 事件批次；
2. 通过事件标题、关键词、BM25/Embedding 召回的相关 `memory.md` 事件章节；
3. `profile` 和 `pattern` 的去重边界摘要；
4. 从历史事件 RAG 召回的最多 10 条相关记忆，作为“历史参考”。

RAG 结果只用于辅助识别重复、补全背景和发现冲突，不能替代原始 daily 批次，也不能让模型只根据 10 条结果重建全部长期记忆。

### 4.1.1 全量 `memory.md` 不是常规输入

完成事件章节化后，压缩器**默认不得把完整 `memory.md` 注入模型**。长期记忆增长时，压缩输入应保持与当前事件相关性和固定预算相关，而不是随主档长度线性增长。

仅允许以下受限兜底场景读取旧主档内容：

- 旧格式尚未完成事件章节迁移；
- 事件解析或索引暂时不可用；
- 需要执行一次迁移兼容或恢复任务。

兜底读取必须遵守固定字符/token 上限，并标记为“迁移/历史参考”，不能恢复成无上限全量注入。兜底失败时仍以当前 daily 批次为事实输入，不得因此裁剪 daily 或覆盖旧 `memory.md`。

压缩输入的优先级固定为：

```text
当前 daily 批次（完整）
> 相关事件章节
> 最近修正/高优先级事件
> profile/pattern 边界摘要
> 受限迁移兜底内容（仅必要时）
```

### 4.2 RAG 召回约束

- 召回范围只限当前用户可见的事件型 `memory`；
- 每次压缩最多注入 10 条历史事件参考；
- 先按稳定的 `chunk_id`/`content_hash` 去重，再按相关性取结果；
- 结果必须明确标记为“历史参考”，避免被模型当作当前新事实重复写入；
- 没有可用 RAG、Embedding 未启用或召回失败时，压缩仍可使用原有输入完成；
- RAG 失败不得阻塞正常回复，也不得导致 daily 被裁剪。

### 4.3 压缩输出

模型输出新的完整 `memory.md` 有效视图：

- 以事件章节组织；
- 合并明确重复的事件；
- 保留事件时间线和重要背景；
- 新旧结论冲突时保留后续事实，并说明修正；
- 不重复写入 profile/pattern 的稳定结论；
- 输出为空、丢失本批次日期或明显异常时，不覆盖旧 `memory.md`，也不裁剪 daily。

原始 daily 仍是压缩失败时的事实缓冲。后续如果需要完整审计，事件章节可以进一步增加稳定的 `memory_id`、来源消息 ID 和 `content_hash`，但本阶段不把内部 ID 暴露给模型或用户。

## 5. 向量索引生命周期

- `memory.md` 是可重建的事件有效视图，不是唯一不可变事实库；
- `memory_vec.json` 继续作为按章节/块生成的向量缓存；
- 每次压缩成功重写 `memory.md` 后，只对新增或内容变化的块重新 embedding；
- 旧块按内容哈希 GC；
- 模型更换后按 model tag 失效并支持全量重建；
- 没有向量时退回已有词法/顺序预算逻辑，不影响事件记忆写入。

## 6. 数据与权限边界

事件记忆必须沿用当前记忆 namespace：

- owner 事件只进入 owner 的 `.agent` 空间；
- IM 群组和成员事件使用独立 scope，不得混入 owner memory；
- RAG 召回必须先做 ownership/scope 过滤，再做相关性排序；
- 删除或撤回事件后，对应章节和向量索引必须一起失效；
- 日志、诊断和 LoopScope 只记录数量、哈希和状态，不记录记忆正文。

## 7. 实施文件盘点

### 7.0 Phase 0 盘点结论

| 链路 | 当前实现 | Phase 0 结论 |
|---|---|---|
| profile | reflection.py 输出增量 profile_add/profile_remove，store.py 去重后写入 profile.json | 保持现状，不并入事件 memory |
| pattern | reflection.py 输出增量 pattern_add/pattern_remove，store.py 按相似度和置信度合并 | 保持现状，不并入事件 memory |
| daily | reflection.py 追加带日期条目；达到条数水位后由 compress.compact 批量处理 | 作为事件缓冲，不在本阶段改变阈值 |
| memory | compress.py 读取旧主档、profile、pattern 和 daily 批次后调用维护模型重写 | 接入事件章节规范化和输出校验 |
| 向量 | store.sync_memory_vecs 在 memory 重写后同步章节/块缓存 | 生命周期与增量 hash 留给 Phase 3 |
| scope | owner 与 IM scope 复用 scoped_store/im_reflection | 本阶段只固定公共事件契约，不改变 IM 归因 |

盘点确认：Phase 0 不新增独立存储，不把 profile、pattern 改成事件索引；事件 memory 的公共标题、章节解析和 hash 契约由 backend/agent/memory/event_memory.py 提供。

### 7.1 预计修改

- `backend/agent/memory/reflection.py`：明确 daily 提取为事件记录，减少把 profile/pattern 内容写入 daily；
- `backend/agent/memory/compress.py`：增加事件章节输出约束、历史 RAG 参考注入和异常校验；
- `backend/agent/memory/store.py`：补充事件章节解析、稳定 chunk/hash 和 memory 向量同步边界；
- `backend/agent/memory/prompts/` 或对应压缩 Prompt：增加事件型 memory 写入规则；
- `backend/agent/rag/`：复用统一 RAG 的 source、scope、chunk、retriever 和注入协议；
- `backend/tests/`：补充事件章节、压缩去重、RAG 失败回退、权限隔离和向量同步测试。

### 7.2 可能新增

- `backend/agent/memory/event_memory.py`：事件章节解析、规范化和 hash；
- `backend/agent/memory/memory_references.py`：压缩阶段的最多 10 条历史参考选择；
- `backend/tests/test_event_memory.py`；
- `backend/tests/test_memory_compaction_retrieval.py`。

具体文件以实现前的代码盘点为准，不提前创建空模块，也不复制一套独立 RAG 实现。

## 8. 实施阶段与验收

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 盘点现有 profile/pattern/daily/memory 写入、压缩和向量链路 | ✅ |
| Phase 1 | 固定事件型 memory 边界、标题格式和 Prompt | ✅ |
| Phase 2 | 接入压缩阶段历史事件 RAG，最多 10 条并保留失败回退 | ✅ |
| Phase 3 | 规范章节去重、冲突修正、hash 和 memory_vec 增量同步 | ✅ |
| Phase 4 | 补齐 owner/IM scope、删除失效、压缩异常和回归测试 | ✅ |
| Phase 5 | 在 devserver 验证事件重复率、召回质量、压缩延迟和上下文体积 | 🔲 |

最低验收标准（Phase 0–1）：

1. profile/pattern 不再被整段复制进 memory 事件；
2. 相同事件跨多个 daily 批次不会无限重复生成章节；
3. 压缩阶段最多注入 10 条历史事件参考；
4. 常规压缩不注入完整 `memory.md`，输入体积不会随主档长度线性增长；
5. RAG 不可用时只允许走有上限的迁移/历史参考兜底，压缩行为和数据安全不退化；
6. memory 重写后向量缓存能增量更新，旧块不会残留；
7. owner、群组和成员记忆不会跨 scope 召回；
8. 压缩失败不会覆盖旧 memory，也不会丢弃 daily。

Phase 0–1 已完成的验收：

- memory.md 新输出统一规范为「## 记录长期记忆：<事件标题>」章节；旧无标题主档仅在重写时包裹为兼容事件章节；
- 压缩 Prompt 明确 profile/pattern 与事件 memory 的边界、日期要求、重复合并和冲突修正规则；
- 空输出、日期校验和原有失败回退仍保留；事件章节解析与稳定 hash 已有单元测试。

Phase 2 已完成的验收：

- daily 压缩前用当前批次构造 BM25 查询，只从 owner memory scope 召回历史事件；
- 压缩阶段最多使用 10 条历史参考，并设置总字符上限，不把 chunk、scope、score 等内部字段注入模型；
- RAG 不可用、索引缺失或召回异常时，压缩继续使用原有完整 memory 输入，不阻塞压缩，也不裁剪 daily；
- 已补充历史参考数量、scope/策略和召回失败回退测试。

Phase 3–4 已完成的验收：

- owner 与 IM 群组压缩统一经过事件章节规范化；同标题章节合并，相同正文按稳定 hash 去重，后续补充内容按原顺序保留；事实冲突仍由维护模型结合日期处理。
- owner memory 重写继续使用 `memory_vec.json` 的块文本 hash 增量同步：未变化块复用向量，新增/变化块补算，消失块清理；embedding 不可用时保持 no-op。
- owner 召回严格使用 owner scope；IM 群组使用自身 scope 的存储和压缩链路，成员 scope 不读取群组 memory；删除通过 tombstone、scope 锁和 scope 前缀清理，避免删除后旧索引/旧文件复活。
- owner、IM 群组的压缩异常均不覆盖旧 memory、不裁剪 daily；已补充章节去重、群组规范化、异常回退和删除屏障回归测试。

## 9. 与现有方案的关系

本 PRD 只规范记忆内容模型和压缩写入策略：

- `PRD-MEM-1` 负责记忆召回工具与混合检索能力；
- `PRD-RAG-1` 负责统一 Source、Chunk、Index、Retriever 和权限协议；
- `docs/agent/07-MEMORY-AND-REFLECTION.md` 继续作为现有记忆系统实现说明，实施完成后同步更新；
- 本 PRD 不改变 `profile`、`pattern` 的独立存储，也不把所有记忆改造成单一向量数据库。

## 10. 与 PRD-IM-11 的依赖关系

本 PRD 是事件型长期记忆的公共底座，`PRD-IM-11-群成员长期记忆` 是其在 IM 群聊场景的派生写入扩展。两份 PRD 保持独立，不把群成员归因、成员权限和一次调用多成员分发规则混入 owner 记忆规范。

### 10.1 可复用的公共能力

- 事件章节的标题、日期、背景、结果和后续约定格式；
- 读取现有 memory + 新 daily 后的合并、去重、冲突修正和异常保护；
- `content_hash`/chunk 规范、向量增量同步和旧块 GC；
- scope-first 权限过滤、删除屏障和压缩失败回退；
- 压缩输出 schema 校验和“旧 memory 不覆盖、daily 不裁剪”的安全边界。

### 10.2 IM-11 独有规则

- 群消息到 `platform_user_id` 的归因和 `members.json` 校验；
- 群公开记忆与成员个人事件记忆的隔离；
- 一次群压缩调用输出 `memory` 与 `member_memory_add`；
- 单个成员写入失败不影响群 memory 和其他成员；
- 成员退出、群解散及不同角色的可见范围。

### 10.3 推荐执行顺序

1. 先完成本 PRD Phase 0–1：盘点并抽出事件章节、合并、hash 和异常校验公共契约；
2. 完成本 PRD Phase 2–3：接入压缩阶段历史事件 RAG，并统一 owner/group/member 的 memory 向量生命周期；
3. 再执行 IM-11 Phase 0–1：为 `platform-user` 开放 `memory.md`，扩展群压缩双重输出并复用公共事件写入器；
4. 最后分别完成两份 PRD 的 scope 隔离、失败隔离、回归测试和 devserver 验收。

IM-11 不应在事件章节和公共写入契约落地前单独调整群压缩阈值；否则会增加调用成本，却无法保证成员事件的去重和安全写入。
