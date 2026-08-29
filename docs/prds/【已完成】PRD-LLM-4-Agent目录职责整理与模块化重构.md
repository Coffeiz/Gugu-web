# Agent 目录职责整理与模块化重构 PRD

> 状态：✅ 已完成（目录归组、职责复审、旧路径收敛和全量回归均已完成）
> 创建：2026-08-08
> 最近更新：2026-08-09
> 所属层：Agent / 后端模块化
> 关联模块：`backend/agent/`、`backend/app/api/v1/agent.py`、`backend/app/api/v1/agent_admin.py`、`backend/app/scheduled_tasks.py`
> 关联文档：[[PRD-LLM-1-provider适配层重构与core瘦身.md]]；[[PRD-LLM-3-provider供应商适配层整体整理.md]]

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 根目录现状盘点 | ✅ 已完成 | 已确认 `backend/agent/` 根目录存在业务/基础设施模块，职责横跨运行时、LLM、上下文状态、安全、领域服务和兼容入口。 |
| 目标目录设计 | ✅ 已完成 | 确定优先整理 `security/`、`llm/`、`runtime/` 三组；`core.py`、`runner.py`、`router.py` 等顶层编排模块暂不强拆。 |
| 实施计划与依赖门槛 | ✅ 已完成 | 已明确 LLM-3 对 `providers.py` 的优先接管关系、各 Phase 的迁移边界、验证矩阵和回滚方式。 |
| Phase 1：安全模块归组 | ✅ 已完成 | 已迁入 `security/`，根目录保留仅转发导出；生产代码已切换 canonical import，安全/核心重点测试 46 个通过。 |
| Phase 2：LLM 非 Provider 基础设施归组 | ✅ 已完成 | 已迁入 `llm/`，根目录保留仅转发导出；`providers.py` 未复制，LLM/核心重点测试 37 个通过。 |
| Phase 3：运行时基础设施归组 | ✅ 已完成 | `runtime_state.py`、`trace.py` 已迁入 `runtime/`；依赖复审后 `loop_drivers.py` 保留为根目录循环控制流入口，运行时/IM/核心重点测试 69 个通过。 |
| Phase 4：领域服务归组 | ✅ 已完成 | 依赖聚类后未发现值得建立新领域目录的稳定边界；保留领域模块在根目录，并记录职责理由，不强行搬迁。 |
| 兼容入口收敛 | ✅ 已完成 | 内部生产代码、测试和脚本已迁移到 canonical path；无引用的根目录兼容模块已删除，并通过完整测试周期。 |

## 1. 背景与目标

### 背景

`backend/agent/` 已经形成了 `context/`、`events/`、`gateway/`、`im/`、`memory/`、`profiles/`、`selection/`、`tools/` 等职责目录，但仍有一批核心模块平铺在 Agent 根目录。当前根目录同时承载：

- Agent 主循环和请求编排；
- LLM provider、流式响应和模型选择；
- 请求级 `ContextVar` 与运行时状态；
- 安全、脱敏、确认门和行为守卫；
- 问候、配额、语音、出站消息等领域服务；
- 被 API、网关、定时任务和测试直接引用的历史兼容入口。

这使新代码难以判断应该放在哪里，也让后续的 Provider、IM 和 Agent Loop 重构容易再次扩大影响范围。当前问题主要是职责可发现性和依赖边界问题，不是单纯的文件数量问题。

### 目标

- 让根目录只保留 Agent 对外编排入口和确实需要作为顶层公共 API 的模块。
- 按职责将安全、LLM、运行时基础设施和领域服务分组。
- 保持现有运行行为、导入语义和测试可用性不变。
- 通过兼容导出分阶段迁移，降低 API、网关、IM、定时任务和测试的集中改动风险。
- 为后续 `providers/` 目录化和 `core.py` / `runner.py` 拆分提供稳定边界。

### 非目标

- 本 PRD 不改变 Agent Loop、工具行为、Provider 行为、IM 协议或数据库结构。
- 不因为文件较大就强行拆分 `core.py`、`runner.py`。
- 不把所有模块统一塞入含义模糊的 `services/` 目录。
- 不在本阶段清理 `.pyc`、`.DS_Store` 等生成物；它们属于独立的仓库清洁任务。

## 2. 功能需求

### FR-LLM-4-1：安全基础设施目录化（✅ 已完成）

建立 `backend/agent/security/`，承载与业务领域无关的安全和输入处理能力：

```text
agent/security/
├── __init__.py
├── confirm.py
├── sanitize.py
├── logsafe.py
└── core_guards.py
```

