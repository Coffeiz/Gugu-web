# N3 Agent Harness 行为迁移与验收映射

更新：2026-11-13。基线工作区为 `Ningxue/n3`，参考 HEAD 为 `dbedef7e`。本文只记录 Harness 的职责、旧行为来源与实际验证状态，不把 Provider、工具、数据库适配器、Job 或 Host 的端口定义计为功能迁移。

[逐 Python 定义映射](node-agent-harness-parity.json) 是本专题的细目清单。初始盘点包含用户指定的全部 **58 个 Python 文件、516 个 `test_` 定义**；这是源码定义数，不是 pytest 收集数或参数化用例数。每条保留 Python 节点、源码行、职责分组、TS 对应测试、状态和缺口；当前没有运行结果的条目不能记为通过。生产架构见 [架构说明](../refactor/Gugu-2.0-架构说明.md)，整体进度见 [迁移清单](../refactor/Gugu-2.0-迁移任务清单.md)。

## 固定目录职责映射（先于本轮结构调整）

现有职责均由用户指定的18个实现文件承载，没有扩展固定树。下表先确定 Python 生产调用链及行为归属；JSON 的每个已映射定义另含 targetModules。本轮先完成映射，再归位实现及测试；固定树调整后的完整Core回归为30文件、506通过、0失败/跳过。混合engine测试拆入run/streaming/interactions，使用不注册测试的共享fake fixture。

| 固定位置 | Python 生产链及 pytest 契约 |
| --- | --- |
| harness.ts / index.ts | runner.collect/stream 组合入口；不承载状态和协议业务 |
| contracts.ts / ports.ts | Run/Canonical/事件领域契约；Data、Provider、Tools、时钟及发布依赖 |
| run/lifecycle.ts | loop.runner、reply/tool-intent/decision guard；test_run_lifecycle、core_loop_characterization |
| run/cancellation.ts | run.cancellation、llm.genstream；test_run_cancellation、test_genstream_cancel |
| run/finalization.ts | context.run_finalize；成功/失败/取消事务、摘要水位、已完成结果保护 |
| history/canonical-history.ts | context.assembly/canonical_tool_history；MessageArea、批次副本、工具原子单元 |
| history/ordering.ts | context.history/chat_timeline；序号、游标、晚消息、重载顺序 |
| history/attachment-refs.ts | 历史轻量引用、工具媒体 checkpoint 固化与 owner/身份校验 |
| context/prepare.ts | run.preparation、session_snapshot/loaders；可信来源、TTL、并发发现/RAG与能力过滤 |
| context/assemble.ts | context.run_context/assembly；snapshot→history→stance/RAG→当前用户→dynamic tail |
| context/budget.ts | context.budget；当前请求实际用量、85%门限、overflow完整单元 |
| context/compaction.ts | context.compaction；摘要边界、保护窗口、候选成功后物化 |
| context/reflection.ts | reflection branch/snapshot；冻结主请求、scope、缺快照延后；持久Job由外部端口承接 |
| streaming/coordinator.ts | loop driver/collect；归一Provider事件、工具回执的串行提交和事件顺序 |
| streaming/backpressure.ts | stream consumer及并行批次；慢消费、提前return、取消后资源排空 |
| interactions/coordinator.ts | interactions/confirmation/resume；单次回执消费、等待队列与崩溃恢复 |

真实 Provider wire/thinking/signature 投影、Tools registry/参数校验/dispatch 和共享持久 jobs/lease/outbox 实现不搬进 Harness。后续 Provider 切片现已提供实际反思追加、摘要 wire 转换和分支调用适配，并通过实际 Harness 快照的四协议三阶段摘要恢复；详见 [Provider 验收](node-agent-provider-parity.md)。Tools、持久 jobs/lease/outbox 仍保持明确端口依赖，不造空实现；本清单不据此批量升级旧 Host/Data 条目。

## 生产调用链和迁移责任

Python 的 `agent/runner.py` 统一 collect/stream 入口，经 `agent/run/preparation.py` 解析可信用户、会话、模型、附件、快照/历史、工具目录和 RAG，再进入 `agent/loop/runner.py` 的模型/工具循环。`agent/context/run_context.py` 与 `context/assembly/` 建立 Canonical MessageArea；`context/run_finalize.py` 在一个事务中写 Canonical delta、展示记录、用量和 reasoning 状态，提交后再通知/交付。Web 的 `gateway/web/run_lifecycle.py`、`llm/genstream.py` 和 IM 的 stream bridge 承担渠道运行状态与交付，不能搬入可移植 Core 后顺手依赖 Redis 或平台 SDK。

