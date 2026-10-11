# Provider 思考深度与 API 格式能力配置

> 状态：Phase 1/2/3 实施完成；Provider 官方能力资料核验仍按 TODO-006 跟进
> 创建：2026-09-29
> 最近更新：2026-10-08
> 关联模块：`backend/agent/providers/`、`backend/agent/loop_drivers.py`、`backend/agent/providers/openai_responses.py`、`backend/app/byok/`、`frontend/src/components/common/profile/ProfileByokPane.vue`、`backend/app/api/v1/agent_admin.py`
> 背景参考：`docs/prds/【已完成】PRD-LLM-3-provider供应商适配层整体整理.md`、`docs/prds/【已完成】PRD-LLM-23-跨Provider推理状态持久化与续接.md`

## 0. 实际状态

| 能力 | 结果 | 状态 | 说明 |
|---|---|---|---|
| API 格式选择 | 后端能力快照同时提供 Provider 声明格式、可选格式、默认值和默认 URL | ✅ 已完成 | BYOK 与 Admin 按快照展示；`local` 和 Ollama 的可选协议由用户显式选择，不代表端点已验证支持。 |
| 思考参数映射 | 已有少量供应商专属参数构造 | 🟡 部分完成 | Phase 1/2 按能力快照发送或过滤参数；完整 Provider/模型矩阵仍待 Phase 3 核实。 |
| 模型级思考档位 | BYOK 与 Admin 按后端能力快照渲染 | ✅ | 未知模型和协议只保留默认选项；已知模型按 Provider、模型、API 格式显示档位。 |
| 通用兼容模式思考设置 | 通用端点不继承官方 Provider/模型的深度档位；默认沿用端点行为 | ✅ 已完成 | 通用模式提供跟随默认、开启、关闭三态；协议映射与前后端选项已接入。 |

## 1. 背景与目标

### 1.1 背景

BYOK 当前将供应商、API 格式和思考参数能力部分耦合在前端白名单与 Provider Adapter 方法中。不同供应商及同一供应商的不同模型支持的思考开关、档位和 API 格式并不相同；OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的参数字段也不同。

通用兼容端点通常无法从“OpenAI 兼容”或“Anthropic 兼容”判断具体模型能力。默认应省略相关参数，让服务端使用模型默认值；用户明确选择开/关后，才发送该 API 格式的通用协议映射。选定具体供应商后，应用依据其模型能力配置展示和发送已知支持的选项。

### 1.2 目标

1. 将三种公共 API 协议请求实现与供应商能力配置分开，避免每个供应商重复实现请求循环。
2. 由 Provider 配置声明支持的 API 格式、默认 API 格式、默认 URL，以及按模型确定的思考模式和档位。
3. 通用兼容模式提供思考开/关，不提供深度档位；未明确选择时沿用端点默认行为。
4. 具体供应商模式按所选模型和 API 格式显示支持的思考选项，并由公共 API 协议实现写入对应字段。
5. 具体 Provider 未声明支持或模型能力未知时，安全地省略思考深度参数；通用兼容模式只按 API 格式的通用思考开/关映射发送显式选择，不通过猜测 Provider 能力或失败后重试改变模型行为。
6. 不改变现有推理状态持久化语义；影响推理状态的模型/API/思考配置变化继续使不匹配的状态不可续接。

### 1.3 非目标

- 不为通用 OpenAI/Anthropic 兼容端点探测或推断思考能力。
- 不保证不同供应商、模型或 API 格式具有相同的思考档位或等价语义。
- 不新增逐请求自动重试以移除不支持的参数。
- 不重写 Agent Loop、canonical history、工具循环或推理状态存储。
- 不改造语音识别、Embedding、原生 Ollama 等非三种公共文本 API 协议的独立调用路径。
- 不记录或展示模型内部思考内容。

## 2. 功能需求

### FR-LLM30-01：通用兼容模式支持思考开/关并默认跟随服务端

当用户选择通用 OpenAI 兼容或 Anthropic 兼容配置，而未选择具体供应商能力配置时，界面提供简单的思考开/关，不展示 Provider/模型专属深度档位。默认状态为“跟随端点默认”，不发送思考控制字段；用户显式开启或关闭后，按所选 API 格式使用通用协议映射，不借用任何官方 Provider/模型的专属映射或档位。

