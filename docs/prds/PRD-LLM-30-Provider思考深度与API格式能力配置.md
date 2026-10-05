# Provider 思考深度与 API 格式能力配置

> 状态：Phase 1/2 完成，Phase 3 待实施
> 创建：2026-09-29
> 最近更新：2026-09-29
> 关联模块：`backend/agent/providers/`、`backend/agent/loop_drivers.py`、`backend/agent/providers/openai_responses.py`、`backend/app/byok/`、`frontend/src/components/common/profile/ProfileByokPane.vue`、`backend/app/api/v1/agent_admin.py`
> 背景参考：`docs/prds/【已完成】PRD-LLM-3-provider供应商适配层整体整理.md`、`docs/prds/【已完成】PRD-LLM-23-跨Provider推理状态持久化与续接.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| API 格式选择 | 已有 `openai`、`responses`、`anthropic` 的请求分流 | ✅ | BYOK 与 Admin 从同一后端能力快照显示当前模型支持的格式；切换协议时刷新思考选项和默认 URL。 |
| 思考参数映射 | 已有少量供应商专属参数构造 | 🟡 部分完成 | Phase 1/2 按能力快照发送或过滤参数；完整 Provider/模型矩阵仍待 Phase 3 核实。 |
| 模型级思考档位 | BYOK 与 Admin 按后端能力快照渲染 | ✅ | 未知模型和协议只保留默认选项；已知模型按 Provider、模型、API 格式显示档位。 |
| 通用兼容模式默认行为 | 自定义 OpenAI/Anthropic 兼容端点不继承官方模型思考声明 | ✅ | 旧配置在运行配置副本中按当前能力过滤，不改写存量配置；BYOK 默认值也不会继承平台的旧思考设置。 |

## 1. 背景与目标

### 1.1 背景

BYOK 当前将供应商、API 格式和思考参数能力部分耦合在前端白名单与 Provider Adapter 方法中。不同供应商及同一供应商的不同模型支持的思考开关、档位和 API 格式并不相同；OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的参数字段也不同。

通用兼容端点通常无法从“OpenAI 兼容”或“Anthropic 兼容”判断具体模型能力。向这类端点猜测并发送思考参数可能被拒绝，因此通用模式应省略相关参数，让服务端使用模型默认值。选定具体供应商后，应用才依据其模型能力配置展示和发送已知支持的选项。

### 1.2 目标

1. 将三种公共 API 协议请求实现与供应商能力配置分开，避免每个供应商重复实现请求循环。
2. 由 Provider 配置声明支持的 API 格式、默认 API 格式、默认 URL，以及按模型确定的思考模式和档位。
3. 通用兼容模式不提供思考深度选择，也不发送思考相关字段；模型沿用端点默认行为。
4. 具体供应商模式按所选模型和 API 格式显示支持的思考选项，并由公共 API 协议实现写入对应字段。
5. 未声明支持或模型能力未知时，安全地省略思考参数，不通过猜测或失败后重试改变模型行为。
6. 不改变现有推理状态持久化语义；影响推理状态的模型/API/思考配置变化继续使不匹配的状态不可续接。

### 1.3 非目标

- 不为通用 OpenAI/Anthropic 兼容端点探测或推断思考能力。
- 不保证不同供应商、模型或 API 格式具有相同的思考档位或等价语义。
- 不新增逐请求自动重试以移除不支持的参数。
- 不重写 Agent Loop、canonical history、工具循环或推理状态存储。
- 不改造语音识别、Embedding、原生 Ollama 等非三种公共文本 API 协议的独立调用路径。
- 不记录或展示模型内部思考内容。

## 2. 功能需求

### FR-LLM30-01：通用兼容模式使用服务端默认思考行为

当用户选择通用 OpenAI 兼容或 Anthropic 兼容配置，而未选择具体供应商能力配置时，界面不显示思考开关和深度档位。请求不附加 `thinking`、`reasoning_effort`、`reasoning` 或 `output_config.effort` 等思考控制字段，由所配置的端点和模型使用默认行为。

通用模式仍须选择其调用所需的 API 格式和连接信息。兼容格式只说明请求协议，不代表目标模型支持该协议中的所有可选能力。

### FR-LLM30-02：Provider 声明 API 格式能力与默认值

每个具体 Provider 可按模型声明：

- 支持的公共 API 格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 中的一个或多个；
- 默认 API 格式和默认 URL；
- 是否支持各思考模式，以及每个模型和 API 格式支持的档位；
- 标准化档位到协议字段/供应商字段的映射，以及不支持项的省略规则。

BYOK 与 Admin 模型配置使用同一份能力声明。界面仅展示所选 Provider 和模型声明支持的 API 格式；不支持的格式不可选。切换 Provider 时采用新 Provider 声明的默认 URL 与默认 API 格式；用户仍可编辑 URL。

### FR-LLM30-03：思考选项按 Provider、模型和 API 格式过滤

选择具体 Provider 后，系统根据当前模型与 API 格式展示该组合明确声明支持的思考选项。选项至少区分：

- 跟随模型默认：不发送思考控制参数；
- 显式关闭或开启：仅在该模型/格式支持时显示；
- 思考深度：只展示此组合支持的档位。

切换模型或 API 格式后，旧选择若不再受支持，界面必须将其标记为无效并要求用户选择有效选项或恢复默认；运行时不得发送无效的历史配置。模型能力未知时，只提供默认行为。

### FR-LLM30-04：公共协议层构造思考参数

公共协议层按所选 API 格式负责参数结构：

| API 格式 | 思考深度参数位置 |
|---|---|
| OpenAI Chat Completions | `reasoning_effort` |
| OpenAI Responses | `reasoning.effort` |
| Anthropic Messages | `output_config.effort`，以及该模型/Provider 要求的 thinking 模式 |

Provider 配置提供能力声明和必要映射，不复制公共协议请求循环。只有配置显式选择了非默认思考选项且当前组合声明支持时才构造参数；默认值一律省略参数。

### FR-LLM30-05：供应商能力未知或不支持时回到默认

对于未知 Provider、未知模型、未知 API/模型组合或该组合未声明支持的思考档位，运行时不发送思考控制参数，使用端点默认行为。系统不得把“兼容 OpenAI/Anthropic”当作参数被服务端忽略的保证，也不得在收到 400 后自动以默认参数重放同一请求。

连接测试只验证所选 API 的基本连通和鉴权，不宣称已经验证全部思考能力。错误诊断可指出当前组合未声明相关能力，但不得记录密钥、聊天正文或原始思考内容。

### FR-LLM30-06：旧配置兼容

保留现有 `api_format`、`thinking`、`reasoning_effort` 字段的读取兼容。升级后，旧配置只有在 Provider、模型和 API 格式能力声明匹配时才继续发送原思考参数；不匹配或无法确认时按默认处理。保存配置时使用当前允许的值校验，不要求为这些字段新增数据库迁移，除非实现审查发现现有字段长度或持久化类型不足。

## 3. 技术方案

### 3.1 职责边界

```text
BYOK / Admin 配置界面
  ├─ 通用兼容模式：格式与连接配置；思考行为跟随端点默认
  └─ 具体 Provider：根据 Provider + model + api_format 展示能力选项
                 ↓ 配置快照