- `confirm.py`：破坏性操作确认门和确认 token。
- `sanitize.py`：流式输出清洗与敏感/协议内容处理。
- `logsafe.py`：用户输入、附件名等不可见日志字段的指纹化。
- `core_guards.py`：叙事、意图播报、决策回避等 Agent 行为守卫。
- 迁移后不得把原始用户输入、附件名或凭据写入普通日志。

### FR-LLM-4-2：LLM 基础设施目录化（✅ 已完成）

建立 `backend/agent/llm/`，承载不属于具体 Provider 适配器的模型调用基础设施：

```text
agent/llm/
├── __init__.py
├── genstream.py
├── llm_select.py
└── modelctx.py
```

- `providers.py` 不在本 Phase 迁移，由 PRD-LLM-3 负责 Provider 适配层的最终目录和实现形态；LLM-4 只消费其稳定 facade。
- 在 PRD-LLM-3 完成前，`llm/` 不创建 `providers.py` 或 `providers/` 的镜像实现，避免两个 PRD 出现双份注册表。
- `llm_select.py` 保留现有选择函数签名，调用方不因目录整理改变行为。
- `modelctx.py` 继续作为请求级模型上下文，不与业务 `models.py` 混淆。
- `genstream.py` 只承载流式生成基础能力，不把 Agent Loop 控制流移入该目录。

### FR-LLM-4-3：运行时基础设施目录化（✅ 已完成）

建立 `backend/agent/runtime/`：

```text
agent/runtime/
├── __init__.py
├── runtime_state.py
└── trace.py
```

- `runtime_state.py`：跨请求/进程运行状态和 Redis 状态访问。
- `trace.py`：请求级追踪上下文。
- `loop_drivers.py`：暂留 `agent/` 根目录，作为循环控制流入口；只有 Phase 3b 依赖图确认安全后才考虑迁入 `runtime/`，不把工具业务和 Provider 专属判断重新塞回此处。
- 迁移前必须先绘制 `core.py`、`loop_drivers.py`、`providers.py` 的依赖方向，避免扩大现有延迟 import 和循环依赖。

### FR-LLM-4-4：顶层编排入口保持稳定（✅ 已完成）

第一阶段保留以下模块在 `agent/` 根目录：

- `core.py`：Agent 主循环和工具调用控制流。
- `runner.py`：网页、IM、定时任务等入口的运行编排。
- `router.py`：运行路由和运行态选择。
- `models.py`：如果仍被多个领域直接依赖，暂时作为公共模型入口。

它们可以在后续独立 PRD 中继续拆分，但本次不以“根目录必须为空”为验收目标。

### FR-LLM-4-5：兼容导入与渐进迁移（✅ 已完成）

每个迁移模块在原路径保留短期兼容入口，例如：

```python
# backend/agent/providers.py（迁移过渡期）
from agent.llm.providers import *
```

- 兼容入口只做导出，不复制实现。
- 先迁生产代码，再迁测试和脚本。
- 使用 `rg` 检查 `backend/`、`tests/`、`scripts/` 中旧导入路径全部收敛。
- 至少经过一个完整测试周期后，才删除兼容入口。
- 不修改对外 API、Gateway 启动命令、日志 logger 名称或测试 monkeypatch 路径，除非在对应阶段单独记录。

## 3. 技术方案

### 3.1 目标结构

```text
backend/agent/
├── core.py                 # 顶层 Agent Loop
├── runner.py               # 请求/任务运行编排
├── router.py               # 运行路由
├── runtime/
├── llm/
├── security/
├── context/
├── events/
├── gateway/
├── im/
├── memory/
├── profiles/
├── selection/
└── tools/
```

`domain/` 是否建立留到 Phase 4 决定。当前 `behaviors.py`、`decay.py`、`greeting.py`、`quota.py`、`voice.py` 等模块的调用关系较分散，贸然归组的收益低于兼容成本。

### 3.2 依赖边界

- `security/` 不依赖 `runtime/`、`gateway/` 或具体业务工具。
- `llm/` 可以依赖通用配置和安全清洗，但不依赖具体 IM gateway。
- `runtime/` 可以调用 LLM 能力，但不直接实现项目、文件、日历等工具业务。
- `core.py` / `runner.py` 作为编排层依赖下层能力；下层模块不反向依赖顶层入口。
- `tools/`、`im/`、`gateway/` 通过稳定公共接口访问 Agent 能力，不通过跨目录复制逻辑解决依赖。

### 3.3 实施计划

本次按“先建立稳定边界，再迁移实现”的棘轮方式推进。每个 Phase 都能独立回滚，且不混入行为变化、格式化或无关清理。

#### Phase 0：基线、依赖图和公共入口冻结

