# Memory、Knowledge 与反思机制

> 本文描述当前 Gugu Agent 的长期信息、结构化知识和反思链路。Memory 负责理解用户及会话状态，Knowledge 负责可引用的业务知识，Reflection 负责从已完成交互中提炼增量；具体字段和阈值以代码与测试为准。

## 1. 三类信息的边界

| 类型 | 解决的问题 | 典型内容 | 是否直接注入 |
|---|---|---|---|
| Memory | 以后如何更好地理解和回应用户 | 身份、稳定偏好、行为模式、近期状态、事件历史 | 部分直接注入，超预算时走 RAG |
| Knowledge | 以后如何少重复搜索、重读或推导 | 项目事实、规则、协议、流程、可复用经验 | 通过统一 RAG 按需注入 |
| Conversation | 已发生的对话事实 | 历史消息、工具回执和当前会话上下文 | 历史上下文和 conversation RAG |

边界规则：用户身份、偏好、习惯和个人状态属于 Memory；项目、系统、代码、规则和可复用流程属于 Knowledge；一次性进展和原始对话留在 Conversation 或 daily，不因为被召回就自动升级为长期信息。

## 2. Memory 分层与存储

Memory 的共享存储层是 `backend/agent/memory/store.py`，主数据保存在用户隔离的 `.agent/` 前缀下：

| 文件 / 层 | 内容 | 生命周期 |
|---|---|---|
| `profile.json` | name、address、pronoun、background、preference、note 等稳定画像 | 长期保留，不衰减；按增量操作更新 |
| `pattern.json` | observed/inferred 行为和决策模式、置信度、重要度 | inferred 随时间衰减，周期性复核和退休 |
| `summary.json` | 用户当前重心和状态快照 | 覆盖式更新，空结果不覆盖已有值 |
| `daily.md` | 每轮反思提炼的近期流水 | 新内容在前，达到阈值后压缩 |
| `memory.md` | daily 历史压缩后的长期事件主档 | 保留日期、背景、事实、结果和后续约定 |
| `lens` | 从反复误读中提炼的用户解读先验 | 经过复现门槛后才写入，绝大多数轮为空 |

IM 还按 owner、platform、bot、group/member scope 保存群组和成员记忆。文件记忆和 IM 记忆共用 profile/pattern 操作函数，但 scope、生命周期和触发器不同。

## 3. Memory 的读取与注入

```text
请求进入 Agent
    -> load_memory / load_dynamic_memory
    -> profile、pattern、summary、daily、memory、lens
    -> 预算与新鲜度过滤
    -> 固定上下文段或动态尾部
```

- profile、pattern、summary、daily 和 memory 的结构化内容由 `context/loaders.py` 读取。
- profile 和 pattern 有直接注入上限；inferred pattern 按置信度和时间衰减排序。
- `memory.md` 和 pattern 超出预算时，按当前 query 做词法/向量相关性筛选；embedding 未启用时退回确定性的词法路径。
- daily 只限制本轮注入长度，不因为注入预算而删除落盘数据。
- 自动 RAG 是独立的 `knowledge-context` 动态块，不把 RAG 结果改写成 Memory。

## 4. Memory 反思触发

### 4.1 Web 和私聊

对话结束后由 Web/IM gateway 调用 `agent.memory.reflection.schedule()`，创建后台任务执行 `reflect()`：

```text
用户消息 + Agent 回复
        -> 反思分支（JSON）
        -> profile/pattern 增量
        -> daily / summary
        -> perception、feedback、correction 遥测
        -> 可选 knowledge_candidate
```

反思是 fire-and-forget：模型、存储或解析失败不能阻塞主回复；失败时不写入不完整的记忆增量。反思只提交本轮增删，不回显或整份重写 profile/pattern。

### 4.2 IM 群组和成员

`memory/reflection_jobs.py` 和 `memory/im_reflection.py` 负责群组/成员的异步反思：

- active window、idle window 和消息数量阈值决定何时形成任务；
- DB job 使用 scope、消息范围和 extractor version 生成幂等键；
- Redis Stream 负责投递，任务保留 pending、retry、dead 状态；
- cursor 记录最后观察、最后反思和 scope version；
- tombstone 阻止已删除 scope 继续写入。

群组和成员反思不能把 scope 内容写入 owner 私有 Memory，写入前必须通过确定的 scope 过滤。

## 5. daily 压缩与长期事件记忆

`agent/memory/compress.py` 负责 daily 到 `memory.md` 的沉淀：

```text
daily 达到 100 条
        -> 取最老的 100 条
        -> 读取已有 memory.md、profile、pattern 和历史事件参考
        -> 反思分支整理完整长期事件主档
        -> 校验日期和非空结果
        -> 成功后才裁剪 daily，保留最近 50 条
```

压缩失败、返回空文档或丢失本批次日期时，不覆盖原 `memory.md`，也不裁剪 daily。长期事件主档不是 profile/pattern 的复制品，必须保留事件时间、背景和变化过程。