通用开关的协议映射由公共协议层统一实现：Chat Completions 开启发送 `reasoning_effort=high`、关闭发送 `reasoning_effort=none`；Responses 开启发送 `reasoning.effort=medium`、关闭发送 `reasoning.effort=none`；Anthropic Messages 分别发送 `thinking.type=adaptive` 与 `thinking.type=disabled`。不附加 Provider 专属深度档位。若某 API 格式无法表达通用开关，则该格式不显示开关并保持端点默认。自定义端点或模型可能不接受可选思考字段，显式开启/关闭被拒绝时向用户展示经脱敏的错误，不自动移除字段重放请求。

通用模式仍须选择其调用所需的 API 格式和连接信息。兼容格式只说明请求协议，不代表目标模型支持该协议中的所有可选能力。

### FR-LLM30-02：Provider 声明 API 格式能力与默认值

每个具体 Provider 可按模型声明：

- 支持的公共 API 格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 中的一个或多个；
- 默认 API 格式和默认 URL；
- 是否支持各思考模式，以及每个模型和 API 格式支持的档位；
- 标准化档位到协议字段/供应商字段的映射，以及不支持项的省略规则。

BYOK 与 Admin 模型配置使用同一份能力声明。界面仅展示所选 Provider 和模型声明支持的 API 格式；不支持的格式不可选。切换 Provider 时采用新 Provider 声明的默认 URL 与默认 API 格式；用户仍可编辑 URL。

`local` 和 Ollama 是用户选择模型/服务端的接入类型，其格式选择不应被模型名白名单限制：

- `local` 提供 Chat Completions、Responses、Anthropic Messages 三种协议供用户选择；选项表示“尝试按此协议请求用户配置的端点”，不是系统探测或保证端点支持。
- Ollama 提供 Ollama 原生 API、Chat Completions、Responses、Anthropic Messages 供用户选择。原生 API 与三种公共协议是不同传输方式；Ollama 官方兼容接口也只承诺各协议子集，具体能力受 Ollama 版本、本地/云端端点和模型影响。
- 新建配置保留合理默认值（`local` 默认 Chat Completions，Ollama 默认原生 API），但用户显式选择后不得因模型名变化或静态目录过滤而被重置。请求失败时展示实际协议错误，不静默换协议或重放。
- 后端能力快照应区分“Provider 已核实支持”与“用户可选择/声明的协议”；不能把 `local` / Ollama 的可选项伪装成逐模型验证结果。

### FR-LLM30-03：思考选项按配置类型、Provider、模型和 API 格式过滤

选择具体 Provider 后，系统根据当前模型与 API 格式展示该组合明确声明支持的思考选项。选择通用兼容模式时，只展示 FR-LLM30-01 规定的思考开/关，不展示深度档位。具体 Provider 的选项至少区分：

- 跟随模型默认：不发送思考控制参数；
- 显式关闭或开启：仅在该模型/格式支持时显示；
- 思考深度：只展示此组合支持的档位。

切换模型或 API 格式后，旧选择若不再受支持，界面必须将其标记为无效并要求用户选择有效选项或恢复默认；运行时不得发送无效的历史配置。具体 Provider 模型能力未知时，只提供默认行为；通用兼容模式仍可按协议能力显式开关，但不得提供档位。

### FR-LLM30-04：公共协议层构造思考参数

公共协议层按所选 API 格式负责参数结构：

| API 格式 | 思考深度参数位置 |
|---|---|
| OpenAI Chat Completions | `reasoning_effort` |
| OpenAI Responses | `reasoning.effort` |
| Anthropic Messages | `output_config.effort`，以及该模型/Provider 要求的 thinking 模式 |

Provider 配置提供能力声明和必要映射，不复制公共协议请求循环。具体 Provider 只有在配置显式选择了非默认选项且当前组合声明支持时才构造参数；默认值一律省略参数。通用兼容模式仅在用户显式切换开/关且当前协议声明具备通用映射时构造开关参数，映射不得读取或推断具体 Provider 的模型档位。

### FR-LLM30-05：供应商能力未知或不支持时回到默认

