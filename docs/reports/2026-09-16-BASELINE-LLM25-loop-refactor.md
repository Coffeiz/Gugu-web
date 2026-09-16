# PRD-LLM-25 Phase 0 基线冻结报告（LLM25-001/002）

> 日期：2026-09-16
> 基线 commit：`0cb2d4e74`（dev，2026-09-16 23:59:46 +0800）
> 结论：Phase 0 完成迁移清单与基线指标采集，未修改任何运行代码（PRD-LLM-25 §6 Phase 0 验收）。

## 1. 结构基线（LLM25-001）

| 指标 | 观察值 | 与 PRD 审查基线对比 |
|---|---:|---|
| `agent/core.py` 总行数 | **2359** | 一致（审查时约 2318，MCP 落地后微增） |
| `_run_loop` 行范围 | **875–2359 行，共 1485 行** | 与 PRD 完全一致 |
| `agent/loop_drivers.py` | 754 行 | 与 PRD 盘点一致 |
| `agent/runner.py` | 1253 行 | 与 PRD 盘点一致（约 1243） |
| `core.py` 局部状态 | 预算/核实/守卫/重试/熔断/压缩/事件序号 20+ 项 | 与 PRD 一致 |

复杂度指标（PRD 记录 `ccx≈904`、`churn=111`）来自外部审查工具，本机无 radon，未重新测量；
`_run_loop` 行数与职责分布（§3.3.2 行号分区）已逐区核对属实，可作为迁移对照。

### 关键测试基线（commit 0cb2d4e74）

| 项目 | 结果 |
|---|---|
| PRD §4.1 七个关键测试文件（characterization / loop_driver_usage / stream_round_retry / interaction_protocol / mcp_e2e / canonical_tool_history） | **132 passed** |
| 后端全量 `pytest -q` | **3152 passed** |
| `python -m compileall -q app agent` | 通过 |
| `scripts/check_ownership.py` | ✅ 通过 |
| `scripts/check_confirm_gate.py` | ✅ 通过 |
| LoopScope | LOOPSCOPE_ENABLED=1 于 dev-restart 启动；hooks 直接包裹 `LLMRunner._run_loop`（hooks.py:221 起，保存/替换/逐 round 转发，见 §2 迁移清单） |

Provider 行为基线由上述测试锁定：Anthropic（characterization + usage_semantics）、OpenAI/Responses（characterization）、Ollama（usage_semantics）、工具成功/失败/确认/两阶段（interaction_protocol + mcp_e2e）、canonical 顺序（canonical_tool_history）。Phase 2+ 每步迁移后须以同组测试对比。

## 2. 兼容调用点清单（LLM25-002）

### 2.1 生产代码调用点（不可破坏）

| 调用方 | 依赖 | 迁移注意 |
|---|---|---|
| `agent/runner.py:20` | `from agent.core import LLMRunner` | FR-001：入口不动 |
| `agent/scheduled.py:8` | `from agent.core import LLMRunner`（ScheduledLLMRunner 继承） | 继承链保持 |
| `agent/gateway/web.py:28` | `from agent.core import LLMRunner` | 不改公共协议 |
| `agent/runtime/loopscope_trace/hooks.py:212` | `from agent.core import LLMRunner`，**保存并替换 `LLMRunner._run_loop`**（221 行起，逐 round 转发原函数） | Phase 2+ 每步必须验证 hook 包裹仍生效（monkeypatch 的是类属性，迁移后 `_run_loop` 必须仍挂在 `LLMRunner` 类上） |
| `agent/loop_drivers.py:221` | **反向依赖** `from agent.core import _stream_round`（run_round 内延迟 import） | LLM25-003 的首要目标：消除反向 import，`core.py` 留兼容别名 |
| `app/api/v1/agent.py:723`、`app/api/v1/agent_admin.py:1430/1446` | `from agent.core import SPECIAL_STATE_LABELS` | 保留兼容导出 |
| `scripts/smoke_real_llm_tool_reliability.py:25`、`scripts/smoke_memory_boundary.py:24`、`scripts/diagnostics/test_locale_continuous.py:52`、`scripts/diagnostics/test_full_schema_compact_ab.py`（3 处） | `from agent.core import LLMRunner` | 只用公共入口，零成本兼容 |

### 2.2 测试 monkeypatch 面（Phase 2+ 不得破坏的符号）

| 符号 | 外部引用文件 | 引用方式 |
|---|---|---|
| `_stream_round` | `test_core_loop_characterization.py`、`test_loop_driver_usage_semantics.py`（3 处）、`test_stream_round_retry.py`、`test_loopscope_usage.py`、`agent/loop_drivers.py` | `monkeypatch.setattr(core, "_stream_round", ...)` —— 迁移后 `core._stream_round` 必须仍是 `_run_loop` 实际调用的那个名字（或经兼容别名间接生效） |
| `registry.dispatch` | characterization 9 处 | `monkeypatch.setattr(core.registry, "dispatch", ...)` —— core 与 loop 共用同一 registry 单例 |
| `MAX_TOOL_CALLS` / `MAX_ROUNDS` | characterization 5 处 | 模块级常量 monkeypatch —— 上限读取必须走 core 命名空间或保持可覆盖 |
| `_user_unlimited_mode_enabled` | characterization 1 处 | 字符串路径 setattr |
| `_sanitize_anthropic_history` | `test_loop_driver_usage_semantics.py:17` | 直接 import 使用 |
| `_loaded_skill_slugs`、`_resolve_adapter_arguments` | `test_capability_injection.py:8` | 直接 import |
| `_VERIFY_PROMPT` / `_VERIFY_FORCE_PROMPT` | `test_agent_prompt_language.py:6` | 直接 import |
| `_GOAL_DONE_MARKER`、`_goal_completed`、`_strip_goal_marker`、`_user_cancel`、`_unlimited_mode_enabled` | characterization | 直接 import / monkeypatch |
| `_im_cancelled` | `test_loopscope_usage.py` | monkeypatch |

