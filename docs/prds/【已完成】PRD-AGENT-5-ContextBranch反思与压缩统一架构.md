# PRD-AGENT-5：ContextBranch 反思与压缩统一架构

状态：Phase 0–5 已完成
负责人：Agent Runtime  版本：v1

> 架构修订（2026-09-02）：`ContextBranch` 只负责对话上下文压缩和记忆反思等需要独立分支生命周期的任务。`daily/event memory` 沉淀属于记忆领域后台整理，不进入 `ContextBranch`，由 `memory/memory_compress.py` 直接调用共享 `provider_runner`，只生成新增章节并追加写入 `memory.md`；重试、输出校验和持久化保护由领域模块负责。

## 1. 背景与目标

当前 Agent 有两类后台上下文任务：

1. **对话压缩**：把 baseline 之前的旧 history 合并为 summary，降低下一轮上下文体积；
2. **记忆反思**：从当前对话或 IM scope 批次中提炼 profile、pattern、daily、summary 和事件记忆。

对话压缩和记忆反思都需要“从稳定上下文快照分支、追加本次增量、调用 provider、校验结果、持久化”的流程，但 daily/event memory 压缩是独立的记忆文档整理任务，不依赖主对话 snapshot、scope 或 branch 生命周期。此前把两者都纳入同一公共分支，导致记忆压缩携带无关的分支元数据和审计语义。

本 PRD 的目标是让 `ContextBranch` 统一反思与对话上下文压缩的公共执行基础，同时保留记忆文档压缩的领域独立性；三者继续共享 provider runner，但不共享不必要的生命周期、输入和审计语义。

目标生命周期：

```text
唯一 baseline / scope snapshot
          │
          ├── 稳定前缀（system、snapshot、静态规则）
          └── 本轮增量（当前 turn / 当前 reflection batch）
                         │
                         ▼
                 ContextBranch
       组装 → provider 调用 → usage/overflow
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       ConversationBranch       ReflectionBranch
       输出 summary               输出 memory delta
              │                     │
              ▼                     ▼
       更新 session baseline    更新 memory/RAG

daily/event memory 沉淀：memory/memory_compress.py → provider_runner → memory.md/RAG
```

## 2. 设计原则

- `ContextBranch` 只负责公共执行能力，不决定 profile、pattern、daily 或 conversation summary 的业务含义。
- 所有分支都以稳定 baseline/snapshot 为起点，只追加本次增量；禁止读取无界全量历史。
- 所有 provider 预算、overflow、重试和 usage 记录统一使用 `ContextBudget`；本地 token 估算不得作为正常压缩触发依据。
- 分支请求不得修改主对话的内存 history；只有持久化成功后，结果才影响后续请求。
- 压缩和反思的动态输入必须位于稳定前缀之后，避免无意义地破坏 provider cache。
- 失败必须可解释、可重试、可回退，不能静默覆盖旧 baseline 或旧 memory。
- owner、group、platform-user、knowledge 使用同一公共执行管线，只替换 scope、Prompt、输入适配器和结果写入器。

## 3. 当前实现盘点

### 3.1 已有可复用部分

| 位置 | 现状 |
|---|---|
| `agent/memory/_llm.py` | 反思与 daily 压缩共用 provider 路由、非流式调用和 JSON 解析 |
| `agent/context/budget.py` | 已定义统一 `ContextBudget` 和 provider usage 分项 |
| `agent/context/compaction.py` | 已处理 overflow/90% 收尾压缩、最近 5k 原文、旧 history summary 和 retry |
| `agent/context/run_finalize.py` | 已在 run 收尾提交 baseline 生命周期 |
| `agent/memory/reflection.py` | owner 反思以当前对话增量更新结构化记忆 |
| `agent/memory/im_reflection.py` | group/member 反思以 scope 快照和消息批次更新记忆 |
| `agent/knowledge/reflection.py` | Knowledge 反思复用 Memory 反思触发时机，但拥有独立候选和写入协议 |

### 3.2 当前重复或不一致

- `reflection.py`、`im_reflection.py`、`memory_compress.py` 各自组装 provider 用户输入。
- 反思输入没有统一的 `ContextBudget` 分项和超限处理。
- owner 反思、IM 反思和 daily 压缩各自维护不同的输入截断/输出上限。
- provider 调用虽然共享 `_llm.py`，但调用前后的审计、错误原因和重试语义不统一。
- 压缩有明确的 baseline 生命周期，反思则主要依赖后台 task/队列和 scope cursor；两者的“分支完成后提交”边界没有公共抽象。
- `knowledge/reflection.py` 在 Memory 反思后追加调用，缺少统一的分支元数据和预算记录。