对于具体云 Provider 的未知模型、未知 API/模型组合或未声明支持的思考档位，运行时不发送深度参数，使用端点默认行为。`local` / Ollama 的 API 格式是用户显式选择的端点协议声明；即使系统没有逐模型能力信息，也按用户选择的格式构造请求，不自动回退。通用兼容模式只有在用户显式操作思考开关时，才使用该协议定义的通用开关映射；不得把协议兼容声明当作服务端必然接受全部可选字段的保证，也不得在收到 400 后自动以默认参数重放同一请求。

连接测试只验证所选 API 的基本连通和鉴权，不宣称已经验证全部思考能力。错误诊断可指出当前组合未声明相关能力，但不得记录密钥、聊天正文或原始思考内容。

### FR-LLM30-06：新配置语义与存储边界

本功能不提供旧配置迁移或兼容转换。当前配置仅使用 `api_format`、`thinking` 和 `reasoning_effort` 表达新选择；通用模式的 `thinking` 仅允许默认、显式开启、显式关闭，深度值不参与请求。无效组合按当前能力规则过滤，不改写数据库中的历史行，也不新增迁移脚本。

## 3. 技术方案

### 3.1 职责边界

```text
BYOK / Admin 配置界面
  ├─ 通用兼容模式：格式与连接配置；默认跟随端点，允许显式思考开/关，不显示深度档位
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
- 具体 Provider 的协议格式选项与思考档位都以 Provider/模型能力快照为准。供应商未声明格式支持时不展示该格式；用户手填自定义 URL 不自动扩大声明能力。通用兼容模式的可选 API 格式及是否可用通用思考开关以协议能力声明为准。
- `api_format`、`thinking`、`reasoning_effort` 仍进入模型有效配置快照。配置变化不得续接使用旧模型/协议/思考设置创建的 Provider reasoning state。
- 通用兼容模式默认在前后端都省略思考参数；显式开关值按 FR-LLM30-01 转换，深度值不得泄漏为 Provider 专属档位。

#### 能力 API 的前后端职责

- `POST /byok/capabilities` 与 Admin 的 `capabilities-preview` 都由后端 Provider Adapter 生成无凭据、无网络探测的静态能力快照。快照中的 `supported_api_formats`、`default_api_format`、`default_base_url`、`reasoning_modes` 和 `reasoning_efforts` 是配置界面的能力事实源。
- 对逐模型维护能力矩阵的云 Provider，`supported_api_formats` 是后端已核实的声明；对 `local` / Ollama，快照还须提供可供用户选择的格式集合，并明确其为用户端点协议选择而非探测结果。Ollama 原生 API 以独立的 `ollama_api_mode` 表达，不冒充三种公共协议之一。
- 前端负责把快照呈现为选项、管理用户草稿和切换时的交互；不应再用 `modelProviders.ts` 的静态 `api_formats` 列表裁决模型可选协议。静态 Provider 清单可以保留展示名或新建配置的初始值，但不能覆盖具体模型/端点的后端能力结果。
- 保存时后端仍须独立校验 Provider、模型与 API 格式组合。前端隐藏了不支持的选项只是 UX，不构成服务端安全边界。
- 当前差异：BYOK 与 Admin 已请求后端快照并据此显示思考档位，但 API 格式选项和格式纠正仍调用前端静态清单；后端快照虽包含 `supported_api_formats`，界面尚未消费该字段。前端清单还将 `local` 限为 Chat、Ollama 限为原生/Chat，未提供 Responses 与 Anthropic 选择。因此既可能展示后端拒绝的格式，也可能漏掉后端/用户端点可用的格式。

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
frontend/src/components/common/profile/ProfileByokPane.vue 【修改】通用模式显示默认/开/关，具体 Provider 按能力展示
frontend/src/views/Admin/Agent/**                       【条件】Admin 模型配置按同一能力声明展示
backend/tests/test_providers.py                        【修改】Provider 能力及模型矩阵回归
backend/tests/agent/providers/test_providers.py         通用协议参数映射与能力快照回归
backend/tests/test_loop_drivers*.py                     【条件】三种协议参数结构回归
frontend/tests/agent-configuration/                     【条件】配置选项切换和失效值回归
```

公共协议驱动只负责协议请求格式；供应商模块负责能力和映射；BYOK/Admin 只消费能力快照。文件树中的条件文件仅在现有测试/API没有可复用入口时新增或修改。不得顺手重构无关 Provider 特性、媒体协议、ASR 或 Agent Loop 生命周期。