| 责任层 | 本切片必须迁移的行为 | 端口及后续责任方 |
| --- | --- | --- |
| Harness context | 不可变 Canonical Area、单调顺序与 revision、历史恢复/保留/持久 delta、固定前缀与动态尾部、准备和预算/压缩/反思分支编排 | Data 提供 owner-scoped 行与原子持久化；Provider 提供不可变历史投影和分支调用；Media/RAG 提供内容解析与召回 |
| Harness runtime | Run 启动/恢复/取消/终态、模型/工具循环、交互等待恢复、事件身份顺序、背压和先提交后发布 | Host 注入可信身份、取消/时钟/发布；RunStore 提供 fenced lease、CAS checkpoint 和 outbox；Tools 提供经确认门的 dispatch |
| Provider | 协议角色、原生 thinking/signature、原始工具参数字节和 wire 修复 | 独立 Provider Adapter；Harness 不重渲染已经冻结的 wire，也不编造 token 用量 |
| Tools / Executor | 注册表/权限/确认授权、具体工具业务、原生进程与隔离 | 工具通过现有 `agent/executor/` 契约执行；Harness 负责调度及取消，不另造执行路径 |
| Data / Interaction Store | SQL/schema 迁移、owner 过滤、锁、receipt、原子 finalize、交互 token 单次消费 | Core Data Adapter 负责真实双库/重启/并发验收；Harness 测试中的内存 adapter 只验证契约 |
| Reflection / Memory / Title Job | 持久反思队列、空闲扫描/协调标记、重试和游标、长期记忆 CAS、标题任务 | 独立 Job 实现；Harness 输出快照与运行结果，并调用明确分支端口 |
| Host / Channel | HTTP/SSE、QQ payload 解码、平台绑定、凭据/配置、Redis transport、进程装配 | Web/IM/Desktop Host；本任务不修改这些入口或切换生产调用方 |

持久化必须把 Run 状态、Canonical delta、receipt 和需要可靠投递的 outbox 放在同一原子边界。租约和 fencing 的真实存储实现归 Data/Host；Harness 在续租失败或版本冲突后不得继续发事件、写终态或自动重放未知结果。把这层仅描述为 `save()` 而没有冲突/幂等契约，不能证明重启恢复已迁移。

## 需要独立保护的高风险契约

1. **入口错误/取消和已完成部分的中断收尾有区别。** `test_run_lifecycle.py` 禁止把直接 error/cancel 当成功 finalize/publish；`test_run_finalize.py` 要求真正已完成的工具 Canonical 历史能在中断后恢复。不能用统一“取消则丢弃全部”或“所有异常都保存成功结果”替代。
2. **Canonical 与展示记录分离。** 失败/中断结果有独立状态，不把 outcome 当模型消息；工具调用与结果是原子单元。迟到群消息和取消时间线在重载后仍先于下一条继续输入，序号按 session 独立且单调。
3. **快照/前缀和本轮输入有严格位置。** 固定 snapshot 在历史前，RAG/引用在当前用户前；已持久当前输入不重复恢复，动态尾部不进入持久历史。当前媒体可留内存，历史只保存轻量引用与受限图片回放快照。
4. **预算使用同请求实际 Provider 输入。** `fresh input + cache read + cache write` 达到窗口 85% 才自动压缩；未知用量维持未知。Provider 明确超限才使用有限 overflow 恢复，保留完整工具单元、固定前缀与受保护尾部；没有可压缩历史时不偷偷走 overflow 截断。
5. **冻结 Provider 投影不能降成裸列表重新渲染。** 快照绑定 owner/session/model、revision、digest 与边界；同模型原生 signed thinking 应由 Provider 保留。反思缺少原始快照时按规则延迟，普通跨进程群反思不能静默用持久历史代替。
6. **取消必须锚定 owner Run。** durable cancel marker 先于 active signal；旧 marker、旧 generation 的 end 不能终止新 Run。等待 Provider 的下一 token 也必须能取消；已经完成的工具结果胜过随后到达的取消，串行余下调用不启动，并行兄弟停止。
7. **事件提交、背压和重放都有边界。** display event 使用稳定 ID，重复更新不移动位置，IM tuple 不能变成第二份展示源。终态已提交后通知失败不能回滚成功状态；晚订阅者仍能补读 done，慢消费者不应触发无限队列或伪成功。
8. **安全行为不能放入模型提示词。** owner 由 Host 身份注入，工具授权/确认由代码和 Executor 决定；错误、trace 与缓存诊断只暴露允许字段、摘要或指纹，不能回显正文/附件 URL/token/原始异常。

