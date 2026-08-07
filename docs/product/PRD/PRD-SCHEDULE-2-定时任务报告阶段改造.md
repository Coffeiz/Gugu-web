# PRD-SCHEDULE-2：定时任务报告阶段改造（execution 产出 report schema，report 纯代码渲染）

> 状态：📝 草案，待评审
> 创建：2026-08-07
> 关联模块：`backend/app/scheduled_tasks.py`、`backend/agent/runner.py`、`backend/agent/scheduled_report.py`
> 关联文档：[`【已完成】PRD-SCHEDULE-1-定时任务完整AgentLoop执行.md`](./【已完成】PRD-SCHEDULE-1-定时任务完整AgentLoop执行.md)、[`PRD-IM-7-群定时任务完整loop.md`](./PRD-IM-7-群定时任务完整loop.md)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| PRD 撰写 | ✅ 已完成 | 本文档 |
| execution 阶段 prompt 追加 report schema 指令 | 🔲 待评估 | 让模型最后一轮输出 JSON schema |
| report 模块纯代码渲染 | 🔲 待评估 | 解析 schema，取 summary 投递，去掉 report LLM |
| 删除 report LLM 调用与相关代码 | 🔲 待评估 | 删除 `run_scheduled_report` / `build_prompt` / `scheduled_report.py` |
| 更新测试 | 🔲 待评估 | 更新 mock report 的用例 |
| 完整 pytest + 提交 | 🔲 待评估 | — |

## 1. 背景与问题

### 1.1 现状：定时任务 execution 后还要单独跑一次 report LLM

PRD-SCHEDULE-1 引入了「execution + report」两阶段架构：

- **execution 阶段**（`run_scheduled_execution`）：完整 AgentLoop + 全部工具，模型执行任务、调工具，产出 `execution_text` + `files`（附件）。耗时重（devserver 日志显示约 2 分钟）。
- **report 阶段**（`run_scheduled_report`）：又一次完整 LLM 调用（无工具、`minimal_context=True`），用 `build_prompt` 把 `task_prompt + execution_text + files` 拼成 prompt，让模型**再生成一遍**投递正文。耗时轻（约 9 秒），但**每次定时任务都多一次 LLM 调用 + 成本**。

report 阶段当初的设计理由（PRD-SCHEDULE-1 §1）：把 execution 的原始产出**转述成更合适的措辞**，避免把工具过程和不必要的中间输出直接投递给用户。

### 1.2 现状的问题

1. **两次 LLM 调用**：execution 一次 + report 一次，成本翻倍、延迟增加（每次定时任务多约 9 秒）。
2. **report 可能「编造」**：report 阶段模型拿到 `execution_text` 后重新组织语言，可能添油加醋、声称没做的操作已完成。`build_prompt` 里专门写了「不要声称结果中没有出现的操作已经完成」——说明这是真实发生过的问题。
3. **report 失败要重试**：`_run_agent` 里 report 失败会重试一次，两次都失败还要 fallback 到 `execution_text`，逻辑复杂（`report-start` / `report-finish` / `report-retry-start` / `report-retry-finish` / `report-skipped` 多个分支）。
4. **输出不可控**：report 是自由文本，可能输出多余内容。
5. **execution 阶段模型没有被明确告知「你的输出就是最终投递正文」**——它可能产出过程性内容（「我先查了天气，然后查了汇率…」）、工具调用痕迹，导致 report 阶段不得不「擦屁股」。

### 1.3 目标

让定时任务**只跑一次 LLM**（execution），execution 阶段模型在最后一轮产出**结构化 report schema**，report 模块**纯代码渲染**（不调 LLM）统一输出：