## 6. Knowledge 生命周期

Knowledge 的契约位于 `backend/agent/knowledge/models.py`，文件存储和版本处理位于 `knowledge/store.py`：

```text
候选事实 / 规则 / 流程
        -> Knowledge RAG 查重
        -> Knowledge reflection
        -> create / update / conflict / ignore
        -> 版本、来源、scope 和 parent
        -> Markdown 主数据 + RAG 索引投影
```

- KnowledgeEntry 有 title、topic、content、scope、source、confidence、version、history 和 parent。
- 同主题同来源优先更新；不同来源不能安全覆盖时建立 conflict parent。
- `explicit` 保存允许 `confirmed`；`automatic` 只能写入 `probable`。
- 删除采用 inactive 语义，保留历史以便审计和冲突追踪。
- KnowledgeStore 只负责主数据和版本，不负责 RAG 排序或权限扩大。

## 7. Knowledge 反思触发

Knowledge 反思不是每轮独立运行，而是复用 Memory 反思输出的严格候选信号：

1. Memory reflection 输出 `knowledge_candidate.should_reflect=true` 和有限 query。
2. `knowledge/reflection.py` 以 `source=knowledge` 做一次候选召回。
3. Knowledge 专用 prompt 判断 create、update、conflict 或 ignore。
4. 调用方补充真实 source、source_ref、session 和 owner 元数据后保存。

普通闲聊、用户画像、临时计划、一次性进展、凭据和不完整猜测应被忽略，不能因为模型输出了自由文本就直接写入 Knowledge。

## 8. RAG 与反思的关系

```text
RAG：读取、切块、检索、过滤、注入
Memory reflection：从交互提炼用户长期信息
Knowledge reflection：从候选判断可复用业务知识
Compaction：把近期 daily 整理为长期事件
```

RAG 召回不会自动写入 Memory 或 Knowledge；反思写入后通过事件或重建流程更新 RAG 索引。当前普通笔记、文件、画布和对话等来源的切块与召回规则见 `06-RAG-AND-KNOWLEDGE.md`。

## 9. 事件、索引与一致性

- Memory 更新通过 `MemoryUpdated` 事件推进 scope cache 和 RAG 索引更新。
- daily 写入后发布 `RagIndexUpdated`，长期记忆压缩成功后同步 memory 索引向量。
- Knowledge 主数据保存成功后由索引重建/增量流程生成 `KnowledgeIndexEntry`，业务主数据始终是事实来源。
- 索引更新失败不能伪造成功；可重建索引必须保留补偿路径。
- 内容指纹、版本和 chunk slot 用于去重、增量 patch 和避免重复注入。

## 10. 反思安全与可观察性

反思输入可以包含对话内容，但日志不能记录正文。可记录的内容包括：

- 反思阶段、scope 类型、任务状态和重试次数；
- 增删数量、是否更新 summary/daily、候选数量；
- 脱敏 fingerprint、错误类型和耗时；
- perception、feedback、correction 等白名单结构化遥测。

原始异常只进入受限诊断日志；用户可见错误使用通用失败说明。Reflection 生成的内容不是工具权限、系统指令或事实授权，注入时仍必须服从 scope、ACL 和 Context Assembly 边界。

## 11. 当前限制与后续方向

- Memory 仍同时存在直接注入和 RAG 召回两条读取路径，后续应继续明确优先级和共享预算。
- Web/私聊、IM 群组/成员、周期 pattern 维护的反思触发器分散在不同模块，需要统一任务观测面板。
- Knowledge 已有版本和冲突语义，但 workspace/team scope 和更完整的质量评估仍需专题定义。
- 反思失败目前以跳过、重试或等待下次活跃窗口为主，不能阻塞主 Agent；补偿和告警策略需在可靠性专题中统一。
- 旧版记忆说明位于 `docs/agent/_archive/11-记忆系统.md`，只用于历史对照，不作为当前行为依据。

## 12. 主要实现位置

| 能力 | 实现 |
|---|---|
| Memory 存储与渲染 | `backend/agent/memory/store.py` |
| Web/私聊反思 | `backend/agent/memory/reflection.py` |
| IM 反思任务 | `backend/agent/memory/reflection_jobs.py`、`im_reflection.py` |
| daily 压缩 | `backend/agent/memory/compress.py` |
| 周期 pattern 维护 | `backend/agent/memory/periodic.py` |
| Knowledge 主数据 | `backend/agent/knowledge/models.py`、`store.py` |
| Knowledge 反思 | `backend/agent/knowledge/reflection.py` |
| RAG 注入 | `backend/agent/rag/injection.py`、`service.py` |
| 相关回归测试 | `backend/tests/test_knowledge.py`、`test_rag_memory_service.py`、`test_memory_periodic.py`、`test_memory_compaction_retrieval.py` |