## 测试映射的判定规则

| 状态 | 判定 |
| --- | --- |
| 待逐项审查 | 已盘点，尚未逐条完成实现/断言/TS回归的责任核对；不直接推断功能未实现 |
| 已实现待补回归 | 源码已存在对应规则，仍缺足够明确的 TS 行为回归；不计迁移完成 |
| 已实现待运行 | TS 已通过代码审阅映射到旧契约，本轮尚未运行 |
| TS 通过待基线 | 对应 TS 套件已通过，Python 完整执行及差异核对尚未完成，不能据此判断等价 |
| 部分覆盖 | 原测试只被部分替代；`gap` 必须写清未覆盖分支/集成边界 |
| 端口依赖待验收 | 对应职责在独立 Provider/Tool/Data/Job/Host；端口定义或 fake adapter 通过不等于真实适配器完成 |
| 已验收 | 已审阅契约、明确差异，并有本轮相关 Python 与 TS 运行通过证据 |

一项 TS 测试可以保护多个 Python 用例的共同契约，但必须审查断言实际覆盖每项结果、边界和副作用。不能仅凭文件名相似、源码含有函数名或全套测试绿色批量填“已验收”。原 Python 基准不为获得绿灯而修改、放宽或跳过。既有用例即使跨层，也继续保留在清单中并说明责任。

## 验收运行方式

用户已进一步授权在本地原生环境串行验收，不使用 Docker。命令使用仓库相对路径，解释器使用项目现有测试环境。Python 从 `backend/` 运行，并在导入路径中包含当前目录和 `compat/core-python/src`；POSIX 用 `:` 分隔，Windows 用 `;`。Windows collection 曾被 `fcntl` 阻塞；受支持原生 Linux 环境现已完成 collection 与全部执行，以下为该类环境的入口。测试必须使用临时存储和显式隔离服务，不读取或覆盖运行配置。

```sh
cd backend
PYTHONPATH=.:../compat/core-python/src <现有测试环境>/bin/pytest --collect-only -q \
  tests/agent/test_run_*.py tests/agent/test_interaction_*.py \
  tests/agent/test_genstream_cancel.py tests/agent/test_im_web_stream_bridge.py \
  tests/agent/context tests/agent/chat/test_message_area*.py \
  tests/agent/chat/test_message_compaction_boundary.py \
  tests/agent/providers/test_provider_history*.py
# 确认收集范围后，以相同范围执行 pytest -q；不使用 xdist。
```

Node 使用已准备的原生 Node 26，经 Core 显式 suites 清单运行本专题已登记测试；类型检查、依赖边界和测试元数据必须同步。父 Agent 负责汇总命令和结果，防止多个子 Agent 同时运行共享环境测试。真实服务因缺少隔离连接跳过时，分别报告通过/失败/跳过，不能合并成“通过”。

定向复跑入口如下；结果按本轮实际完整运行记录维护，不把这段命令本身当执行证据。

```sh
cd gugu-core
node --version  # 必须为 26.x
node node_modules/vitest/vitest.mjs run tests/agent/harness --maxWorkers=1 --no-file-parallelism
```

本轮复查确认的问题已修复，逐项证据以 JSON 为准；部分覆盖及真实适配依赖仍不计完整迁移。当前清单不授权切换生产 Run、删除 Python 实现、提交、推送或触发 CI。

### 当前阶段证据与 Core 审计结论