目标是确认迁移边界，不移动代码。

- 盘点 `backend/agent/` 顶层模块、公共符号、外部导入、`monkeypatch` 路径和脚本入口，形成迁移表。
- 绘制 `core.py`、`runner.py`、`loop_drivers.py`、`providers.py`、`sanitize.py` 的导入方向，标出局部导入和潜在循环依赖。
- 明确兼容策略：新目录是 canonical path，根目录旧文件只保留转发导出，不复制实现、不添加隐式副作用。
- 建立基线：后端全量 pytest、Agent 重点测试、模块导入 smoke；记录当前根目录文件数量和测试结果。
- **依赖门槛**：确认 PRD-LLM-3 的 `providers.py` 最终目录后，才能进入 LLM Provider 相关迁移；在此之前 LLM-4 不移动 `providers.py`。

交付物：迁移清单、依赖图、基线测试记录。该 Phase 不改运行时代码。

**Phase 0 实测记录（2026-08-09）**：

- 后端全量测试：`898 passed`，3 个第三方 deprecation warning。
- 已完成生产代码、测试、脚本和 monkeypatch 路径盘点；安全模块被 `core`、网关、IM、工具、定时任务和脚本共同引用。
- `llm_select.py` 依赖 `providers.py`，`loop_drivers.py` 延迟依赖 `core.py`；因此 `providers.py` 不在本 PRD 提前移动，`loop_drivers.py` 暂留根目录。
- `.DS_Store` 与 `__pycache__` 属于独立仓库清洁任务，本轮不混入目录职责迁移。

#### Phase 1：安全模块归组

按依赖从低到高迁移：`logsafe.py` → `confirm.py` → `sanitize.py` → `core_guards.py`。

- 新建 `agent/security/` 和最小 `__init__.py`。
- 将实现迁入新目录，原路径保留兼容转发模块；兼容模块只导出公开符号。
- 先保持生产代码旧导入路径，确认兼容层工作后，再分批将内部代码改为 `agent.security.*`。
- 保持日志名称、脱敏规则、确认 token、流式清洗输出完全不变。
- 验证安全、流式、核心循环和 IM 相关测试；devserver 做一次模块导入和网页/Worker 启动检查。

完成条件：新路径可直接导入，旧路径仍可用，兼容模块无实现重复，行为测试零回归。

**Phase 1 实施结果（2026-08-09）**：

- 新增 `agent/security/`，实现归入 `confirm.py`、`sanitize.py`、`logsafe.py`、`core_guards.py`。
- 根目录四个同名模块仅保留兼容转发；`core.py`、网关、IM、工具、定时任务和脚本中的安全依赖已切换到新路径。
- 生产导入 smoke 通过；安全、流式清洗、核心循环、追踪和运行状态重点测试 `46 passed`。
- `core_guards.py` 的下划线守卫符号使用显式兼容导出，避免 `import *` 丢失内部公共契约。

#### Phase 2：LLM 非 Provider 基础设施归组

本阶段只处理不与 PRD-LLM-3 重叠的模块：`genstream.py`、`llm_select.py`、`modelctx.py`。

- 新建 `agent/llm/`，保持 `llm_select.py` 的函数签名和根路径兼容入口。
- `llm_select.py` 继续只做模型选择薄包装；Provider 注册表和适配器位置由 PRD-LLM-3 决定，不在本阶段复制或预迁移。
- `modelctx.py` 只承载请求级模型上下文，不与 `agent/models.py` 合并。
- `genstream.py` 只迁流式基础 helper，不把 `core.py` 的循环控制流带入 `llm/`。
- 回归模型选择、缓存能力、流式重试、问候、记忆 LLM 调用和管理端模型探测。

完成条件：所有 LLM 非 Provider 调用点可切换到新路径，Provider 仍只有一份实现，旧导入兼容。

**Phase 2 实施结果（2026-08-09）**：

- 新增 `agent/llm/`，实现归入 `genstream.py`、`llm_select.py`、`modelctx.py`。
- 根目录三个同名模块仅保留兼容转发；生产代码、测试和脚本已切换到 canonical import。
- `llm_select.py` 继续委托现有 `agent.providers`，没有新增 Provider 注册表或第二份适配器实现。
- canonical/兼容导入 smoke 通过；LLM 缓存能力、模型上下文、流式重试、Runner、核心循环和文件读取测试 `37 passed`。

#### Phase 3：运行时基础设施归组

先做低耦合模块，再处理高耦合模块：