## 4. 目标架构

### 4.1 公共目录

```text
backend/agent/context/
├── branch.py                 # ContextBranch 公共执行管线
├── branch_types.py           # BranchInput / BranchResult / BranchPolicy
├── budget.py                 # 唯一 ContextBudget
├── assembler.py              # baseline + 增量的稳定组装
├── provider_runner.py        # provider 调用、usage、overflow、retry
├── compaction_branch.py      # 压缩分支适配器
└── reflection_branch.py      # 反思分支适配器

backend/agent/memory/
├── reflection.py             # owner 反思业务与 Memory delta writer
├── im_reflection.py          # group/member scope 业务与 writer
├── memory_compress.py        # daily/event memory 业务与 writer
└── ...                       # scope、存储、RAG 等业务模块
```

`context/` 负责公共分支生命周期；`memory/` 负责记忆领域的输入转换、输出校验和持久化。不得把 memory writer 反向塞回 `ContextBranch`。

### 4.2 公共组件接口（目标）

```python
class ContextBranch:
    async def run(
        self,
        branch_input: BranchInput,
        policy: BranchPolicy,
        adapter: BranchAdapter,
    ) -> BranchResult: ...
```

核心数据：

```python
BranchInput {
    baseline: list | dict
    delta: list | dict
    stable_system: str
    dynamic_context: str = ""
    scope: str
    session_id: int | None
    run_id: str | None
}

BranchPolicy {
    name: "compaction" | "reflection"
    budget: ContextBudget
    max_retries: int
    output_mode: "text" | "json"
    preserve_prefix: bool = True
}

BranchResult {
    ok: bool
    output: object | None
    return_reason: str
    provider_usage: object | None
    attempts: int
    input_fingerprint: str
    output_fingerprint: str | None
}
```

### 4.3 两个分支的边界

| 分支 | 输入 | 输出 | 持久化责任 |
|---|---|---|---|
| `CompactionBranch` | baseline 之后的旧 history + 当前保护窗口 + 压缩 Prompt | summary / canonical history | `run_finalize.py`、baseline coordinator |
| `ReflectionBranch` | baseline/scope snapshot + 当前 turn 或 reflection batch | profile/pattern/daily/summary/event delta | `memory/reflection.py`、`im_reflection.py`、`memory_compress.py` |
| Knowledge reflection | Memory 反思明确产生的候选 + RAG candidates | Knowledge operations | `knowledge/reflection.py` |

两者都调用 `ContextBranch`，但不得共享业务输出解析器或 writer。Knowledge 反思是否作为独立分支由后续阶段决定；第一阶段至少必须使用同一 provider runner 和预算审计。

## 5. 输入组装与 Cache 规则

统一顺序：

```text
provider system / stable prompt
→ baseline snapshot
→ scope 固定信息
→ 本次 delta
→ 分支专用任务要求
```

- 稳定 Prompt、schema 说明和 baseline 放在前部。
- 当前时间、RAG 结果、当前 turn、reflection batch 等动态内容放在后部。
- 不把 `content_hash`、内部 scope id、score、revision 等诊断字段直接注入模型正文。
- 分支输出不作为主对话的 tool result 或普通 history 消息写回。
- 压缩成功后只提交一个新的 session baseline；反思成功后只写入对应 memory scope，并通过 RAG revision 事件让下一轮读取新内容。

### 5.1 与 Batch/Canonical History 的兼容约束

主对话的 Batch 归一化由 `PRD-LLM-14-Batch单一事实源与Canonical History一致性` 管理，
不改变 ContextBranch 的旁路职责：

- ContextBranch 输入保持 `stable_system + baseline/snapshot + delta` 的分支字符串契约，不直接构造或追加 `NewMessageBatch`。
- ContextBranch 的请求和返回不得写入主对话 `PromptMessages`，也不得被记录为 `tool_call`、`tool_result`、普通 user message 或主对话 Batch。
- 压缩结果由 baseline coordinator 以一次明确的 baseline 提交处理；反思结果由 memory/knowledge writer 处理。只有这些 writer 明确生成的主对话事件，才允许进入 canonical history。
- ContextBranch 的动态上下文、scope/revision、fingerprint、usage 和 retry 诊断不得进入主对话正文或 Provider cache 前缀。
- 后续如果需要在主对话中展示分支状态，必须建立独立的 canonical event 类型和持久化规则，不能直接复用分支请求/响应 payload。

## 6. Budget、Overflow 与失败语义

