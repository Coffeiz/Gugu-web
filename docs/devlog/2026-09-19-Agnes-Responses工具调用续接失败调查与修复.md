# Agnes Responses 工具调用续接失败：调查与修复

## 现象与影响

使用 Agnes 的 OpenAI-compatible Responses API 时，普通 Chat Completions 正常，但涉及工具调用的对话偶发在后续 Responses 请求收到 400/404。曾观察到完整请求不兼容后本轮回退到 Chat Completions；因此对话有时仍能完成，但 Responses 工具续接和缓存行为不稳定。

问题不是 Responses 端点完全不可用：简单请求及普通轮次可以成功。Agnes 文档声明支持 Responses，但实际工具调用请求的 item 结构要求更严格；官方“支持 API”不能单独证明完整 Agent 往返的请求形态已经验证。

## 调查过程

1. **对照文档与真实请求。** 文档公开列出了 Responses API；工具调用文档和实际工具往返仍需以真实 wire 请求验证。使用变异探针逐项比较后发现：Responses `function_call` input item 需要包含原输出项 `id`，并且需要 `call_id`；只带 `call_id` 会因 input item 结构校验失败而返回 400。`arguments` 需要保持 JSON 字符串。探针中 `status` 不是必需项，但不能用 `status` 替代缺失的 `id`。

2. **定位首次字段丢失。** Responses output 的 function call 同时带有 `id`（output item ID）和 `call_id`（工具调用关联 ID）。驱动归一化为 `NormalizedToolCall` 时原先只保留了 `call_id`、名称和参数。canonical 历史再渲染时无法恢复 output item ID，导致全历史重放生成的 `function_call` 缺少 `id`。

3. **首次修复后根据新日志继续追踪。** canonical 持久化路径虽然已保存 `responses_item_id`，但同一 run 的下一轮使用另一条路径：`build_tool_round()` 从 `_ResponsesRaw.tool_calls_payload` 生成临时 provider 历史。该 payload 当时仍未保留 item ID。因此旧 response chain 返回 404 后，driver 虽正确尝试无状态全历史重试，重试请求仍因缺少 `id` 返回 400，最终触发 Chat Completions fallback。

4. **区分 404 与 400。** 日志只记录 HTTP 状态，没有 Agnes 返回的 400 响应正文，故不能仅凭日志断言服务端错误消息。但请求时序与代码分支吻合：携带 `previous_response_id` 的请求收到 404，随后 `_is_stale_response_chain_error()` 触发一次无状态完整历史重试；补齐本地工具项的 output item ID 后，同样的 404→重试路径得到 200。这说明 404 可由 response chain 不可用触发恢复，而修复前的 400 是重放 item 结构仍不完整。

## 修复

- 在 `NormalizedToolCall` 与 canonical `tool_call` 中增加可选 `responses_item_id`。没有该字段的旧记录和其他 provider 调用保持原有 canonical 形状。
- Responses output 解析时同时保留 `id` 与 `call_id`；将 ID 传入两条下游路径：canonical 持久化历史，以及同 run 的 `_ResponsesRaw.tool_calls_payload`。
- `_responses_input()` 重放工具调用时分别发送 `id`、`call_id`、名称和原始 JSON 字符串参数。
- Chat Completions 出站前剥离 Responses 专属内部元数据；Anthropic renderer 不读取该字段，因此不改变这两类协议的 wire 请求。
- 保留窄范围的 stale response-chain 恢复：只在已有 `previous_response_id` 且错误明确指向 response/tool ID 不存在时，移除 chain ID 并用完整本地历史重试一次；不把普通 404 一概当作 Responses 不兼容。

## 验证

- 单元回归覆盖 Responses output 解析、同 run 工具轮之后的下一次 input、canonical JSON 持久化后的跨 run 历史重放，以及 Chat Completions 出站剥离元数据。
- 本地和 devserver 上相关历史/provider 测试均为 **68 passed**。
- 用户随后提供的实测日志显示：两轮工具续接各自出现 Responses 404 后，全历史重试均为 200；工具执行成功，后续 Responses 请求也为 200，未再出现 400 或 Chat Completions fallback。

### 双模型同会话切换探针（2026-09-19）

使用 devserver 中已配置的 Agnes Responses URL/Key，只在请求中切换模型名；没有读取真实会话，不执行真实工具，合成工具回执固定为无副作用数据。所有交叉步骤都发送完整本地历史，不带 `previous_response_id`，因此专门验证模型切换后的全历史重放形状。