- **Phase 3a**：迁 `runtime_state.py`、`trace.py` 到 `agent/runtime/`，保留兼容导出；验证 Redis 状态键、ContextVar、诊断日志和取消链路。
- **Phase 3b 决策门**：重新评估 `loop_drivers.py`。如果 LLM-3 已明确其仍属于循环控制流，则保持在根目录；只有依赖图确认移动不会改变导入时序时，才迁入 `runtime/`。
- 不移动 `core.py`、`runner.py`、`router.py`；它们继续作为顶层编排入口。
- 重点执行流式多轮、工具调用、取消、IM、定时任务和网页 SSE 回归。

完成条件：核心循环不出现新循环依赖，取消/重试/工具轮次行为不变，Worker 与 backend 都能启动。

**Phase 3 实施结果（2026-08-09）**：

- 新增 `agent/runtime/`，实现归入 `runtime_state.py`、`trace.py`。
- 根目录同名模块保留兼容入口，并使用模块别名保留私有辅助函数和旧 monkeypatch 路径；生产代码已切换 canonical import。
- `loop_drivers.py` 仍留在 `agent/` 根目录：它是循环控制流入口，内部依赖 Provider、Context、Tools，并被 `core.py` 延迟导入；移动它不会带来清晰职责收益，反而会改变循环导入时序。
- canonical/兼容导入 smoke 通过；Runtime、IM、网关、取消链路、核心循环和 Runner 测试 `69 passed`。

#### Phase 4：领域模块归属决策与最小迁移

本阶段不是“把剩余文件全部搬走”，而是先根据真实依赖决定是否建立领域目录。

- 为 `behaviors.py`、`commands.py`、`decay.py`、`greeting.py`、`quota.py`、`outbound.py`、`voice.py`、`models.py` 逐个记录：调用方、依赖方向、共享状态、是否存在清晰同类模块。
- 只有至少两个模块形成稳定边界时才建立新目录，例如 `media/` 或 `domain/`；单个模块没有足够收益就保留在根目录。
- `models.py` 默认保留为公共模型入口，除非能证明其职责可无兼容成本拆成运行时模型和领域模型。
- `voice.py` 与媒体 Provider 适配边界必须和 PRD-LLM-3 一起决定，不提前迁移。
- 每次只迁一个边界清晰的小组，并重复 Phase 1 的兼容导出和回归流程。

完成条件：每个被迁移模块都有明确 canonical owner，未形成新“大杂烩”目录，根目录保留的模块都有书面理由。

**Phase 4 复审结果（2026-08-09）**：

- `behaviors.py` 与 `decay.py` 分别属于上下文行为和记忆衰减，调用关系不同，不合并为模糊的 `domain/`。
- `greeting.py` 同时依赖日历/项目数据库、记忆和 Provider；`quota.py` 横跨 API 与 Agent；`voice.py` 横跨入口、附件处理和 Provider；三者都没有可安全抽出的共同目录边界。
- `commands.py` 是命令解析入口，`outbound.py` 是 Runner 的出站编排 helper，`models.py` 是跨 gateway/IM/runner 的公共模型入口，均保留在根目录；`imctx.py` 属于 IM 请求上下文，已归位到 `agent/im/imctx.py`。
- `router.py`、`runner.py`、`loop_drivers.py`、`providers.py` 继续按顶层编排和 Provider 依赖门槛保留，不为减少文件数强行迁移。
- 因此本阶段没有新增目录，避免形成新的职责大杂烩；根目录保留项均有明确理由。

#### Phase 5：兼容入口收敛、文档和清理

- 用 `rg` 确认生产代码、测试、脚本和文档已使用 canonical path；保留必要的外部兼容入口。
- 至少经历一个完整测试周期和一次 devserver 启动/交互验证后，再删除已无引用的根目录转发模块。
- 更新 `docs/agent/`、本 PRD 的目录结构、开发约定和排障入口；不删除历史 devlog。
- 删除兼容入口必须单独提交，便于出现旧插件或脚本依赖时快速恢复。

完成条件：旧路径只剩明确记录的公共兼容入口，顶层目录职责可解释，完整测试与 devserver 验证通过。

**Phase 5 实施结果（2026-08-09）**：

- 生产代码、测试和脚本中的安全、LLM、Runtime 旧导入已全部切换到 canonical path。
- 根目录兼容模块已逐个删除；当前 `rg` 未发现应迁移的旧导入路径。
- canonical 生产导入 smoke 通过；后端全量测试 `898 passed`。
- `.DS_Store`、`__pycache__` 等生成物未混入本次职责重构，仍按独立仓库清洁任务处理。

### 3.4 日志与安全