## 4. 验证与上线

- 为 OpenAI Chat、OpenAI Responses、Anthropic Messages 分别验证：默认不带思考字段；显式选择时字段位置和档位映射正确。
- 为至少两个存在模型差异的 Provider 验证：切换模型后选项同步变化；未知模型和不支持组合不发送思考参数。
- 验证通用 OpenAI/Anthropic 兼容模式新建时默认不发送思考参数，显式开/关在保存和运行时按协议映射生效；不为旧数据增加转换规则。
- 验证 Provider 切换时 API 格式、默认 URL、模型选项和当前思考选择处理一致；不覆盖用户明确填写的自定义 URL。
- 验证 BYOK 与 Admin 能力选项来源一致，API Key 和正文不进入可见日志。
- 运行 Provider、BYOK、三协议请求构造、配置 UI 相关测试；执行完整后端/前端 CI 前，由实现任务确认目标命令和资源条件。
- 发布后关注模型请求错误率、配置测试失败率和 reasoning state invalidation；若出现兼容回归，恢复 Provider 默认 API/思考配置，并保留用户自定义 URL 与密钥。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| Provider 声明与供应商实际模型能力不一致 | 请求被拒绝，或思考行为与用户选择不同 | Provider 配置按模型规则声明；能力回归测试覆盖参数快照；未知模型默认不发送参数。 |
| 供应商对标准档位采用不同含义或映射 | 用户以为档位完全等价，实际推理预算有差异 | 明确记录映射；只展示可支持档位；文案不承诺跨供应商结果等价。 |
| 通用兼容端点不接受思考开关字段 | 显式开/关请求被端点拒绝 | 默认仍不发送字段；只有用户显式操作时才发送通用协议映射；错误脱敏展示且不自动重放。 |
| API 格式切换导致旧 Provider reasoning state 不兼容 | 请求续接失败或带入错误状态 | 将 API 格式和思考配置纳入 state fingerprint；变化后不续接旧状态。 |
| 能力快照重复维护在后端与前端 | 两处选项逐渐分叉，或本地端点协议被错误过滤 | 后端返回已核实能力与用户可选协议的区分；前端只渲染快照，并对本地/用户自定义端点明确提示需与服务端实现一致。 |

**待确认事项**：具体 Provider/模型的首批能力矩阵以实现前核对的官方文档和实测为准；本 PRD 不预先宣称全部现有 Provider 均支持三种 API 或全部思考档位。

## 6. 唯一实施 TODO

### Phase 1：能力模型与协议边界

- [x] `LLM30-001` 定义 Provider/模型/API 格式能力快照；验收：可表达受支持格式、默认格式/URL、思考模式与档位映射，未知模型可明确返回默认能力。
- [x] `LLM30-002` 将三种公共协议的思考参数构造接入能力快照；验收：Chat、Responses、Anthropic 的默认请求不带思考字段，显式选项只按各自协议结构发送。

### Phase 2：配置界面与兼容行为

- [x] `LLM30-003` 改造 BYOK 与 Admin 的 Provider 思考选项；验收：具体 Provider 的思考选项按当前模型/API 能力快照过滤，未知组合回到默认。API 格式列表的能力源统一另列为 `LLM30-008`；通用兼容思考开关另列为 `LLM30-007`。
- [x] `LLM30-004` 完成当前配置组合过滤与推理状态失效边界；验收：当前不支持的思考选项不会进入请求，不兼容的 reasoning state 不会续接；不实施旧配置迁移或兼容转换。

### Phase 3：回归与发布准备

- [x] `LLM30-005` 补齐能力矩阵、三协议请求和前端配置回归；验收：覆盖默认省略、档位映射、模型切换、未知模型和 Provider/API 切换，相关 CI 全绿。相关 CI 已在之前版本通过（按用户确认）；本次变更需运行本地定向测试。
- [ ] `LLM30-006` 完成首批 Provider 能力声明与文档核对；验收：每个启用深度选择的 Provider/模型规则有官方文档或实际接口证据，未核实的组合保持默认行为。
- [x] `LLM30-007` 为通用兼容模式增加协议级思考开/关；验收：默认不发送思考字段，显式开/关仅使用协议通用映射、不继承 Provider 专属档位，端点拒绝时不自动重放；不做旧配置兼容转换。
- [x] `LLM30-008` 统一 API 格式能力事实源与用户自定义协议选择；验收：BYOK 与 Admin 使用后端快照的 `supported_api_formats`、默认格式和默认 URL，不再用前端静态 Provider 清单裁决具体 Provider 格式；`local` 可选择三种公共协议，Ollama 可选择原生 API 与三种公共协议；用户显式选择得到保留，保存与运行时不静默改写/回退。界面区分后端声明能力与用户可选协议，并提示本地端点未探测及兼容子集差异。