- **Core：原生 Node 26，30 文件、506 项全部通过，0 失败、0 跳过。** 命令为 Core 目录下 `node scripts/run-tests.mjs unit`，包含全部 23 个 Harness 测试文件；测试源码 `tsc --noEmit`、注册检查和 `git diff --check` 同步通过。目录拆分新增13项合法状态转换及2项凭据持久化边界；原有断言不放宽。此前19文件/383项中的完成先于取消竞态已修复，历史失败记录保留在 JSON，不能把它当作当前结果。
- **Python：原生 Linux/Python 3.12，76 文件、918 项全部通过，0 失败、0 跳过。** collect-only 用时 5.01 秒；串行执行用时 38.32 秒，4 条弃用提示（Sudachi 1 条、Redis setex 3 条）。依赖使用仓库原 requirements、dev 与 compat；隔离副本排除用户 `.env`/override，使用临时 config/storage、fake Redis 和 SQLite，未修改 Python 基准。此前 Windows 因 `fcntl` 导入导致 collection 未完成、0 执行的记录仅作为历史保留。737 是映射选定源码定义数，918 是文件全量执行数，包含参数展开及混合文件其他定义。
- **737 个定义全部有当前责任与状态。** 381 项有明确 TS 行为映射：149 项完整映射已验收，232 项仍为跨层/API 部分覆盖；另 356 项保留具体 Provider/Tools/Data/Job/Host 或架构差异责任。部分覆盖中包含尚未逐断言核验的组合和 API 差异，不能宣称所有必要 fixture 已齐；`verifiedMigrated` 为 149，不能从两套测试全绿推断全部原 Python 逐断言等价。

本轮复查撤回此前“没有内部 Core 缺口、必要回归已全部闭合”的结论。此前部分条目只验证 helper 或 fake Context，未证明真实组合行为；另有 `previousGap` 尚未提供对应证据，却被总述归为已关闭。现在按具体断言补充映射，未证明的差异继续保留为部分覆盖，不把 Python 基准和 TS 两套绿灯当逐断言等价证明。149 项已验收数未因新增测试而批量升级。

### 本轮复查修复

- **准备主链**：首次用户 Skill 元数据写入同一会话快照候选，下一 Run 使用冻结值，拒绝目录漂移；actor 访问范围变化重建时不继承 owner 的私有 Skill 元数据。能力目录只接收过滤后的工具 Schema，并接收本轮原始 query。
- **定时任务边界**：可信任务主体驱动任务准备，禁止继承交互历史/恢复标记，跳过交互 RAG，当前输入仅用于本请求。Shell 状态只进 system，任务授权主体保留。
- **真实空答重试**：空答不仅增加计数，还将追问放入下一轮模型上下文；真实回复策略组合验证空答→工具成功→空答→最终回复，以及进度 draft 和 guard 隐藏。
- **超限分类**：SDK body 的循环引用、BigInt 与访问器不会使错误分类崩溃或执行访问器；输出限制不冒充输入超限。
- **职责依赖**：稳定附件和工具结果快照归 history，调度计划归 streaming；history 不再运行时导入 streaming 或 interactions，增加依赖方向回归。固定 18 文件与公开导出名不扩展。
- **遗漏组合回归**：31 个连续任务工具轮、三个不同串行工具、普通回答关闭 waiting、成功压缩后的重复阈值、带旧历史的 RAG 锚点、连续继续/三次失败回复/成功失败工具回放、图片音频视频与可选引用、question/confirmation 显示前 flush，以及 baseline 替换保留动态尾部。

本次比此前 478 项新增 28 项，完整 Core 快速层为 **30 文件、506 通过、0 失败、0 跳过**，测试源码类型检查通过。Python 本轮未修改、未复跑，沿用上一轮原生 Linux 的 76 文件/918 项通过基准。测试中的 Provider、Tools、存储和事件端口替身只用于观测真实 Core 的行为；`RunStore` 接口、fake lease/outbox 和分支 Provider 不证明真实持久化、跨进程恢复或生产调用链完成。

### 已复核的 Core 主链

标准 `createCanonicalHarness` 已真实接入 `runPreparation`：owned 来源→共享取消下工具发现与一次 RAG→可信主体的配置/Shell/目录过滤→system/snapshot 分区与固定前缀→Canonical 准备。选中名称和稳定 Schema 进入 Provider 请求上下文，未开放工具不会派发。保留低层自定义 load API，但没有完整 capabilities 时明确失败，不能把来源 helper 单独当完整准备入口。

Canonical Area、批次副本/revision、授权媒体引用 checkpoint、用户时间/引用/群批次/历史回放、会话 TTL 与策略绑定、同请求实际输入压缩/rolling/有界 overflow、真实语言规则、serial/mixed parallel 调度、交互收据与终态恢复、工具安全展示、取消清理和成功反思捕获均已有行为回归。真实 Canonical 取消组合验证完成的工具 pair 和部分正文保留、摘要水位不前移、下一 Run 顺序一致；错误/提前 EOF 不把草稿伪装为成功历史。