- 迁移只允许改变 import 路径，不得顺手放宽异常、日志或脱敏行为。
- 普通日志不记录聊天正文、附件名、用户输入、token 或密钥。
- 原始异常继续走 `diag_log()` / `diag_log_raw()`，可见错误继续走 `redact()`。
- logger 名称若从 `agent.core` 等旧路径变化，必须单独评估，因为现有排障依赖这些关键字。

## 4. 验证与上线

### 静态验证

- `rg` 检查旧模块导入和新模块导入，确认没有遗漏。
- 检查所有兼容模块只包含导出，不存在双份实现。
- 检查 `backend/agent/` 顶层文件数量和每个文件的最终归属，形成迁移清单。
- 检查启动入口、定时任务、脚本和测试中的 monkeypatch 字符串路径。

### 测试验证

每个 Phase 完成后在 devserver 执行：

```bash
cd backend && PYTHONPATH=. .venv/bin/pytest
```

重点回归：

- Agent 主循环与流式：`test_core_loop_characterization.py`、`test_stream_round_retry.py`、`test_runner_collect.py`。
- Provider：`test_providers.py`、`test_llm_cache_capability.py`。
- 安全：`test_confirm_gate.py`、`test_stream_sanitize.py`。
- IM、网关、定时任务：相关 `test_*im*`、`test_*gateway*`、`test_scheduled_*`。

### 分阶段验收门槛

| 阶段 | 必须通过 | 额外检查 |
|---|---|---|
| Phase 0 | 基线测试与模块导入 smoke | 依赖图、公共符号、monkeypatch 路径和 Provider 目录决策记录齐全 |
| Phase 1 | 安全/流式/核心循环重点测试 | 旧路径与新路径导入结果一致，日志名称和脱敏行为不变 |
| Phase 2 | Provider、流式重试、缓存能力、问候和记忆调用测试 | `providers.py` 未被重复迁移；LLM 选择函数签名不变 |
| Phase 3 | 核心循环、取消、IM、定时任务、网页 SSE 测试 | Worker/backend 启动成功，ContextVar/Redis 状态没有跨请求串联 |
| Phase 4 | 被迁移领域模块的专项测试 + 全量 pytest | 每个新目录都有明确边界，未迁模块有保留理由 |
| Phase 5 | 全量 pytest、模块导入 smoke、devserver 交互验证 | `rg` 不再发现应迁移的旧路径，兼容入口删除可独立回滚 |

### 上线与回滚

- 每个 Phase 使用独立 commit，commit message 使用简体中文并说明“纯目录迁移/无行为变化”。
- Agent 根目录、`core.py`、`runner.py` 或 `runtime/` 变更后，在 devserver 重启对应的 backend/worker；只有实际改动 `gateway/` 或 IM adapter 时才重启对应平台子进程，不重启整个 gateway。
- 若发现循环依赖、导入失败或 monkeypatch 失效，优先恢复该 Phase 的兼容入口，不回滚无关改动。
- 迁移阶段不需要数据库迁移和前端发布。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 现有代码大量使用 `from agent import xxx` 和 `agent.xxx` | 直接移动会造成启动、测试或延迟 import 失败 | 保留兼容模块；先更新生产代码和测试，再删除入口 |
| `core.py` 与 `loop_drivers.py` 存在循环依赖 | 迁入 `runtime/` 后可能改变导入时序 | 先做依赖图；保留局部 import；每阶段跑最小启动检查 |
| `providers.py` 正在有独立目录化方向 | 两个 PRD 交叉迁移会产生重复冲突 | `llm/` Phase 必须和 Provider PRD 对齐后实施 |
| logger 名称随模块移动发生变化 | 线上检索和诊断规则可能失效 | 默认保持 logger 名称不变，必要变化单独更新监控和文档 |
| 领域模块归类边界不清 | 建立 `domain/` 后形成新的大杂烩 | Phase 4 以依赖和调用方向为准，不以文件数量为目标 |
| 测试依赖旧 monkeypatch 路径 | 测试可能出现“代码正常但替身未注入”的假通过或假失败 | 全量搜索 monkeypatch 字符串，迁移后专项执行相关测试 |

**待确认问题：**

- 🔲 `providers.py` 的最终目录由 PRD-LLM-3 决定；在该 PRD 完成目录化前，LLM-4 不移动或复制它。
- 🔲 `models.py` 是否要拆成 `domain/models.py` 与 `runtime/models.py`？在没有明确重复职责前不迁移。
- 🔲 `voice.py` 归入 `domain/` 还是 `media/`？需要结合附件、语音转写和 Provider 媒体适配层的最终边界决定。
- 🔲 是否需要统一 `agent/security/` 的对外 `__init__.py` 导出面？建议先保持最小导出，避免形成新的隐式公共 API。