- 所有分支调用共享 `ContextBudget` 的 provider usage 口径。
- 正常 provider 请求不使用本地估算提前触发压缩。
- provider overflow：`ContextBranch` 返回结构化 `overflow`，由压缩分支压缩旧 history 后重新组装并 retry。
- 反思分支超限：优先减少 delta（按批次/字符上限），必要时调用同一压缩适配器生成输入摘要；不得改变主 session baseline。
- 结果必须区分：`below_threshold`、`overflow`、`provider_error`、`output_empty`、`schema_invalid`、`budget_inconsistent`、`persist_failed`、`completed`。
- 所有失败不覆盖旧 baseline/旧 memory；保留脱敏 fingerprint、usage、attempts 和 return_reason。

## 7. 并发与持久化

- 主 session 的压缩仍遵守 session gate；压缩完成并提交 baseline 前不得释放 gate。
- 反思是后台分支，不阻塞主回复，但同一 scope 的反思任务必须由 cursor/幂等键串行提交，不能旧结果覆盖新结果。
- `ContextBranch` 不把进程内 task 集合当作事实来源；跨 worker 状态由数据库 baseline/scope cursor 持久化。
- baseline、scope revision 和 memory RAG revision 的提交顺序必须可观测。

## 8. 实施 Todo

### Phase 0：边界与基线盘点

- [x] 统计三类分支当前的输入字段、输出字段、provider 参数、错误处理和持久化入口。
- [x] 建立重复代码清单，区分可抽取公共逻辑与必须保留的领域逻辑。
- [x] 记录当前压缩/反思输入字符、provider usage、失败率和 cache fingerprint 基线。
- [x] 确认 `ContextBudget` 为唯一预算来源，禁止新增第二套预算名称。

完成记录（2026-08-28）：确认 `compaction.py`、`reflection.py`、`im_reflection.py`、
`memory_compress.py` 的领域输入与 writer 保持独立；provider 路由和 JSON 解析原先集中在
`memory/_llm.py`，但缺少统一的分支输入、结果和审计边界。当前基线不改变业务触发、
预算或持久化策略。

### Phase 1：建立 ContextBranch 公共组件

- [x] 新增 `branch.py`、`branch_types.py`、`assembler.py`、`provider_runner.py`。
- [x] 将 `_llm.py` 的 provider 路由、JSON 解析和异常分类下沉到 `provider_runner.py`；保留兼容导出后再删除旧入口。
- [x] 实现稳定前缀 + delta 组装，统一 fingerprint 和 provider usage 日志。
- [x] 增加 branch 单元测试、schema 错误测试、provider overflow 测试和 cache 顺序测试。

完成记录（2026-08-28）：`ContextBranch` 已提供固定顺序组装、text/JSON 两种输出模式、
重试、provider 错误/空输出/schema 无效分类和脱敏 fingerprint 日志。`memory/_llm.py`
仅保留兼容导出，不再维护 provider 实现。Phase 2/3 才会替换现有业务调用，因此本阶段
不会改变反思、压缩或 memory writer 的运行行为。

### Phase 2：迁移 CompactionBranch

- [x] 将 `compaction.py` 的 provider 调用、重试、return_reason 接入 `ContextBranch`。
- [x] 保持最近 5k 原文、旧 history 滚动 summary ≤10k 字符和唯一 baseline 语义不变。
- [x] 删除压缩模块重复的 provider 调用、预算诊断和错误分类代码。
- [x] 验证现有压缩专项回归；overflow retry、90% 收尾压缩、baseline CAS 仍由原领域流程负责。

### Phase 3：迁移 ReflectionBranch

- [x] owner 反思改为通过 `ContextBranch` 执行，保留当前 Prompt 与 turn payload。
- [x] group/member 反思改为通过 `ContextBranch` 执行，保留 scope batch payload。
- [x] daily/event memory 压缩保持记忆领域独立，直接调用共享 `provider_runner`，不改变事件章节和 RAG 去重规则。
- [x] 保留各 Prompt、输出 schema、profile/pattern/daily/event writer，不把领域字段写入公共组件。
- [x] 反思分支统一记录 branch、scope、session/run 标识及 input/output fingerprint；持久化状态仍由领域 writer 负责。

完成记录（2026-08-28，后于 2026-09-02 修订）：对话压缩、owner 反思和 IM 群/成员反思切换到
`ContextBranch`。daily/event memory 沉淀改由 `memory/memory_compress.py` 直接调用共享
`provider_runner`，重试、事件日期校验和持久化保护由记忆领域负责。

### Phase 4：Knowledge 与跨 scope 收口

- [x] Knowledge reflection 复用 `ContextBranch` runner，不再维护第二套 provider 分支。
- [x] owner/group/member/knowledge 统一通过 branch metadata 记录 scope revision、attempts 和 return_reason。
- [x] scope 与 revision 仅进入审计元数据，不进入 provider user 输入，RAG revision 更新不污染主 history 或前缀缓存。
- [x] 增加跨 scope 前缀稳定、失败重试、provider error 和旧结果不覆盖回归测试。