1. **execution 阶段产出 report schema**：在 `_run_agent` 传给 execution 的 prompt 里追加指令，要求模型最后一轮输出 JSON schema（`summary` / `context` / `status`）。
2. **report 模块纯代码渲染**：`_run_agent` 拿到 execution 最后一轮文本后，用 `_parse_json` 解析成 schema，取 `summary` 作为投递正文，`status` 决定措辞，`files` 由工具事件收集。
3. **去掉 report LLM 调用**：删除 `run_scheduled_report`、`build_prompt`、`scheduled_report.py`。
4. **输出可控**：schema 约束字段，`summary` 是面向用户的正文，`context` 仅内部记录，`status` 决定措辞。
5. **不影响私聊/网页/群任务**：所有定时任务统一走新路径，行为一致。

## 2. 功能需求

### FR-SCHED-1：execution 阶段产出 report schema（🔲 待评估）

- **触发条件**：任何定时任务（私聊/网页/群）进入 `_run_agent` 执行。
- **预期行为**：execution 阶段模型在收到追加指令后，最后一轮输出 JSON schema：
  ```json
  {
    "summary": "面向用户的最终正文",
    "context": "执行过程说明（内部记录，不投递）",
    "status": "success" | "partial" | "failed"
  }
  ```
- **边界情况**：模型不遵守指令、最后一轮不是合法 JSON → 重试一次 execution，再失败则把原始文本当 `summary` 投递。

### FR-SCHED-2：report 模块纯代码渲染（🔲 待评估）

- **触发条件**：execution 成功后。
- **预期行为**：`_run_agent` 用 `_parse_json` 解析 execution 最后一轮文本为 schema，取 `summary` 作为投递正文，`status` 决定措辞，`files` 由工具事件收集。
- **边界情况**：解析失败 → 重试一次 execution，再失败 fallback 到原始文本。

### FR-SCHED-3：status 决定投递措辞（🔲 待评估）

- **触发条件**：execution 产出 schema 含 `status` 字段。
- **预期行为**：
  - `success`：正常投递 `summary`。
  - `partial`：在 `summary` 前加「部分完成」提示。
  - `failed`：在 `summary` 前加失败说明。
- **边界情况**：`status` 缺失或未知 → 按 `success` 处理。

### FR-SCHED-4：附件随正文投递（🔲 待评估）

- **触发条件**：execution 阶段通过 `send_file` 工具产出 `files` 附件。
- **预期行为**：`files` 由 `_collect` 从工具事件收集（不依赖模型在 schema 里填），`_run_agent` 返回 `(summary, files)` 后投递层把附件发到 IM 群。
- **边界情况**：网页通知渠道不支持附件，图片只出现在 IM 群。

## 3. 技术方案

### 3.1 execution 阶段 prompt 追加 report schema 指令

在 `_run_agent` 里，`_inject_group_context` 之后、`run_scheduled_execution` 之前，给 prompt 追加一段指令：

```python
# PRD-SCHEDULE-2：execution 阶段最后一轮输出 report schema，report 模块纯代码渲染。
prompt = prompt + _EXECUTION_REPORT_SCHEMA_INSTRUCTION
```

`_EXECUTION_REPORT_SCHEMA_INSTRUCTION` 常量内容（草案）：

```text
[定时任务报告 schema]
你的最后一轮输出必须是如下 JSON（不要输出其他内容）：
{
  "summary": "面向用户的最终正文，直接给出用户关心的结论、数据或操作结果",
  "context": "执行过程说明（内部记录，不投递）",
  "status": "success" 或 "partial" 或 "failed"
}
```

### 3.2 `_collect` 取最后一轮文本

`_collect` 已经「按轮分段收集，只取最后一轮」（丢弃工具调用间的过渡性旁白）。execution 最后一轮文本就是 report schema JSON。

### 3.3 report 模块解析 schema

`_run_agent` 拿到 execution 最后一轮文本后：

```python
from agent.memory._llm import _parse_json  # 或复用现有 JSON 解析
schema = _parse_json(execution_text) or {}
summary = schema.get("summary") or execution_text  # 解析失败 fallback 到原始文本
status = schema.get("status", "success")
```

- 解析失败 → 重试一次 execution，再失败 fallback 到原始文本。
- `summary` 为空 → fallback 到原始文本。
- `status` 决定措辞（success 正常 / partial 加前缀 / failed 加失败说明）。