Provider Adapter（backend/agent/providers/*.py）
  ├─ 声明 supported_api_formats / default_api_format / default_base_url
  ├─ 按模型返回思考模式、档位和参数映射
  └─ 对未知或不支持组合返回默认/不发送
                 ↓ 公共协议分流
OpenAI Chat | OpenAI Responses | Anthropic Messages
  └─ 负责各自请求体、流式响应和工具协议，不承载单个供应商的能力判断
```

Provider 能力声明以现有 `ProviderAdapter`、`ProviderCapabilities` 和每供应商模块为扩展点。公共协议入口继续复用当前驱动，不建立第二套 API 客户端。前端不得自行复制供应商模型规则；由后端能力快照/API 返回可选格式和思考选项，供 BYOK 与 Admin 共用。

### 3.2 配置与运行时

- 内部配置保留“默认/关闭/开启/档位”的标准语义；Provider 可把标准档位映射到协议或供应商实际值，例如将某档位映射成供应商支持的近似档位。不得把近似映射伪装成完全等价，能力声明应明确该映射。
- 协议格式选项、思考选项都以 Provider 与模型能力为准。供应商未声明格式支持时不展示该格式；用户手填自定义 URL 不自动扩大声明能力。
- `api_format`、`thinking`、`reasoning_effort` 仍进入模型有效配置快照。配置变化不得续接使用旧模型/协议/思考设置创建的 Provider reasoning state。
- 通用兼容模式必须在前后端都省略思考参数，避免 UI 隐藏但旧数据库字段仍被运行时发送。

### 3.3 数据、隐私与迁移

- 预计复用现有配置字段，不新增用户数据表或秘密字段；实施时核对 Admin 配置 JSON、BYOK schema 和 ORM 字段长度。
- 不把 API Key、请求正文、Provider 原始错误或思考内容写入可见日志；错误对用户展示前按现有 redaction 规则处理。
- 如确需数据迁移，必须单独确认迁移内容、备份和兼容窗口；当前方案优先保持无数据库迁移。

### 3.4 文件范围

```text
backend/agent/providers/base.py                         【修改】能力声明和统一思考映射契约
backend/agent/providers/*.py                            【修改】各 Provider 的格式/模型/档位能力声明
backend/agent/loop_drivers.py                           【修改】公共 Chat/Anthropic 请求构造使用能力结果
backend/agent/providers/openai_responses.py             【修改】Responses 请求使用同一能力结果
backend/app/byok/schemas.py                             【修改】校验 Provider 声明支持的配置值
backend/app/byok/service.py                             【修改】提供配置能力快照与运行时配置过滤
backend/app/api/v1/byok.py                              【条件】复用或补齐能力快照 API
backend/app/api/v1/agent_admin.py                       【条件】复用或补齐 Admin 能力数据
frontend/src/components/common/profile/ProfileByokPane.vue 【修改】通用模式隐藏思考设置，具体 Provider 按能力展示
frontend/src/views/Admin/Agent/**                       【条件】Admin 模型配置按同一能力声明展示
backend/tests/test_providers.py                        【修改】Provider 能力及模型矩阵回归
backend/tests/test_byok*.py                             【条件】配置校验、旧配置兼容和运行时过滤回归
backend/tests/test_loop_drivers*.py                     【条件】三种协议参数结构回归
frontend/tests/agent-configuration/                     【条件】配置选项切换和失效值回归
```

公共协议驱动只负责协议请求格式；供应商模块负责能力和映射；BYOK/Admin 只消费能力快照。文件树中的条件文件仅在现有测试/API没有可复用入口时新增或修改。不得顺手重构无关 Provider 特性、媒体协议、ASR 或 Agent Loop 生命周期。

## 4. 验证与上线

- 为 OpenAI Chat、OpenAI Responses、Anthropic Messages 分别验证：默认不带思考字段；显式选择时字段位置和档位映射正确。
- 为至少两个存在模型差异的 Provider 验证：切换模型后选项同步变化；未知模型和不支持组合不发送思考参数。
- 验证通用 OpenAI/Anthropic 兼容模式在新建、编辑、保存、运行时均不发送思考参数，包括数据库中仍有旧 `thinking` / `reasoning_effort` 值的情况。
- 验证 Provider 切换时 API 格式、默认 URL、模型选项和旧思考值处理一致；不覆盖用户明确填写的自定义 URL。
- 验证 BYOK 与 Admin 能力选项来源一致，旧配置读取不崩溃，API Key 和正文不进入可见日志。
- 运行 Provider、BYOK、三协议请求构造、配置 UI 相关测试；执行完整后端/前端 CI 前，由实现任务确认目标命令和资源条件。
- 发布后关注模型请求错误率、配置测试失败率和 reasoning state invalidation；若出现兼容回归，恢复 Provider 默认 API/思考配置，并保留用户自定义 URL 与密钥。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| Provider 声明与供应商实际模型能力不一致 | 请求被拒绝，或思考行为与用户选择不同 | Provider 配置按模型规则声明；能力回归测试覆盖参数快照；未知模型默认不发送参数。 |
| 供应商对标准档位采用不同含义或映射 | 用户以为档位完全等价，实际推理预算有差异 | 明确记录映射；只展示可支持档位；文案不承诺跨供应商结果等价。 |
| 通用兼容模式遗留配置仍带旧思考字段 | UI 隐藏后运行时仍可能发送字段 | 在运行时配置解析处按通用模式过滤，并加旧字段回归测试。 |
| API 格式切换导致旧 Provider reasoning state 不兼容 | 请求续接失败或带入错误状态 | 将 API 格式和思考配置纳入 state fingerprint；变化后不续接旧状态。 |
| 能力快照重复维护在后端与前端 | 两处选项逐渐分叉 | 后端能力快照作为事实源，前端只渲染返回值。 |

**待确认事项**：具体 Provider/模型的首批能力矩阵以实现前核对的官方文档和实测为准；本 PRD 不预先宣称全部现有 Provider 均支持三种 API 或全部思考档位。

## 6. 唯一实施 TODO

### Phase 1：能力模型与协议边界

- [x] `LLM30-001` 定义 Provider/模型/API 格式能力快照；验收：可表达受支持格式、默认格式/URL、思考模式与档位映射，未知模型可明确返回默认能力。
- [x] `LLM30-002` 将三种公共协议的思考参数构造接入能力快照；验收：Chat、Responses、Anthropic 的默认请求不带思考字段，显式选项只按各自协议结构发送。

### Phase 2：配置界面与兼容行为

- [x] `LLM30-003` 改造 BYOK 与 Admin 配置选项；验收：通用兼容模式无思考档位选择，具体 Provider 只展示当前模型/API 支持项，格式选项来自后端能力快照。
- [x] `LLM30-004` 完成旧配置解析、运行时过滤与推理状态失效边界；验收：旧字段不会在通用模式误发，不兼容的 reasoning state 不会续接。

### Phase 3：回归与发布准备

- [ ] `LLM30-005` 补齐能力矩阵、三协议请求和前端配置回归；验收：覆盖默认省略、档位映射、模型切换、未知模型、旧配置和 Provider/API 切换，相关 CI 全绿。
- [ ] `LLM30-006` 完成首批 Provider 能力声明与文档核对；验收：每个启用深度选择的 Provider/模型规则有官方文档或实际接口证据，未核实的组合保持默认行为。

#### 已核实的首批 Provider（2026-09-29）

| Provider / 模型 | API 格式与默认端点 | 思考能力与映射 |
|---|---|---|
| 百炼（`qwen`） | Chat Completions；Qwen3.8、Qwen3.7、Qwen3.6、Qwen3.5、Qwen3-Max 另开放 Responses。Anthropic 格式取决于 Token Plan 等套餐，当前不作为通用能力声明。 | Qwen3 系列支持 Chat 思考开关；Qwen3.8 显式深度支持 `low`、`medium`、`xhigh`，`minimal→low`、`high/max→xhigh`、`none→关闭思考`。Responses 的 `reasoning.effort` 按模型映射；Qwen3.8 使用同一档位映射。 |
| 智谱（`glm`） | GLM-5.3 支持 Chat、Responses、Anthropic Messages，并按所选格式使用官方端点；其他模型只声明 Chat。Coding Plan 仅声明 Chat。 | GLM-5.3 思考不可关闭，Chat 档位为 `low/high/max`；未明确验证的协议不开放思考档位。 |
| DeepSeek | Chat、Responses、Anthropic Messages；Anthropic 默认地址为 `https://api.deepseek.com/anthropic`，其他格式为 `https://api.deepseek.com`。 | Chat 使用 `thinking` 与 `reasoning_effort`；Responses 使用 `reasoning.effort`；Anthropic 使用 `thinking` / `output_config.effort`，关闭时用 `reasoning.effort=none`。档位映射：`minimal→low`、`medium→high`、`xhigh→high`、`max→max`。未声明的模型（包括已停用的 `deepseek-chat` / `deepseek-reasoner` 名称）不发送深度参数。 |

参考官方文档：[百炼 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[百炼 Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM 思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)、[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、[DeepSeek Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)、[DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/api/create-response/)。