独立审查要求并复核的安全边界包括 owner warm→restricted 快照重建、反思缓存全链访问指纹、普通用户字面摘要标记不被吞、工具结果稳定引用固化、native_failure 即使被 Tools 吞错也强制 unknown，以及消费者提前 return 先取消 Provider 网络再等待回收。原生 continuation 只以独立安全引用交接，原 wire/签名不进入 durable Canonical。成功事务提交后通知失败不回滚业务。

### 差异与仍待外部验收的责任

N3 使用 EntryInput/Area batch 替代 Python MessageBatch/CanonicalTurn 类；不为旧类名或模块重导出机械增加 API。摘要识别改为严格 wrapper，防止用户字面标记误判。mixed 批次先固化全部 siblings 的回执和 Canonical，再激活首个交互门；Host 需要按新内部事件投影。goal 工具草稿保留旧 Python 的隐藏策略，普通 draft/交互前 flush 回归只证明非 goal 路径。

仍需真实验收的独立实现包括：Provider 协议/usage/native continuation；Tools 注册表、MCP、业务工具和确认服务；SQL/Redis 的 owner 查询、CAS/fence/receipt/outbox、媒体/引用与私有加密记录；Reflection/Knowledge/Memory/Title 持久 Job；Web/IM/Desktop Host、SSE、平台桥接和配置。内存 fake 只证明 Core 契约，不证明这些服务实现完成。每条 Python 定义继续保留原来源与责任，不把它们计为 migrated。

## Python 基准文件完整索引

初始指定家族为 58 文件/516 定义；沿生产链扩展后，当前共 **76 文件/737 定义**。新增主循环特征、并行工具、collect sink、展示事件、reasoning 边界、引用与分支缓存家族；另从 Provider 搜索混合文件中只纳入直接保护 Schema 刷新/历史不变性的一个定义；新增真实语言分类后，又纳入既有 tool-intent/decision-guard 两文件的全部 13 定义。混合文件选择范围在 JSON 中注明。定义数未包含参数化展开，不能与执行数量相加。