完成记录（2026-08-28）：Knowledge 反思已迁移到 `ContextBranch`；新增 `scope_revision` 审计字段。组装器不再将 scope/revision 写入模型正文，保证不同 scope 的相同 system+delta 保持相同输入前缀；回归测试覆盖跨 scope 指纹稳定与失败分类。三组 devserver 真实会话的反思/压缩 A/B 结果见 `docs/reports/2026-08-28-TEST-CONTEXTBRANCH-PHASE4-AB.md`；未脱敏正文仅保存在本机 `/tmp/ContextBranch-Phase4-AB-20260828-未脱敏.md` 与同名 JSON。

### Phase 5：清理重复实现与上线验证

- [x] 删除 `_llm.py`、各 reflection 模块和 compress 模块中的重复 provider wrapper、JSON 解析、错误分类和预算计算。
- [x] 删除旧的独立分支入口、无效兼容参数、进程内 task 事实状态和重复常量。
- [x] 保留必要的领域兼容导出，但在迁移完成后移除并更新所有调用方。
- [x] 更新 PRD-AGENT-4、PRD-MEM-2、PRD-IM-11 及上下文架构文档的交叉引用。
- [x] 完成 backend 全量测试、分支专项测试、LoopScope 输入顺序对照和 devserver 验证。

完成记录（2026-08-28）：删除 `agent/memory/_llm.py`，反思、事件记忆压缩、会话压缩和
Knowledge 反思均直接通过 `ContextBranch` 的唯一 provider runner；测试与维护脚本同步切换
到 `agent.context.provider_runner`。移除了领域侧重复的 provider wrapper/JSON 入口和显式
runner 绑定，保留 `ContextBranch.run(..., runner=...)` 作为测试注入 seam，不作为生产分支。
同步补充了 AGENT-4、MEM-2、IM-11 和上下文架构文档的交叉引用。专项回归 119 项全部通过；
devserver 全量测试共 1601 项，其中 1584 项通过，17 项为当前工作树中既有的消息 canonical
格式与时间上下文断言失败，未涉及 ContextBranch 改动，已单独记录，不能作为本次迁移的通过依据。

## 9. 清理清单

完成迁移后必须审查并清理：

- `agent/memory/_llm.py` 中被 `provider_runner.py` 完全替代的实现；
- `reflection.py`、`im_reflection.py`、`memory_compress.py` 中重复的 provider client 创建、JSON 提取、异常吞并和 max token 计算；
- 任何基于本地 token 估算触发反思/压缩的旧分支；
- 任何把反思结果伪装成普通 history/tool result 的兼容包装；
- 任何只在单 worker 内存中维护 baseline、cursor 或“正在处理”状态的实现；
- 重复的 branch 日志、fingerprint、timeout、retry 常量和 scope 拼接函数；
- 已被 `ContextBranch` 替代的旧 PRD TODO、注释和死代码。

清理原则：先迁移调用方和测试，再删除旧实现；不得通过保留两套逻辑长期兼容来掩盖迁移未完成。

## 10. 验收标准

- 对话压缩与反思通过 `ContextBranch` 调用 provider；daily/event memory 压缩直接调用共享 `provider_runner`。
- 三类任务共享 provider 路由和 JSON 解析基础，但不共享不必要的 branch 生命周期或领域输出 writer。
- 两类分支均能从 baseline/snapshot + delta 组装输入，不加载无界全量 history。
- provider usage、overflow、重试、错误原因和持久化状态可用同一日志结构对照。
- 压缩不会改变反思业务结果；反思不会改变主 session 的压缩 baseline。
- 旧 baseline、旧 memory 在分支失败时保持不变。
- 连续 run 的稳定前缀不因分支诊断字段、RAG revision 或 reflection 输出而无故断裂。
- 迁移后重复 provider wrapper、重复预算逻辑和死代码被删除，代码量不因复制兼容层持续增长。
- backend 专项和全量测试通过，并在 devserver 完成至少一轮 owner、群组、platform-user、overflow 压缩和反思持久化验收。

## 11. 非目标

- 本 PRD 不改变 profile、pattern、daily、summary、event memory 的业务定义。
- 不改变压缩最近 5k 原文、summary 上限 10k 字符和唯一 baseline 规则。
- 不把反思改成同步阻塞主回复的任务。
- 不在本阶段迁移 provider、FastAPI、数据库 ORM 或 RAG 引擎。
- 不通过新增第三套“反思预算”或“记忆预算”解决输入过大的问题。
