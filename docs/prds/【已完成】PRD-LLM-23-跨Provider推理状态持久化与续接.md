# PRD-LLM-23：跨 Provider 推理状态持久化与续接

> 状态：Phase 1/2/3 实现完成；真实 Provider 验收按发布前 runbook 执行
> 创建：2026-09-05
> 最近更新：2026-09-05
> 关联模块：`backend/agent/loop_drivers.py`、`backend/agent/context/provider_history.py`、`backend/agent/context/canonical_tool_history.py`、`backend/agent/context/run_finalize.py`、`backend/agent/context/assembly/`
> 背景参考：[`docs/agent/09-MESSAGE-PROTOCOL.md`](../agent/09-MESSAGE-PROTOCOL.md)、[`docs/agent/02-ARCHITECTURE.md`](../agent/02-ARCHITECTURE.md)、[`docs/prds/【已完成】PRD-LLM-11-Canonical Context与Provider Adapter分层重构.md`](./【已完成】PRD-LLM-11-Canonical%20Context与Provider%20Adapter分层重构.md)、[OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)、[Anthropic Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| 模型级推理持久化策略 | `AISettings/AIPresetItem/UserProviderCredential.reasoning_persistence` → run-start policy | ✅ 已完成 | 每个模型独立配置 `off / summary / continuation`，Admin 与用户 BYOK 使用同一组选项，默认 `off`。 |
| OpenAI Responses 推理续接 | 独立 `OpenAIResponsesDriver` | ✅ 已完成 | 使用 `responses.create`、`previous_response_id` 和 function-call output；Chat Completions 不宣称续接。 |
| Anthropic thinking block 续接 | 同一 Run 与跨请求均保留原始 block | ✅ 已完成 | `thinking`、`redacted_thinking`、`signature`、`tool_use` 等完整 blocks 进入受保护 provider state。 |
| Provider-specific 状态隔离 | 当前 canonical history 不保存 provider thinking | ✅ 已完成 | 独立状态表由 ownership、加密、TTL 和 CAS 服务保护，不进入普通历史。 |
| 推理状态失效 | 统一 coordinator + state service | ✅ 已完成 | 模型/API/推理配置、分支、压缩、错误、过期和关闭策略都会阻止旧状态回放。 |
| 用户可见思考内容 | 当前不向 Web/IM 普通消息展示 | ✅ 已完成 | 新功能不得改变该边界。 |

## 1. 背景与目标

### 1.1 现状问题

咕咕当前已经能在一次 Agent Run 内维护 Provider 所需的工具续轮，但一次 Run 结束后，持久化的 canonical history 主要保存用户消息、助手消息、工具调用和工具结果，不保存 Provider 私有的推理过程。服务重启、下一次独立请求、分支恢复或上下文压缩后，模型只能重新基于可见历史推理。

OpenAI 与 Anthropic 对“推理状态”的协议也不同：

| Provider | 推荐续接机制 | 状态特点 |
|---|---|---|
| OpenAI Responses | `previous_response_id`，或在无状态场景携带加密 reasoning content | 由 Responses 管理响应链；`instructions` 不会随 `previous_response_id` 自动继承，且 `store` 有数据保留含义。 |
| Anthropic Messages | 原样回放 `thinking` / `redacted_thinking` blocks 及签名 | 必须保持 block 顺序和内容完整，不能自行摘要后当作原 block 回传。 |
| OpenAI Chat Completions | 无等价的跨请求私有 reasoning continuation | 只能保留普通历史或转用 Responses；不能宣称已延续推理状态。 |

因此，产品层需要一组统一的模型级选项，但实现层不能建立一份跨 Provider 的“思考消息格式”。模型配置只表达该模型的持久化意图，Provider Adapter 负责将意图映射为各自可用的续接机制。

### 1.2 目标

建立统一的推理状态策略：

```text
reasoning_persistence = off | summary | continuation
                              ↓
                    Persistence Policy
                       ↓          ↓
            OpenAI Responses   Anthropic Messages
              provider state     provider state
```

目标包括：

1. OpenAI Responses 与 Anthropic Messages 由同一套模型级选项控制，不要求用户理解两种协议差异。
2. `continuation` 在能力允许时跨请求延续 Provider 私有推理状态，尤其覆盖工具调用后的后续请求。
3. canonical history 继续保持 Provider 无关，不写入无法跨 Provider 解释的 thinking wire block。
4. Provider、模型、API 格式或推理配置变化时确定性失效，不使用旧状态污染新请求。
5. 推理状态可观测、可过期、可删除，且不进入 Web、QQ、微信、飞书等用户可见消息。
6. 默认行为保持兼容：模型配置为 `off` 时，Agent 仍按当前历史和工具续轮运行。

### 1.3 非目标

- 不向用户展示或承诺展示模型完整、可读的内部思考过程。
- 不把 OpenAI Responses 的状态和 Anthropic 的 thinking blocks 转换成一个通用消息 block。
- 不把 `reasoning_persistence` 当作已有 `thinking`、`reasoning_effort` 或压缩阈值的替代配置。
- 不强制所有 OpenAI-compatible Provider 迁移到 Responses API。
- 不改变 canonical history 中用户消息、助手最终文本、工具调用、工具结果和交互事件的语义。
- 不在本 PRD 内改变模型供应商的思考预算、模型路由策略或工具 Schema。
- 不把未经脱敏的 reasoning、签名、用户正文或工具参数写入普通日志和 LoopScope 展示。

## 2. 功能需求

### FR-LLM23-01：统一模型级推理持久化选项

系统提供一个跨 Provider 的有效配置 `reasoning_persistence`，取值为：

| 值 | 行为 |
|---|---|
| `off` | 不保存跨请求推理状态。一次 Run 内为满足 Provider 工具协议而临时保留的 block 不视为持久化。 |
| `summary` | 只保存有限的内部摘要、状态计数、token 用量、耗时和 fingerprint；不把完整状态回放给模型。Provider 未提供安全摘要时不得强行发起额外 LLM 请求，只保存统计信息。 |
| `continuation` | 在 Provider 和当前 API 支持时保存可恢复的 provider-specific 状态，并在后续同条件请求中续接。 |

配置的有效值在 Run 开始时解析并固定到执行快照，运行中途修改模型配置不影响已经开始的 Run。Admin 模型预设和用户 BYOK 模型展示同一套语义；Provider 能力差异通过状态提示和诊断字段体现。

状态持久化的前提是存在可验证的 `owner_user_id + session_id`。Web/IM 交互式会话满足该边界；定时任务、反思等没有稳定会话身份的后台运行明确使用 `off`，继续沿用各自的 canonical history、通知和用量链路，不把一次性运行伪装成可续接会话。

### FR-LLM23-02：OpenAI Responses 状态续接

当有效策略为 `continuation` 且模型路由选择 OpenAI Responses 时，系统应：

- 优先保存可验证的 `response_id` 链，并在相同会话条件下使用 `previous_response_id` 续接；
- 在不适合服务端存储或启用了相应无状态隐私策略时，按 Responses API 能力保存并回放加密 reasoning content；
- 显式重新发送每次请求所需的 `instructions`、工具定义和业务上下文，不假设它们会因 `previous_response_id` 自动继承；
- 记录 `store`、响应链、模型和配置 fingerprint 等最小元数据，避免将完整响应对象当作 canonical history；
- 当前路径仍使用 Chat Completions 时，不伪造 Responses continuation。系统必须记录 `continuation_unavailable`，并按明确的降级策略执行。

OpenAI Responses 的 `include: ["reasoning.encrypted_content"]`、`previous_response_id`、`store` 和 `instructions` 继承规则以官方 API 能力为准，不由业务层自行推断。[官方 API 参考](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

### FR-LLM23-03：Anthropic thinking 状态续接

当有效策略为 `continuation` 且模型路由选择 Anthropic Messages 或 Anthropic-compatible API 时，系统应：

- 保存响应中需要续接的 `thinking`、`redacted_thinking`、`signature` 和其他 Provider 要求字段；
- 下一次同 Provider 续轮时使用原始顺序和原始字段回放，不过滤、截断、重排、拼接或重新生成这些 block；
- 工具调用续轮保留完整的 assistant content blocks，再追加对应的 `tool_result`，保证 `tool_use_id` 和 block 关系不变；
- 当 Provider 不支持当前模型/配置的 thinking continuation 时，记录明确不可用原因，不将普通文本摘要伪装成 thinking block；
- 对 Anthropic-compatible Provider 保留协议标识和模型标识，不能因为 wire 格式相似就跨供应商复用状态。

Anthropic 官方要求涉及工具调用时保留完整 thinking blocks；修改、过滤或重构历史中的 thinking block 可能导致请求被拒绝。[官方 Extended Thinking 文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

### FR-LLM23-04：状态与 canonical history 隔离

推理状态必须作为独立的 Provider state 保存，不能直接写入普通 `canonical history`。canonical history 只保存跨 Provider 可解释的语义事实；Provider state 仅供匹配的 Adapter 使用。

每份状态至少关联以下边界：

- `owner_user_id`、`session_id` 和会话 scope；
- `provider`、`api_format`、`model_id` 和模型配置 fingerprint；
- `reasoning_persistence` 的有效值及 thinking/reasoning 配置 fingerprint；
- 来源 Run、Round 或响应链的不可猜测标识；
- 创建时间、最后使用时间、过期时间、版本和状态摘要 fingerprint。

Provider state 不得被普通 history 查询、RAG 召回、记忆反思、渠道展示或跨用户查询读取。状态读取必须经过现有 ownership/session 边界校验。

### FR-LLM23-05：确定性失效与切换边界

出现以下任一情况时，旧 provider state 必须失效或不可继续使用：

- Provider、API 格式、模型或模型配置 fingerprint 变化；
- `thinking`、`reasoning_effort`、thinking budget 或响应存储策略变化；
- 会话分支、恢复到旧版本、上下文压缩生成新基线或 canonical history 重建；
- 状态过期、响应链断裂、签名校验失败或 Provider 返回状态不可恢复；
- 用户关闭 `summary/continuation`，或删除会话、消息和相关数据；
- 状态与当前会话 owner、scope、run 或 tool history 不匹配。

失效后不得静默使用旧状态。若当前策略是 `continuation`，应产生结构化的不可用诊断；是否继续本轮由现有 Provider fallback/错误策略决定，不能把数据边界错误伪装成普通成功。

### FR-LLM23-06：摘要、观测和用户展示边界

`summary` 模式和 LoopScope 观测只用于内部诊断，不改变用户可见回复。允许记录的内容包括：

- 是否启用 thinking/reasoning；
- Provider、模型和 API 格式；
- thinking block 数量、类型计数、token 用量、耗时和状态大小；
- 状态版本、是否命中续接、失效原因和不可逆 fingerprint；
- OpenAI response chain 是否连续、Anthropic block round-trip 是否一致。

默认不记录 reasoning 正文、Anthropic 签名原文、用户正文、附件名、完整工具参数或 API 凭据。调试需要时只能使用受限诊断字段，并沿用现有脱敏与访问控制。

### FR-LLM23-07：配置与并发一致性

同一会话不能让并发 Run 互相覆盖 provider state。写入必须具备版本或乐观并发条件：

- 只有成功完成且与当前状态版本匹配的 Run 才能提交新状态；
- 失败、取消、超时和过期 Run 不得覆盖较新的状态；
- 同一 session 的新请求读取状态时，必须区分“已提交状态”和“当前 Run 内临时状态”；
- provider state 提交与 Run finalization 的关系必须可恢复，不能出现 canonical history 已提交但状态指向未完成 response 的假续接。

## 3. 技术方案

### 3.1 统一策略与 Provider Adapter 边界

新增独立的策略对象，例如：

```python
ReasoningPersistencePolicy(
    mode="off" | "summary" | "continuation",
    effective_at_run_start=True,
)
```

策略对象只决定“是否保存、是否尝试续接”；它不包含任何 OpenAI 或 Anthropic wire 字段。Provider Adapter 负责实现：

```text
Policy
  -> ProviderState.prepare()
  -> Provider request rendering
  -> Provider response extraction
  -> ProviderState.commit()
```

建议将协议差异放在现有 Provider/driver 层：

- OpenAI Responses：新增或扩展独立 Responses driver，不把 Responses-only 字段塞入当前 Chat Completions driver；
- Anthropic：扩展现有 `AnthropicDriver` 的 raw block 提取、状态恢复和提交；
- 其他 OpenAI-compatible Provider：默认声明 continuation 不可用，除非有经过验证的等价协议。

### 3.2 Provider state envelope

Provider state 使用独立 envelope，业务层只依赖通用元数据，具体 payload 由 Adapter 管理：

```json
{
  "version": 1,
  "provider": "anthropic",
  "api_format": "anthropic",
  "model_id": "...",
  "config_digest": "...",
  "session_id": "...",
  "source_run_id": "...",
  "source_round_id": "...",
  "sequence": 4,
  "state_kind": "anthropic_thinking_blocks",
  "payload": "provider-protected data",
  "payload_digest": "...",
  "created_at": "...",
  "last_used_at": "...",
  "expires_at": "..."
}
```

`payload` 不得进入 API 响应、普通日志、LoopScope 正文或 canonical message JSON。落库保护方式沿用项目现有敏感数据存储规范；如果现有部署无法提供足够的静态加密能力，`continuation` 不应在该部署中默认开启。

### 3.3 OpenAI Responses 适配

OpenAI Responses 续接优先采用服务端 response chain，保存 `response_id` 及其匹配条件；无状态或数据保留策略不允许依赖 response chain 时，再评估保存加密 reasoning content。两种路径都必须保存模型、API 格式、工具 Schema digest 和 instructions/context 基线信息，以便判断能否安全续接。

Responses 的 `max_output_tokens` 包含 reasoning tokens，因此预算观测必须区分普通输出和 reasoning 用量，不能用现有 Chat Completions 的单一输出 token 字段直接代替。

### 3.4 Anthropic 适配

现有 `AnthropicDriver` 已经在一次 Run 内通过 `RoundResult.raw` 保留原始 content blocks。实施时将这部分能力拆成明确的状态提取/恢复边界：

```text
Anthropic response.content
  -> extract provider state
  -> persist protected envelope
  -> next request: restore exact blocks
```

当开启工具调用时，必须把 assistant 的完整 thinking/text/tool_use blocks 作为一组处理，再追加工具结果。不能只保存可读 thinking 正文，也不能把签名丢弃后重新构造 block。模型能力和 thinking 模式变更会使状态失效；Anthropic 文档也说明修改 thinking 配置会影响提示词缓存边界。

### 3.5 Context、压缩与 baseline

Provider state 是 provider wire continuation，不是新的 canonical history。Context Assembly 的顺序保持不变：

```text
static system
  -> session snapshot
  -> canonical history
  -> current turn
  -> provider-specific continuation state
```

Provider state 只能在最后的 Provider boundary 加入，不能参与 RAG、Skill、记忆召回或 canonical digest。上下文压缩生成新 baseline 后，旧 reasoning state 必须被标记为不可续接，避免旧 response chain 与新历史不一致。

### 3.6 LoopScope 与日志

新增诊断字段建议包括：

```json
{
  "reasoning_persistence": "continuation",
  "continuation_attempted": true,
  "continuation_reused": true,
  "continuation_unavailable": false,
  "state_provider": "anthropic",
  "state_kind": "thinking_blocks",
  "state_block_count": 3,
  "state_digest": "...",
  "invalidated_reason": null
}
```

LoopScope 可记录结构、计数、耗时和 digest，不默认展示或持久化 thinking 正文。诊断字段必须能区分：没有启用、没有可用能力、状态未命中、状态被主动失效和 Provider 拒绝续接。

当前实现由 `ReasoningStateCoordinator.diagnostics()` 生成安全标量，并通过
`record_reasoning_state_diagnostics()` 写入当前 LoopScope run 的
`attributes.reasoning_state`。允许字段固定为策略、状态枚举、Provider/API/模型标识、状态
类型、block 数量、状态大小、版本、序号和不可逆 digest；`events` 最多保留最近 12 个状态转换。
诊断入口拒绝嵌套对象，因此 provider payload、用户正文、完整工具参数、签名和凭据不会进入
Collector。

### 3.7 文件目录与责任边界

根据当前代码调查，第一版采用“用户偏好控制策略、Provider state 独立存储”的落地边界。以下是预计需要修改或新增的文件；实际实施时若发现现有模块已提供等价能力，应优先复用，不再创建第二套实现。

#### 文件树

```text
Gugu-web/
├── backend/
│   ├── agent/
│   │   ├── context/
│   │   │   ├── reasoning_state.py              【新增】统一策略、envelope、fingerprint、失效原因
│   │   │   ├── provider_history.py             【修改】Provider/API 切换时失效 provider state
│   │   │   ├── run_context.py                  【修改】固定本轮策略、状态版本和配置 fingerprint
│   │   │   ├── run_finalize.py                 【修改】提交或放弃本轮 provider state
│   │   │   ├── compaction.py                   【修改】压缩生成新 baseline 时失效旧状态
│   │   │   ├── compress_conv.py                【修改】接入压缩后的状态失效
│   │   │   └── branch.py                       【修改】分支不继承不匹配的 provider state
│   │   ├── llm/
│   │   │   └── llm_select.py                   【修改】解析本轮有效 reasoning 策略
│   │   ├── providers/
│   │   │   ├── base.py                         【修改】声明 continuation 能力和 state adapter 契约
│   │   │   ├── anthropic.py                    【修改】提取并原样恢复 thinking blocks
│   │   │   ├── openai_responses.py             【新增】Responses 请求、response_id 和加密 reasoning state
│   │   │   └── minimax.py                      【条件】仅在实测支持 continuation 时声明能力
│   │   └── loop_drivers.py                     【修改】接入请求前恢复、响应后提取和提交
│   ├── app/
│   │   ├── models/
│   │   │   └── __init__.py                     【修改】增加 ProviderReasoningState ORM 模型
│   │   ├── services/
│   │   │   └── provider_reasoning_state.py     【新增】ownership、加密、版本、TTL、删除服务
│   │   ├── schemas/
│   │   │   └── __init__.py                     【保持】用户偏好不承载推理持久化策略
│   │   └── api/v1/
│   │       └── byok/schemas.py                 【修改】接收用户 BYOK 模型级策略
│   ├── alembic/
│   │   └── versions/
│   │       └── <时间戳>_add_provider_reasoning_states.py
│   │                                           【新增】状态表、索引、外键和过期查询字段
│   └── tests/
│       ├── test_reasoning_state.py              【新增】策略、envelope、ownership、TTL、并发和删除
│       ├── test_provider_history.py             【修改】Provider 切换和 state 失效
│       ├── test_history_persist_filter.py       【修改】canonical history 与 provider state 隔离
│       ├── test_core_loop_characterization.py   【修改】Anthropic round-trip 和 Responses 续接
│       ├── test_loop_driver_usage_semantics.py  【修改】reasoning token 和续接 usage
│       ├── test_compaction.py                   【修改】压缩/baseline 失效
│       ├── test_context_branch.py               【修改】分支状态隔离
│       ├── test_preferences_api_contract.py     【修改】确认用户偏好不承载模型策略
│       └── test_preferences_cache_contract.py   【修改】context revision 和配置回滚
├── frontend/
│   └── src/
│       ├── services/api.ts                      【修改】复用现有 preferences API 类型调用
│       ├── components/common/profile/
│       │   └── ProfileByokPane.vue               【修改】用户 BYOK 模型级推理状态设置
│       ├── views/Admin/Agent/llm/components/
│       │   └── LlmPresetEditor.vue               【修改】平台模型级推理状态设置
│       └── types/api.ts                          【生成】只通过 OpenAPI 流程更新，不手工编辑
└── docs/
    └── agent/
        ├── 09-MESSAGE-PROTOCOL.md              【修改】补充 Provider state 恢复边界
        └── 02-ARCHITECTURE.md                  【修改】补充策略、Adapter 和持久化职责
```

目录中的职责对应关系：

- `reasoning_state.py` 只放 Provider 无关策略和 envelope，不放 OpenAI/Anthropic wire 字段。
- `openai_responses.py` 与 `anthropic.py` 分别处理各自的状态格式；`loop_drivers.py` 只负责接入统一生命周期。
- `ProviderReasoningState` 独立于 `ConversationMessage`，canonical history 不保存不可跨 Provider 解释的 thinking block。
- 策略按模型落在 `AISettings`、`AIPresetItem` 和 `UserProviderCredential`，不再由 `UserPreferences.data_json` 提供总开关。
- `frontend/src/types/api.ts` 和 `backend/ts/packages/contracts/src/api.d.ts` 是生成文件，后端 OpenAPI 变更后重新生成，不能手工维护。

#### 第一版明确不修改的文件

- `backend/agent/context/canonical_tool_history.py`：不把 thinking/reasoning wire block 加入 canonical 语义；最多补充隔离回归测试。
- `backend/app/byok/schemas.py`、`backend/app/byok/service.py`：用户 BYOK 模型保存并返回自己的 `reasoning_persistence`。
- `backend/app/core/config.py`、`AIPresetItem`：保存平台模型自己的策略；不再提供与模型配置重复的用户总开关。
- `backend/agent/im/loop.py` 及各平台 Gateway：不在渠道层保存或恢复推理状态，继续使用共享 Agent/Context 链路。
- `frontend/src/types/api.ts`、`backend/ts/packages/contracts/src/api.d.ts`：这是生成文件，只在后端 OpenAPI 变更后重新生成，不直接编辑。

## 4. 验证与上线

### 4.1 契约验收

- 一个统一 `reasoning_persistence` 配置能被 OpenAI Responses 和 Anthropic adapter 读取，且不出现 Provider 专用配置泄漏到通用策略对象。
- `off` 模式不产生跨请求 provider state；同一 Run 内为工具协议保留的临时 block 不被误报为持久化。
- `summary` 模式只产生受限摘要/统计，不把完整 reasoning state 放入下一次 Provider request。
- `continuation` 模式分别验证 OpenAI response chain 和 Anthropic 原始 block round-trip，不能只测通用 mock。

### 4.2 历史和失效验收

- canonical history 的 digest、用户可见消息和工具调用结构不因启用 continuation 改变。
- Provider、模型、API 格式、thinking 配置、压缩 baseline 和分支变化均能阻止旧状态回放。
- 删除会话或用户数据后，关联 provider state 一并删除或不可恢复；跨 owner 查询无法读取。
- 两个并发 Run 不能互相覆盖新状态；旧 Run 完成后不能把状态指针回退。

### 4.3 真实 Provider 验证

每个支持的 Provider 至少验证以下序列：

1. 普通多轮对话：第一轮保存状态，第二轮命中续接。
2. 工具调用：assistant thinking/tool call → tool result → 下一轮，确认协议完整。
3. 服务重启：重启后恢复状态，或按状态策略明确不可恢复。
4. 压缩与模型切换：确认旧状态不被错误回放。
5. Provider 错误：签名、response chain 或状态过期时得到结构化失败/降级结果。

LoopScope 重点观察 `continuation_reused`、状态 digest、round-trip 一致性、输入 token、thinking token、延迟、缓存命中率和错误分类；不以“模型输出更长”作为成功标准。

### 4.4 发布、灰度与回滚

初始默认值为 `off`。先在开发环境对 OpenAI Responses 和 Anthropic 分别灰度 `summary`，确认状态边界和脱敏，再由管理员或用户在对应模型配置中显式开启 `continuation`。出现协议拒绝、状态串会话、成本异常或延迟回退时，可将对应模型切回 `off`；已保存状态按过期/删除策略清理，不影响 canonical history 和普通对话恢复。

Phase 3 的本地契约验收覆盖状态诊断、脱敏边界、默认关闭、未命中、无稳定会话不可用和 Provider
拒绝；服务重启、真实 Provider、压缩、切换和回滚使用发布前的
[`LLM-23 Provider 状态验收清单`](../ops/llm23-provider-state-validation.md)执行。无凭据或未启用
对应 Provider 时不得用 mock 结果替代真实 Provider 结论。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| Provider 状态包含敏感推理内容 | 数据库、备份或诊断泄漏内部信息 | 默认关闭；独立受保护存储；严格 ownership；不进入普通日志和用户消息。 |
| OpenAI response chain 有服务端保留语义 | 用户关闭存储或部署使用 ZDR 时无法直接复用 | 将 `store`/保留策略纳入能力检查，必要时使用加密 reasoning 或明确降级。 |
| Anthropic block 被压缩、重排或重新构造 | 请求 400、工具续轮失败 | 以原始 block 集合为不可变 payload；配置/模型/压缩边界变化时失效。 |
| Chat Completions 被误报为 Responses continuation | 实际没有延续推理，诊断与用户预期不一致 | Responses 单独 driver；不支持时记录 `continuation_unavailable`，禁止静默伪造。 |
| 并发 Run 覆盖状态 | 下一次请求引用错误 response 或 thinking block | 状态版本、source Run/sequence 和 finalization 原子提交。 |
| thinking 状态增加成本和上下文长度 | 费用、延迟和上下文预算上升 | 统计 reasoning token、状态大小和命中收益；默认 `off`；配置 TTL 和容量上限。 |

已决策边界：

- `reasoning_persistence` 按模型配置，平台模型写入 `AISettings/AIPresetItem`，用户 BYOK 写入 `UserProviderCredential`；每次 Run 开始从最终选中的模型固定策略。旧版 `UserPreferences.data_json.reasoning_persistence` 不再读取，保留在历史 JSON 中不影响运行。
- provider state 使用独立数据库表和现有敏感数据加密服务，具备 ownership、TTL、删除和乐观 CAS；不进入 `ConversationMessage`。
- OpenAI Responses 当前实现 response chain 路径；无状态加密 reasoning content 仍属于真实 Provider 验收项，不在本地 mock 测试中宣称完成。
- `summary` 只用于受限内部摘要/统计，不进入下一轮模型上下文，也不展示完整 thinking 正文。

## 6. 唯一实施 TODO

### Phase 1：策略与状态边界

- [x] `LLM23-001` 定义统一 `ReasoningPersistencePolicy` 和 provider state envelope；验收：`off/summary/continuation` 语义、版本、ownership、配置 fingerprint 和失效原因有单一实现，未加入 Provider wire 字段。
- [x] `LLM23-002` 建立独立 provider state 的存储、读取、过期、删除和并发提交契约；验收：状态不进入 canonical history、普通日志、RAG 或渠道展示，跨 owner 与并发覆盖测试通过。

### Phase 2：Provider 适配

- [x] `LLM23-003` 接入 OpenAI Responses continuation driver；验收：明确区分 Responses 与 Chat Completions，使用独立的 `responses.create`、`previous_response_id` 和 function-call output；Chat Completions 明确报告不可续接，不伪造 Responses 状态。当前通过本地契约/驱动测试，真实 Provider 验收留在 `LLM23-007`。
- [x] `LLM23-004` 为 Anthropic Messages 接入 thinking state 提取与原样回放；验收：状态层保存完整 assistant content blocks，工具续轮保留 thinking、redacted_thinking、signature 和 tool_use，恢复只在 provider boundary 进行。当前通过本地契约/驱动测试，真实 Provider 验收留在 `LLM23-007`。
- [x] `LLM23-005` 将 provider/model/API/thinking 配置、压缩 baseline 和错误状态接入统一失效策略；验收：run 开始固定策略并按配置指纹匹配，成功收尾才提交，压缩、provider 错误和状态冲突阻止旧状态继续使用。

### Phase 3：观测与发布

- [x] `LLM23-006` 增加 LoopScope 和受限诊断字段；验收：能区分未启用、未命中、已复用、不可用、过期和 Provider 拒绝，诊断不包含 reasoning 正文、用户正文、完整工具参数或凭据。
- [x] `LLM23-007` 补齐本地 `off/summary/continuation` 契约、发布/灰度/回滚验收清单，以及真实 Provider 和服务重启的可执行验收入口；真实 Provider 结果必须在发布前按清单实测记录，不能由本地 mock 代替。