#### 已核实的首批 Provider（2026-09-29）

| Provider / 模型 | API 格式与默认端点 | 思考能力与映射 |
|---|---|---|
| 百炼（`qwen`） | OpenAI Chat Completions 与 Responses；Anthropic Messages 仅对官网列出的模型开放（包括 Qwen3.8/3.7/3.6/3.5 系列、qwen-plus/flash/turbo、Coder/VL 等；旧 `qwen-max` 不在该接口支持列表）。按量 Anthropic 需使用业务空间端点 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic`；OpenAI 兼容使用 `.../compatible-mode/v1`。切换协议时自动切换百炼默认端点，保留用户自定义端点。 | Qwen3 系列支持 Chat 思考开关；Qwen3.8 显式深度支持 `low`、`medium`、`xhigh`，`minimal→low`、`high/max→xhigh`、`none→关闭思考`。Responses 的 `reasoning.effort` 按模型映射；Anthropic Qwen3.8 使用 `thinking.type` 开关及 `output_config.effort`，`minimal→low`、`high/max→xhigh`。 |
| 智谱通用 API（`glm`） | 统一以 `glm-5.3` 为能力矩阵样例。官方提供 OpenAI Chat Completions（`https://open.bigmodel.cn/api/paas/v4`）、Responses（`https://open.bigmodel.cn/api/v1`）和 Anthropic Messages（`https://open.bigmodel.cn/api/anthropic`），三种格式均使用模型编码 `glm-5.3`。 | Responses 文档明确支持 `reasoning.effort`：默认 `max`；`none`/`minimal` 关闭思考，`low`/`medium` 映射为 `high`，`xhigh` 映射为 `max`。Chat 与 Anthropic 的 GLM-5.3 思考字段未由当前接入文档确认，保持端点默认，不展示档位。 |
| 智谱 Coding Plan（`glm-coding`） | 配置层与 GLM 共用三种 API 格式选项，并按协议使用 Chat Completions `https://open.bigmodel.cn/api/coding/paas/v4`、Responses `https://open.bigmodel.cn/api/v1`、Anthropic Messages `https://open.bigmodel.cn/api/anthropic`。Anthropic 的 Coding Plan 接入有官方 Claude Code 指南；官方页面未明确确认 Responses 端点使用 Coding Plan 额度，需用专属套餐 Key 实测后再标记已核实。切换协议时保留 Coding Plan 接入身份。 | 沿用 GLM 相同模型能力与思考规则；Coding Plan 端点不因此获得额外或不同的模型思考能力。 |
| DeepSeek | Chat、Responses、Anthropic Messages；Anthropic 默认地址为 `https://api.deepseek.com/anthropic`，其他格式为 `https://api.deepseek.com`。 | Chat 使用 `thinking` 与 `reasoning_effort`；Responses 使用 `reasoning.effort`；Anthropic 使用 `thinking` / `output_config.effort`，关闭时用 `reasoning.effort=none`。档位映射：`minimal→low`、`medium→high`、`xhigh→high`、`max→max`。未声明的模型（包括已停用的 `deepseek-chat` / `deepseek-reasoner` 名称）不发送深度参数。 |

参考官方文档：[百炼 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[百炼 Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)、[百炼 Anthropic Messages](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)、[百炼协议端点与套餐接入限制](https://help.aliyun.com/zh/model-studio/more-tools)、[GLM Coding Plan Claude Code 接入指南](https://docs.bigmodel.cn/cn/coding-plan/best-practice/claude-code)、[GLM OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[GLM Responses API 兼容](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)、[GLM Claude API 兼容](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)、[GLM 思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)、[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、[DeepSeek Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)、[DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/api/create-response/)、[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)、[Ollama Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)、[vLLM serving API](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)、[llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。