| Python 文件（相对 `backend/tests/agent/`） | 定义数 | 职责分组 |
| --- | --- | --- |
| `chat/test_message_area_provider_projection.py` | 6 | Harness/context |
| `chat/test_message_area.py` | 9 | Harness/context |
| `chat/test_message_compaction_boundary.py` | 11 | Harness/context |
| `chat/test_message_roles.py` | 2 | Harness/context |
| `context/test_branch_request_prefix.py` | 3 | Harness/context |
| `context/test_cache_drop_probe.py` | 14 | Observability / Harness 边界 |
| `context/test_canonical_context.py` | 5 | Harness/context |
| `context/test_canonical_tool_history.py` | 17 | Harness/context |
| `context/test_chat_timeline_migration.py` | 15 | Data Adapter / Migration |
| `context/test_compaction.py` | 62 | Harness/context |
| `context/test_context_assembly.py` | 2 | Harness/context 与标准准备组合 |
| `context/test_context_audit.py` | 1 | Observability / Harness 边界 |
| `context/test_context_branch.py` | 13 | Harness/context |
| `context/test_context_budget.py` | 8 | Harness/context |
| `context/test_context_cache_boundaries.py` | 19 | Observability / Harness 边界；Harness/context |
| `context/test_context_history.py` | 18 | Harness/context |
| `context/test_context_loader_query_scaling.py` | 1 | Data Adapter / Migration |
| `context/test_context_overflow_classification.py` | 6 | Harness/context；Host Configuration |
| `context/test_context_retention.py` | 4 | Harness/context |
| `context/test_context_revision.py` | 2 | Data Adapter / Migration |
| `context/test_conversation_order.py` | 4 | Data Adapter / Migration |
| `context/test_conversation_run_outcomes.py` | 2 | Data Adapter / Migration |
| `context/test_conversation_sequence_migration.py` | 1 | Data Adapter / Migration |
| `context/test_cross_run_cache_prefix.py` | 10 | Harness/context 与标准准备组合 |
| `context/test_daily_compaction.py` | 2 | 独立 Reflection Job / Memory |
| `context/test_history_attachment_refs.py` | 4 | Harness/context |
| `context/test_history_persist_filter.py` | 9 | Harness/context |
| `context/test_im_source_prompt.py` | 3 | Host / IM Adapter |
| `context/test_inline_compaction_progress.py` | 4 | Harness/context |
| `context/test_longterm_compaction.py` | 5 | 独立 Reflection Job / Memory |
| `context/test_reflection_append_reuse.py` | 16 | Harness/context + 独立 Reflection Job |
| `context/test_reflection_byok.py` | 2 | 独立 Reflection Job / Memory |
| `context/test_reflection_failure_lifecycle.py` | 12 | 独立 Reflection Job / Memory |
| `context/test_reflection_snapshot.py` | 15 | Harness/context + 独立 Reflection Job |
| `context/test_reflection_threshold.py` | 15 | 独立 Reflection Job / Memory |
| `context/test_reflection_units.py` | 7 | 独立 Reflection Job / Memory |
| `context/test_session_execution_gate.py` | 10 | Harness/runtime 与 Canonical 组合 |
| `context/test_session_history.py` | 11 | Harness/context |
| `context/test_session_snapshot.py` | 35 | Harness/context |
| `context/test_session_title_prompt.py` | 3 | Session Title Job / Host Locale |
| `context/test_stance_history.py` | 3 | Harness/context 与标准准备组合 |
| `context/test_summary_covers_watermark.py` | 4 | Data Adapter / Migration |
| `context/test_tool_media_projection.py` | 3 | Harness/context |
| `knowledge/test_knowledge_append_reuse.py` | 6 | Harness/context + 独立 Reflection Job |
| `knowledge/test_reference_context.py` | 10 | Data Adapter / Migration；Harness/context 与标准准备组合 |
| `providers/test_baseline_run_summary_reuse.py` | 7 | Harness/context |
| `providers/test_provider_history_adapters.py` | 5 | Provider Adapter |
| `providers/test_provider_history.py` | 10 | Provider Adapter |
| `providers/test_provider_runner_cache.py` | 16 | Harness/context |
| `providers/test_stream_round_retry.py` | 16 | Provider Adapter |
| `test_agent_loop_modules.py` | 19 | Harness/context；Harness/runtime 与 Canonical 组合；Observability / Harness 边界 |
| `test_capability_injection.py` | 6 | Harness/context 与标准准备组合 |
| `test_core_loop_characterization.py` | 54 | Harness/runtime 与 Canonical 组合 |
| `test_display_event_contract.py` | 4 | Harness/runtime + Host Stream Adapter；Data Adapter / Migration |
| `test_genstream_cancel.py` | 16 | Harness/runtime + Host Stream Adapter |
| `test_im_web_stream_bridge.py` | 2 | Harness/runtime + Host Stream Adapter |
| `test_interaction_events.py` | 2 | Harness/runtime + Interaction Store / Tools |
| `test_interaction_phase5_7.py` | 5 | Host / IM Adapter |
| `test_interaction_protocol.py` | 26 | Harness/runtime + Interaction Store / Tools |
| `test_interaction_retention.py` | 3 | Data Adapter / Migration |
| `test_logic_blindspots.py` | 4 | Harness/context |
| `test_loop_driver_usage_semantics.py` | 10 | Provider Adapter |
| `test_parallel_tool_policy.py` | 14 | Harness/runtime 与 Canonical 组合 |
| `test_provider_web_search.py` | 1 | Harness/context |
| `test_reasoning_state.py` | 16 | Provider Adapter |
| `test_run_cancellation.py` | 11 | Harness/runtime 与 Canonical 组合 |
| `test_run_capability_assembly.py` | 3 | Harness/context 与标准准备组合 |
| `test_run_context_boundaries.py` | 9 | Harness/context 与标准准备组合 |
| `test_run_finalize.py` | 18 | Harness/runtime 与 Canonical 组合 |
| `test_run_lifecycle.py` | 4 | Harness/runtime 与 Canonical 组合 |
| `test_run_preparation_parallel.py` | 2 | Harness/context 与标准准备组合 |
| `test_run_preparation_parity.py` | 3 | Harness/context 与标准准备组合 |
| `test_run_timeline_order.py` | 1 | Harness/runtime 与 Canonical 组合 |
| `test_runner_collect.py` | 23 | Harness/runtime + Host Stream Adapter；Host / IM Adapter |
| `test_tool_intent_guard.py` | 9 | Harness/runtime 与 Canonical 组合 |
| `test_decision_guard_policy.py` | 4 | Harness/runtime 与 Canonical 组合 |
