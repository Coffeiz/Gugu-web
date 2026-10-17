# INVEST：F1 工具轮后的 Responses 失败

> 排查日期：2026-10-17
> 排查环境：devserver
> 排查对象：QQ 私聊、MiniMax-M3.1-Flash-Preview、Responses 协议
> 排查目的：区分工具执行、请求组装、Skill、上游响应与错误归因问题

## 1. 结论与修正范围

已确认两类应用代码问题并修正：

1. `response.failed` 被抛成普通 `RuntimeError`，共享错误描述器因找不到 HTTP 错误状态，将其误归为内部异常，产生“未识别到上游 HTTP 错误”的提示。现在使用独立的 `ResponsesStreamError` 类型，Web 与所有 IM 统一归为 `provider_stream_error`。
2. 通用 `error` 流事件原先未被识别，可能被当作正常空回复。现在同样按上游流失败处理，关闭流且不产生成功的 `done` 结果。

原始上游错误原因进入受限诊断日志；异常仅携带白名单字段，对用户只返回统一文案与诊断编号。不新增自动重试，不重跑已经完成的 Shell，不删减真实回执或自动切换协议。

F1 原始请求的重建回放曾连续 3 次收到上游 `response.failed / internal_error`，后来相同请求体又成功 1 次。因此**可复现失败，但不是固定必现**。不能把某一 Skill、字符、参数或“多轮调用”断言为确定根因，也不能宣称此次错误分类修复已修好 F1 出图全流程。

## 2. 两次真实故障

| 时间 | runtime run | LoopScope run | 诊断编号 |
| --- | --- | --- | --- |
| 20:21 | `run-4920a3d5000142f4` | `run-ff27ae7a3d1c-635cf7` | `0F191C5F81AC654B` |
| 22:20 | `run-528d004c028b40df` | `run-ff516ca6f531-1f9f77` | `ECA020A2DB209DA0` |

两者同属 QQ 私聊同一会话，模型与接口相同。每次先查询数据与产物，再运行出图命令；两个 Shell 工具都返回 `ok=true`、`exit_code=0`，未报告超时、撤权或配额错误。随后第 3 轮模型请求失败，尚未进入后续发图步骤。

最后一个工具结果是相同的 8 行排名文本，不含图片输入。这里只确认工具回执，不将管道命令退出码等同于对实际图像文件、内容和业务数据正确性的独立验收。

原始日志只保存了 `RuntimeError: Responses API returned a failed response`，没有该次上游失败原因。第二个 run 的 Collector 快照未保留完整第 3 轮输入，因此回放采用第一个 run。

## 3. 用户补充的正常多轮对照

| 正常对照 | LoopScope run | 实际观察 |
| --- | --- | --- |
| 连续工具操作 | `run-dcad9c5530f1-7b62a8` | 10 个 LLM span 全部成功，含多次 Shell 和文件工具；第 10 轮返回最终正文 |
| 查询 PR | `run-5eca5f7f87fd-afd8f1` | 5 个 LLM span 全部成功，完成 4 次 MCP 调用后返回最终正文 |

两组均为同一 MiniMax 模型与 Responses 协议。实际输入量分别约为 20.0–21.2 万、21.2–22.4 万 token；F1 失败前一轮约为 22.6 万 token。

按 trace 逐条比较发现：

- PR 对照末轮的全部 **359 条 conversation 消息**，是第一个 F1 失败轮 conversation 的精确前缀；后者共 368 条。此比较不把单独展示的 session snapshot 混作 conversation 消息。
- 两组正常对照与 F1 run 的固定 system 内容相同。
- 三组历史中返回的 F1 Skill 正文摘要均为 `acdb44aed111dbd4`，不是只有失败请求才包含这份 Skill。
- 两次 F1 出图 run 本轮均未再次调用 `use_skill`；使用的是已有上下文中的技能与历史。

因此，多轮工具调用、存在 F1 Skill 正文或固定 system 内容本身，均不足以解释失败。某些 run 的聚合状态仍显示 `running`，本报告按 LLM span、实际输出及用户提供的 QQ 回执判断，不以该聚合状态单独判定成功或失败。

## 4. 请求组装审查

重建的失败轮输入包含 103 个 `function_call`、103 个 `function_call_output`，以及普通 user/assistant 消息。

- 所有调用参数均可作为 JSON 解析。
- `id` 与 `call_id` 无重复，调用和结果的 ID 多重集合一致。
- 当前工具 Schema 摘要为 `2d0d949927b4be45`，与原 trace 相同，Schema 序列化后为 1694 字节。
- 原始与非流式对照请求逐字段比较，唯一差异为 `stream`。
- 原始 SSE 读取对照与普通 SDK 回放的请求体逐字段一致。

这些检查没有发现孤立工具结果、重复调用 ID、JSON 语法错误或工具声明变化。仍不能由结构检查证明所有供应商兼容约束均被满足。

## 5. 真实模型回放

所有探针均经用户授权，读取真实 trace 并调用同一模型，只收集模型输出，**不执行模型返回的工具、不发送 QQ 消息、不修改运行配置**。