### 2.3 仅 core 内部使用、可自由迁移的符号

`_replace_tool_result`、`_pending_tool_signal`、`_PendingInteraction`、`_artifact_sse`、`_closing_frames`、`_mutating_tools`、`_is_successful_tool_result`、`_is_verify_placeholder`、`_dispatch_in_session`、`_call_requires_verification`、`_im_set_tool_state`、`_goal_mode_enabled`、`_tool_result_payload`、`_is_read_tool`、`_pick_label` —— 外部零引用，迁移到 `loop/` 各模块时**无需保留兼容导出**（Phase 6 清理时复核）。

### 2.4 迁移顺序约束（由清单得出）

1. **LLM25-003**（provider round）：先做——`loop_drivers.py:221` 反向 import 是唯一的生产代码反向依赖；兼容别名必须保证 `monkeypatch.setattr(core, "_stream_round", ...)` 仍能改变 `_run_loop` 实际行为（别名不得用 `from x import y` 的值拷贝，须保持模块属性查找）。
2. **LLM25-004**（纯函数 helper）：`_sanitize_anthropic_history` 等 8 个有测试 import 的符号保留 core 兼容名。
3. **LLM25-005+**（loop/models、events、rounds、tools）：`registry.dispatch` 与 `MAX_*` 常量的可覆盖性是硬约束。
4. **LLM25-010**（interactions）：最后做；hooks 的 `_run_loop` 包裹在每个 Phase 结束时回归（LoopScope 关键测试在 §4.1 清单内）。

## 3. 遗留说明

- `ccx/churn` 复杂度数字未在本机重测（无 radon）；如需数值门禁可后续 `pip install radon` 补测，不阻塞迁移。
- 本报告为冻结基线，Phase 1+ 迁移 PR 合并时须在本文件追加「迁移后指标」对照。

---

## 附录：迁移后指标与完整复审（2026-09-16，Phase 6 收口）

### 结构对比

| 指标 | 基线 | 迁移后 |
|---|---:|---|
| `core.py` 总行数 | 2359 | **569**（落入 PRD 目标 500~700） |
| `_run_loop` | 1485 行大函数 | 薄转发（挂 `LLMRunner` 类上，LoopScope hook 兼容）；实现体在 `loop/machine.py::run_loop`（1502 行，含注释/空行） |
| 新增 `agent/loop/` | — | provider 106 / models 78 / events 39 / rounds 87 / tools 160 / interactions 68 / guards 34 / machine 1502 |
| 反向依赖 `loop_drivers → core` | 有（延迟 import `_stream_round`） | **已消除**（`run_round` 参数注入 + `loop.provider` resolver 槽依赖倒转） |

### 测试与门禁（Phase 6 收口时点）

- 后端全量 `pytest -q`：**3178 passed**（基线 3152；净增为 loop 模块单元测试与并行会话新增）
- PRD §4.1 七个关键套件 + `test_agent_loop_modules`（loop 纯单元 15 项）：全绿
- `compileall` / `check_ownership` / `check_confirm_gate`：通过
- LoopScope hook：`test_loopscope_usage` 全绿——`LLMRunner._run_loop` 类属性替换、round span、usage 记录均正常

### 兼容约束保持证据

- `monkeypatch.setattr(core, "_stream_round", ...)`：core 保留模块级别名，`_run_loop`（machine）经 `_core._stream_round` 运行时查找 → characterization/usage_semantics 的 5 处 patch 全部生效
- `core.MAX_TOOL_CALLS`/`MAX_ROUNDS`/`_user_unlimited_mode_enabled`/`registry.dispatch` 同理（`_core.` 前缀运行时查找）
- 直接 import 兼容：`_sanitize_anthropic_history`、`_loaded_skill_slugs`、`_resolve_adapter_arguments`、`SPECIAL_STATE_LABELS`、`_GOAL_DONE_MARKER`、`_goal_completed`、`_strip_goal_marker`、`_VERIFY_PROMPT`/`_VERIFY_FORCE_PROMPT`、`_user_cancel`、`_FINALIZE_PROMPT` 等全部保留
- 纯判定/熔断/dispatch 等零外部引用符号已迁 `loop/` 且不留别名；死代码清理仅 `_READ_PREFIXES`/`_READ_TOOL_NAMES`（已并入 `loop/tools.py`）

### 如实记录的实施取舍

1. `machine.run_loop` 对 core 常量与兼容别名采用 `_core.` 运行时前缀引用——这是保住「旧 monkeypatch 不改路径」的代价；Phase 6 已审计全部 58 个 `_core.*` 引用均有定义。后续如把测试迁到新路径，可逐个改为直接导入。
2. `_run_loop` 的轮内闭包结构（stream_event/compact_context_now 等）随实现体整体迁移，未在函数内部再拆子函数——PRD §1.2「分散到可单独测试的模块」已由 rounds/tools/interactions/guards/provider 的纯函数承接（决策逻辑可独立测试，machine 只保留状态转移编排）。
3. 过程事故与修复：Phase 3 恢复脚本一度引入被遮蔽的重复 `LLMRunner` 类定义（154 行死代码，Phase 5 提交中移除）；Phase 5 常数区误删（`_VERIFY_PROMPT`/`_FINALIZE_PROMPT`/`SPECIAL_STATE_LABELS`/`_im_cancelled` def 行）均从 HEAD 原样恢复并有全量测试兜底。