- 首次探针显式发送 `tool_choice={type:function,...}`，两个模型均在首轮返回 400（上游错误类型 `upstream_error`，错误正文未落日志）。这是探针与生产 driver 的差异：Gugu 只发 tools、采用默认 auto，不发送 `tool_choice`。去掉该字段后，两模型自动工具调用都能成功；该 400 不属于模型切换故障。
- 最小文本请求：2.5 与 3.0 的非流式、流式请求均返回 200。3.0 非流式极小 `max_output_tokens=8` 请求标记 `incomplete`，属于探针预算过低，不视为协议失败。
- 3.0 单独的自动工具调用：非流式返回 200 并产出包含 `id` 与 `call_id` 的 `function_call`；流式、无历史的自动工具调用约 3 秒返回 200，事件流完整。
- 双向交叉复测：`2.5 → 3.0 → 2.5` 三步均 200；`3.0 → 2.5 → 3.0` 三步均 200。3.0 能接收包含旧 `function_call` 与 `function_call_output` 的完整历史；反向路径中 2.5 和切回后的 3.0 也都成功。未观察到历史 item 缺字段或跨模型污染。
- 中间一次交叉测试的多个 3.0 请求约 56 秒 `ReadTimeout`，但同样的无历史流式工具请求随后约 3 秒成功，双向完整交叉重跑也全部成功。该 timeout 是间歇性的上游/网络等待，现有结果无法细分是 Agnes 推理排队还是传输层停顿；没有证据表明它由 session 历史或模型互切稳定触发。
- 按“新会话 → 首模型真实生成 Responses 工具调用 → 合成工具回执 → 切换模型并发送完整历史”另做定向复测，输出上限提高到 256 后两方向均完整完成：2.5 生成工具调用后切 3.0 成功；3.0 生成工具调用后切 2.5 也成功。历史含 assistant、`function_call`、`function_call_output`、user 项，`previous_response_id` 未发送；没有触发 400，也没有工具 ID/参数字段错误。
- 这仍未复现用户原会话那次 400。探针能排除“标准工具调用历史 + 模型名互切”本身必然导致 400，但原会话的完整上下文、真实工具 schema/回执和失败请求体未采集，因此原始 400 的具体拒绝字段仍未确定。首轮带 `tool_choice` 的探针 400 是非生产请求形状造成，不能作为原故障解释。

## 结论与后续边界

这是 Gugu 通用 OpenAI Responses driver 的历史重放缺失字段，不是 Agnes 专用 endpoint/path 配置问题。先在共享 Responses driver 修复标准 `function_call` item 的回放；若其他 Responses provider 后续对标准字段、参数或流式行为给出不同错误，再根据脱敏诊断添加 provider capability/专项适配，不预先扩大共享协议差异。

### SESSION #882：失败轮次的空 assistant 展示行污染历史（2026-09-19）

此前的交叉探针确认标准工具往返及模型切换本身可用，但 SESSION #882 在两种 Agnes 模型下都会稳定 400。只读检查会话记录与受限诊断日志后，确认这是另一条独立问题，与上文的 `function_call` item ID 丢失不同。

#### 根因证据

- `ConversationMessage id=56378` 创建于 `2026-09-19 12:26:46 UTC`，与该会话先前出现的 `ReadTimeout` 时间吻合。该行外层 `content` 为空、`content_json` 为 `NULL`、没有 files，但带有两条 `display_timeline` 项：一条极短的部分 assistant 展示片段和一条已成功完成的工具事件。
- Web 生成失败/取消时会保留已发生的 UI 展示产物。失败收尾以 `text=""`、`display_timeline` 调用 `finalize_run()`；统一收尾函数因 timeline 非空而写一条 assistant 展示行。其设计目的是让刷新后仍可恢复部分输出/工具卡，不代表模型产生了一条空的 canonical assistant 回答。
- `load_session_history()` 当前排除 summary 之外会读取整条 `ConversationMessage`。历史投影遇到 `content_json is NULL` 时从正文与附件引用生成 OpenAI 消息；对 #882 这条展示行得到 `role=assistant, content=""`。
- Responses 投影把该消息原样变成普通 input item `{role: "assistant", content: ""}`。诊断日志记录的上游原始错误为 HTTP 400，外层 `upstream_error`，内部 `invalid_request_error`：`input: Message content cannot be empty`。两次失败的错误相同；这是请求输入校验失败，不是模型名、工具 ID 或 response-chain 续接错误。

#### 修复

- 保留失败/取消时的展示行和 `display_timeline`，但历史组装跳过没有正文、没有 canonical/tool 内容的空 assistant 行；仍保留带 files/quoted context 的有语义历史。
- Responses 出站转换过滤空字符串、纯空白字符串、空数组和仅含空文本块的普通消息；非文本结构块（例如图像）及 function call/output 项继续保留。
- 对已存在的 #882 数据不做删除或迁移；新历史组装和出站过滤会避免再次发送坏 item。
- 回归测试覆盖 UI-only 空 assistant 在 OpenAI/Anthropic history projection 中都被排除，以及 Responses 空内容拦截并保留有效结构化输入。

#### 验证

- `PYTHONPATH=. .venv/bin/pytest -q tests/test_context_history.py tests/test_phase2_reasoning_drivers.py`：**46 passed**。
- `PYTHONPATH=. .venv/bin/pytest -q tests/test_run_finalize.py tests/test_session_history.py tests/test_provider_history_adapters.py`：**17 passed**，覆盖失败展示持久化、历史装载与其他 provider 投影边界。