| 变体 | 次数 | 结果 | 解读边界 |
| --- | --- | --- | --- |
| 原始上下文、原始回执、流式 | 4 | 3 次失败，后来 1 次成功 | 同一重建请求并非固定必现 |
| 相同请求，仅 `stream=false` | 2 | 均返回 completed | 完成的是一轮模型响应，后续工具没有执行 |
| 最后一条工具结果替换为简短成功说明 | 2 | 均返回 completed | 初版探针替换了整个末尾结果对象，不能只归因于 stdout 长度 |
| 保留原回执，仅保留末尾历史并简化 instructions | 1 | 返回 completed | 同时改变历史和 instructions，不能据此证明硬性长度阈值 |
| 保留完整输入，去掉本轮工具 Schema | 1 | 仍失败 | 曾收到 reasoning 事件后再失败 |
| 只删除最后一行异常排名 | 1 | 仍失败 | 不能将该行单独判作根因 |
| 将一份历史 F1 Skill 正文替换为简短说明 | 1 | 返回 completed | Skill 仍出现在其他历史资料中；单次结果不证明技能文本有错 |
| 最新调用的字符串 timeout 转为数值并重新序列化参数 | 1 | 返回 completed | 类型及 JSON 空白同时变化，不是纯类型单变量对照 |
| 强制选择已声明的 `call_tool` | 1 | 返回 completed | 不能由单次成功证明自动选工具存在错误 |
| 绕过 SDK 事件对象解析，直接读取 SSE 行 | 1 | 返回 completed | 请求体与原始回放相同；不能把这一次成功当作 SDK 修复证据 |

失败事件的原始错误为：

```json
{"code":"internal_error","message":"Internal server error. Please retry your request.","misalignment":null}
```

失败有时直接出现在 `created → in_progress` 后，有时先返回 reasoning 事件再失败，没有成功的最终结果。探针收到的是上游失败事件，不是 Gugu 自行生成的错误事件。

首次临时探针错误重复拼接了一段基础 system，输入变为 246417 token；该成功结果已排除出有效对照。后续修正 snapshot 位置，并核对公共 instructions 合并器的去重行为。原 trace 没有保存完整出站 SDK 请求与所有历史配置参数，本报告严格称为**依据 trace 重建的回放**，不声称与当时出站字节完全一致。

## 6. 仍未确认的根因与处理原则

目前证据支持：该真实上下文与 F1 工具结果组合下，MiniMax Responses 会出现上游内部错误，并且表现不是确定性的。没有证据证明 QQ 发图、Shell 执行或多轮次数限制导致本次失败。

仍无法区分供应商内部生成、工具选择、输出格式或流式封装中的具体缺陷，也无法完全排除某个请求兼容边界。单次删改上下文后成功只是线索，不足以据此修改 Skill、截断历史、扩大上限或重写工具回执。

此次代码修复解决错误归因和诊断缺失，不保证未来该请求一定成功。再次发生时，可用诊断编号关联 run/round 与 response ID，并在受限日志读取真实上游原因。若后续考虑恢复机制，必须按已交付内容与工具副作用状态设计，不能回放已执行的 Shell。

## 7. 测试脚本与产物

保留可复用脚本 [`probe_responses_trace_replay.py`](../../backend/scripts/diagnostics/probe_responses_trace_replay.py)。初版临时脚本已清理，仓库脚本的原始变体请求与先前保留请求逐字段核对一致；正文提及的原始/非流式/Skill/timeout/强制工具/原始 SSE 变体均可通过该脚本重建。

从 backend 目录执行，路径使用受控目录占位符；每次使用新的输出子目录：

```bash
PYTHONPATH=. .venv/bin/python scripts/diagnostics/probe_responses_trace_replay.py \
  --allow-real-data --allow-real-llm \
  --trace-export '<受控调查目录>/trace.json' \
  --round 3 --preset MiniMax-M3.1-Flash-Preview \
  --variant original \
  --output-dir '<仓库外受控调查目录>/original-1'
```

替换 `--variant` 可运行 `non_stream`、`short_tool_output`、`short_context`、`without_last_row`、`no_tools`、`without_skill_text`、`numeric_timeout`、`force_call_tool`、`raw_sse`。当前版 `short_tool_output` 仅修改 stdout，保留其他结果字段；与初版替换整个结果对象有区别，不将旧结果冒充当前版的该变体结果。

也可使用 `--trace-db ../loopscope/data/loopscope.db --run-id '<目标run>'` 代替 `--trace-export`。数据库以 SQLite 只读 URI 打开，模型预设只在探针进程内复制并恢复 Responses 协议；不写回运行配置。

原始 trace、请求、SSE 和结果保留于 `<devserver临时目录>/gugu-f1-investigation-20261017/`，目录权限为 0700，尚未清理；临时调查助手已清理，没有向服务植入运行时探针。此目录含真实开发正文，不能提交或公开分享。控制台只输出结构摘要，原始详情写仓库外产物；不保存凭据与请求头。

可用于供应商关联的原始回放响应 ID：

- 失败：`0722badd1f789fc3524936fbcc375747`、`0722bb1e2785800500f2d7f2d20b2dd0`、`0722bbd3bad25512fb6f8ad84338a1ac`。
- 后来流式成功：`0722bf62cae770ca138c417bb47d0472`。
- 非流式成功：`0722bbb19531a061d3e9c009c6d1fad7`、`0722bbe6a4ee8be34fc15abbf7d63b2c`。

## 8. 回归验证

在 devserver 串行执行：

```bash
PYTHONPATH=. .venv/bin/pytest -q \
  tests/agent/test_error_presentation.py \
  tests/agent/providers/test_provider_errors.py \
  tests/agent/test_phase2_reasoning_drivers.py \
  tests/agent/providers/test_anthropic_stream_recovery.py
```

共 66 项。新增回归保护失败前无正文、已有正文及工具调用项后失败、`response.failed` 与通用 `error` 两类事件：失败必须关闭流、没有成功 done、不重试工具；原始错误仅保留在受限诊断，包装异常的 Web/IM 分类一致，内部 RuntimeError 不误判为上游错误。

应用代码只改变错误分类、事件识别和诊断，不修改流式正常生成、工具权限、Skill 或用户配置。最终执行结果见对应开发记录。
