# Agent 目录职责整理与模块化重构 PRD

> 状态：🔲 待评估（已完成根目录现状盘点与目标结构设计，尚未迁移代码）
> 创建：2026-08-08
> 最近更新：2026-08-08
> 所属层：Agent / 后端模块化
> 关联模块：`backend/agent/`、`backend/app/api/v1/agent.py`、`backend/app/api/v1/agent_admin.py`、`backend/app/scheduled_tasks.py`
> 关联文档：[[PRD-LLM-1-provider适配层重构与core瘦身.md]]；[[PRD-LLM-3-provider供应商适配层整体整理.md]]

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 根目录现状盘点 | ✅ 已完成 | 已确认 `backend/agent/` 根目录存在 22 个业务/基础设施 Python 模块，职责横跨运行时、LLM、上下文状态、安全、领域服务和兼容入口。 |
| 目标目录设计 | ✅ 已完成 | 确定优先整理 `security/`、`llm/`、`runtime/` 三组；`core.py`、`runner.py`、`router.py` 等顶层编排模块暂不强拆。 |
| Phase 1：安全模块归组 | 🔲 待评估 | 将 `confirm.py`、`sanitize.py`、`logsafe.py`、`core_guards.py` 迁入 `security/`，保留兼容导出。 |
| Phase 2：LLM 基础设施归组 | 🔲 待评估 | 将 `genstream.py`、`providers.py`、`llm_select.py`、`modelctx.py` 迁入 `llm/`；与 Provider 适配层 PRD 协同，避免重复搬迁。 |
| Phase 3：运行时基础设施归组 | 🔲 待评估 | 将 `runtime_state.py`、`trace.py`、`loop_drivers.py` 迁入 `runtime/`；核对与 `core.py` 的循环依赖。 |
| Phase 4：领域服务归组 | 🔲 待评估 | 评估 `behaviors.py`、`commands.py`、`decay.py`、`greeting.py`、`quota.py`、`outbound.py`、`voice.py`、`models.py` 的最终归属。 |
| 兼容入口收敛 | 🔲 待评估 | 所有外部导入和测试迁移完成后，再删除根目录兼容模块。 |

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

### FR-LLM-4-1：安全基础设施目录化（🔲 待评估）

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

### FR-LLM-4-2：LLM 基础设施目录化（🔲 待评估）

建立 `backend/agent/llm/`，承载模型调用基础设施：

```text
agent/llm/
├── __init__.py
├── genstream.py
├── providers.py
├── llm_select.py
└── modelctx.py
```

- `providers.py` 如果执行 Provider 适配层 PRD 的目录化，应直接采用 `agent/llm/providers/` 包，避免先迁成 `llm/providers.py` 后再次重构。
- `llm_select.py` 保留现有选择函数签名，调用方不因目录整理改变行为。
- `modelctx.py` 继续作为请求级模型上下文，不与业务 `models.py` 混淆。
- `genstream.py` 只承载流式生成基础能力，不把 Agent Loop 控制流移入该目录。

### FR-LLM-4-3：运行时基础设施目录化（🔲 待评估）

建立 `backend/agent/runtime/`：

```text
agent/runtime/
├── __init__.py
├── loop_drivers.py
├── runtime_state.py
└── trace.py
```

- `runtime_state.py`：跨请求/进程运行状态和 Redis 状态访问。
- `trace.py`：请求级追踪上下文。
- `loop_drivers.py`：模型 API 驱动层；不把工具业务和 Provider 专属判断重新塞回此处。
- 迁移前必须先绘制 `core.py`、`loop_drivers.py`、`providers.py` 的依赖方向，避免扩大现有延迟 import 和循环依赖。

### FR-LLM-4-4：顶层编排入口保持稳定（🔲 待评估）

第一阶段保留以下模块在 `agent/` 根目录：

- `core.py`：Agent 主循环和工具调用控制流。
- `runner.py`：网页、IM、定时任务等入口的运行编排。
- `router.py`：运行路由和运行态选择。
- `models.py`：如果仍被多个领域直接依赖，暂时作为公共模型入口。

它们可以在后续独立 PRD 中继续拆分，但本次不以“根目录必须为空”为验收目标。

### FR-LLM-4-5：兼容导入与渐进迁移（🔲 待评估）

每个迁移模块在原路径保留短期兼容入口，例如：

```python
# backend/agent/providers.py（迁移过渡期）
from agent.llm.providers import *
```

- 兼容入口只做导出，不复制实现。
- 先迁生产代码，再迁测试和脚本。
- 使用 `rg` 检查 `backend/`、`tests/`、`scripts/` 中旧导入路径全部收敛。
- 至少经过一个完整测试周期后，才删除兼容入口。
- 不修改对外 API、Supervisor 启动命令、日志 logger 名称或测试 monkeypatch 路径，除非在对应阶段单独记录。

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

### 3.3 迁移顺序

1. 建立依赖清单和旧路径引用清单，不改行为。
2. 先迁 `security/`，因为其职责最独立。
3. 与 Provider PRD 对齐后迁 `llm/`，优先处理 `providers.py` 的最终目标形态。
4. 迁 `runtime/`，重点验证 `core.py` 与 `loop_drivers.py` 的循环依赖。
5. 根据真实依赖决定是否建立 `domain/`，不为凑目录强行迁移。
6. 更新测试、脚本和文档中的 import 路径。
7. 完成兼容周期后删除根目录兼容入口。

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

### 上线与回滚

- 每个 Phase 使用独立 commit，commit message 使用简体中文并说明“纯目录迁移/无行为变化”。
- 网关相关模块只重启对应平台子进程，不重启整个 supervisor。
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

- 🔲 `providers.py` 最终是 `agent/llm/providers/`，还是独立的 `agent/providers/` 包？由 PRD-LLM-3 的实施顺序决定。
- 🔲 `models.py` 是否要拆成 `domain/models.py` 与 `runtime/models.py`？在没有明确重复职责前不迁移。
- 🔲 `voice.py` 归入 `domain/` 还是 `media/`？需要结合附件、语音转写和 Provider 媒体适配层的最终边界决定。
- 🔲 是否需要统一 `agent/security/` 的对外 `__init__.py` 导出面？建议先保持最小导出，避免形成新的隐式公共 API。