### 3.4 去掉 report LLM 调用

`_run_agent` 里 execution 成功后直接解析 schema 并返回，删除 report 相关分支（`report-start` / `report-finish` / `report-retry-start` / `report-retry-finish` / `report-skipped`）。

### 3.5 删除 report 相关代码

- `backend/agent/runner.py`：删除 `run_scheduled_report`。
- `backend/agent/scheduled_report.py`：删除整个文件（含 `build_prompt`）。
- `backend/app/scheduled_tasks.py`：删除 `from agent.runner import run_scheduled_report` 的导入。

### 3.6 附件（files）处理

`files` 由 `_collect` 从 `send_file` 工具事件收集（`evt["file"]`），不依赖模型在 schema 里填。`_run_agent` 返回 `(summary, files)` 后，投递层把附件发到 IM 群。

## 4. 验证与上线

1. **execution 产出 schema**：在 devserver 跑真实定时任务，确认 execution 阶段模型最后一轮输出合法 JSON schema（含 `summary` / `context` / `status`）。
2. **单次 LLM 调用**：日志确认每次定时任务只出现一次 `execution-start` / `execution-finish`，不再有 `report-start`。
3. **附件投递**：确认 `files` 仍能随正文发到 IM 群。
4. **status 措辞**：确认 `partial` / `failed` 时投递正文带对应前缀。
5. **解析失败 fallback**：确认模型不遵守指令时，重试一次后 fallback 到原始文本。
6. **完整 pytest**：更新 mock report 的用例后全绿。

### 4.1 测试改动

- `backend/tests/test_scheduled_task_execution.py`：
  - `test_scheduled_tools_run_report_without_reexecuting`：改为验证 execution 成功后直接解析 schema 返回，不再调 report。
  - `test_scheduled_report_failure_retries_report_only`：删除（report 不再存在）。
  - `test_scheduled_report_failure_twice_falls_back_to_execution_text`：删除（report 不再存在）。
  - 新增：execution 产出合法 schema 时取 `summary` 投递；产出非法 JSON 时重试一次再 fallback。
- `backend/tests/test_scheduled_group_imctx.py`：更新 mock report 的用例（`run_scheduled_report` 不再被调用）。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|------|------|------|
| execution 阶段模型不遵守「最后一轮输出 JSON schema」指令，产出自由文本 | 解析失败，投递正文质量下降 | 重试一次 execution，再失败 fallback 到原始文本；必要时调整指令措辞 |
| `_parse_json` 解析失败（JSON 被截断/混入杂字） | 无法提取 summary | 复用 `_llm.py` 的 `_parse_json` 容错解析（容忍围栏与前后杂字） |
| `status` 字段缺失或未知 | 措辞异常 | 缺失/未知按 `success` 处理 |
| 附件投递逻辑依赖 report 阶段告知模型 | 附件投递异常 | 附件由 `_collect` 工具事件收集，不依赖模型；`_run_agent` 返回 `(summary, files)` 后投递层负责 |

待确认问题：

- ✅ **execution 阶段模型当前产出质量是否够？** 结论：`_collect` 已只取最后一轮文本，丢弃工具调用间旁白；本次改造让最后一轮输出 JSON schema，进一步约束。
- 🔲 **模型是否稳定遵守「最后一轮输出 JSON」指令？** 待 devserver 实测后确认。
- 🔲 **`_parse_json` 对 execution 输出的解析成功率？** 待实测后确认。

## 6. 实施步骤

1. 在 `_run_agent` 加 `_EXECUTION_REPORT_SCHEMA_INSTRUCTION` 指令，追加到 execution prompt。
2. 在 `_run_agent` 加 schema 解析逻辑（`_parse_json` + summary/status 提取 + fallback）。
3. 删除 `run_scheduled_report`、`build_prompt`、`scheduled_report.py`，简化 `_run_agent`。
4. 更新相关测试。
5. 跑完整 pytest。
6. 更新 CHANGELOG。
