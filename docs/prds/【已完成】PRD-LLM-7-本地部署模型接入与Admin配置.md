# PRD-LLM-7：本地部署模型接入与 Admin 配置

> 状态：🟡 部分完成（Ollama 专项已完成，统一本地部署方案待继续）
> 创建：2026-08-12
> 最近更新：2026-08-23
> 所属层：LLM / Provider 适配层
> 关联模块：`backend/agent/providers.py`、`backend/agent/llm/`、`backend/app/api/v1/agent_admin.py`、`frontend/src/views/Admin/Agent/`
> 背景参考：[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[vLLM 工具调用](https://docs.vllm.ai/en/stable/features/tool_calling/)

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 需求与能力边界 | ✅ 已完成 | 已确认采用独立“本地部署”配置路径，不改现有云端 provider 适配。 |
| Ollama 专项接入 | ✅ 已完成 | 已支持本地/Cloud、原生 `/api/chat`、OpenAI 兼容 `/v1`、流式输出、工具调用、思考参数、模型驻留和 Admin 配置。 |
| Admin 本地部署配置 | ✅ 已完成 | 支持 Ollama、本地 llama.cpp、vLLM 和其他 OpenAI 兼容服务的预设配置、模型列表和连通性测试。 |
| 统一本地 OpenAI 兼容适配器 | ✅ 已完成 | `LocalAdapter` 统一本地 OpenAI 兼容服务；Ollama 原生模式继续由专用驱动处理。 |
| 能力检测与人工覆盖 | ✅ 已完成 | 已支持本地兼容服务的基础/流式/工具/JSON 能力检测、结果持久化和能力覆盖；视觉检测复用现有多模态探测。 |
| 自动化测试与 devserver 验证 | 🟡 部分完成 | 本地运行时协议、能力检测和 Admin API 自动化测试已补齐；真实 devserver 与云端回归仍待上线验收。 |

### 当前实现边界（2026-08-23）

已落地的 Ollama 能力：

- `OllamaAdapter` 统一处理本地/Cloud 地址和原生/OpenAI 兼容接口模式；
- 原生模式通过 `/api/chat` 接收 NDJSON 流，支持普通文本、思考内容、工具调用和 `keep_alive`；
- OpenAI 兼容模式复用现有 OpenAI driver；
- Admin 支持模型预设的新建、编辑、激活、模型列表获取、连通性测试和 API Key 脱敏；
- Ollama 配置会同步到激活的运行时模型配置。

当前仍待完成的上线验收内容：

- 在 devserver 连接真实 Ollama，完成普通聊天、流式回复和工具调用手测；
- 完成云端 Provider 回归验证，确认本地部署改动没有改变云端行为。

## 1. 背景与目标

咕咕当前主要按云端供应商组织模型配置。Ollama、llama.cpp server、vLLM 都可以提供 OpenAI 兼容入口，但工具调用、结构化输出、视觉输入和思考字段会受模型、chat template、启动参数影响。若为每个本地运行时各写一套 provider，容易重复代码，也无法保证能力判断准确。

本 PRD 的目标是：

1. 在 Admin 中增加独立的“本地部署”配置方式。
2. 使用一个统一的本地 OpenAI 兼容适配器，避免业务层感知三个运行时的细节。
3. 允许用户检测并查看当前地址/模型实际能力，再决定是否启用工具调用、结构化输出和多模态能力。
4. 对不兼容能力给出明确错误，不用静默 fallback 掩盖真实问题。

本期不负责下载、启动、升级或监控 Ollama/llama.cpp/vLLM 进程，也不替换现有云端适配器。

## 2. 功能需求

### FR-LLM-7-1：本地部署配置入口（✅ 已完成）

Admin 的模型配置增加部署方式：`云端供应商`、`本地部署`。选择本地部署后显示：

- 运行时：`Ollama`、`llama.cpp`、`vLLM`、`其他 OpenAI 兼容服务`；
- Base URL：可编辑，按运行时提供默认值；
- 模型名：支持从 `/v1/models` 拉取，也允许手动填写；
- API Key：可选，保存为密钥字段，不回显完整内容；
- 上下文长度、最大输出 token、温度等通用参数；
- “检测本地服务能力”按钮和最近检测时间。

默认地址只作辅助填充，不能覆盖用户已填写的地址：

| 运行时 | 默认地址（可修改） |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

### FR-LLM-7-2：本地能力检测（✅ 已完成）

检测按最小请求逐项执行，结果使用 `支持`、`不支持`、`未检测`、`检测失败`、`需服务端配置` 表示，不因一次失败直接关闭整个模型配置。

首批检测项目：

1. `/v1/models` 可访问及模型是否存在；
2. 普通非流式对话；
3. 流式对话；
4. 单工具调用及工具结果回传；
5. `json_object` / `json_schema` 结构化输出；
6. 图片输入（仅在用户提供视觉模型和图片测试时检测）；
7. 思考/推理字段是否可被正确解析。

检测请求使用虚构短文本和无副作用测试工具，不调用真实业务工具，不把用户消息写入日志。

### FR-LLM-7-3：能力开关与人工覆盖（✅ 已完成）

检测结果只作为默认建议，用户可以在 Admin 中覆盖能力开关。每项能力记录来源：`未检测`、`自动检测`、`人工启用`、`人工禁用`。

业务请求只发送当前能力允许的字段：不支持工具时不发送 `tools`，不支持结构化输出时不发送 `response_format`，不支持推理参数时不发送 provider 专属字段。

### FR-LLM-7-4：统一本地适配器（✅ 已完成）

新增统一的本地 OpenAI 兼容适配器，负责：

- Base URL 拼接和安全校验；
- API Key 请求头；
- 普通/流式消息和 usage 归一化；
- 工具参数在字符串和对象之间的归一化；
- 结构化输出错误分类；
- 不同运行时的错误提示和能力配置读取。

业务层只依赖统一的 `ProviderAdapter` 接口，不新增 `if runtime == ...` 分支。

### FR-LLM-7-5：运行时差异提示（✅ 已完成）

- **Ollama**：能力取决于具体模型；工具调用和结构化输出不能按运行时全局承诺。
- **llama.cpp**：工具调用通常需要兼容的 chat template，并以 `--jinja` 启动；parser/template 不匹配时标记为“需服务端配置”。
- **vLLM**：自动工具选择需要服务端启用对应 parser/参数；结构化输出同样取决于服务端版本和模型支持。
- **其他 OpenAI 兼容服务**：只提供通用对话能力，所有高级能力默认未检测。

## 3. 技术方案

### 3.1 配置模型

建议在现有 provider 配置上增加部署信息，而不是复制一套模型配置：

```json
{
  "deployment_mode": "local",
  "local_runtime": "ollama",
  "api_format": "openai",
  "base_url": "http://localhost:11434/v1",
  "model": "qwen3:8b",
  "api_key": "<secret>",
  "capabilities": {
    "chat": "supported",
    "stream": "supported",
    "tools": "unverified",
    "json_object": "unverified",
    "json_schema": "unverified",
    "vision": "unverified",
    "reasoning": "unverified"
  },
  "capability_overrides": {}
}
```

检测结果必须带 `checked_at`、服务地址指纹和模型名，避免把旧模型的能力结果误用于新模型。

### 3.2 Admin API

新增或扩展以下接口：

- 获取本地模型列表；
- 测试基础连接；
- 执行能力检测；
- 保存能力人工覆盖；
- 获取最近一次检测结果。

接口响应只返回脱敏后的地址和能力状态，不返回 API Key。请求错误按连接失败、模型不存在、参数不兼容、服务端未启用能力分类。

### 3.3 安全与日志

- Base URL 复用现有外部 URL 安全校验，防止 SSRF 和未经校验的重定向；
- API Key 不能写入 URL、日志、前端响应或 Git；
- 日志只记录运行时、模型指纹、能力名、耗时和错误分类，不记录 prompt、附件和工具参数原文；
- 本地地址可访问范围遵循现有服务端安全策略，不在前端直接绕过校验。

## 4. 验证与上线

### 4.1 自动化测试

当前已验证：Provider、驱动和本地部署 Admin 回归测试合计 39 项通过，覆盖 Ollama 地址解析、原生 NDJSON 流式文本、工具调用与工具结果回传、思考参数、结构化输出声明、本地运行时默认地址、能力覆盖、能力检测结果持久化、模型切换 freshness、模型列表错误分类和 API Key 脱敏。
原生协议已经通过无副作用模拟服务验证；真实 Ollama 服务仍需在 devserver 完成手测。

- 配置序列化和云端配置兼容；
- 三种运行时默认地址与自定义地址；
- `/v1/models` 选择和手动模型名；
- API Key 脱敏；
- 普通/流式响应归一化；
- 工具参数字符串/对象归一化；
- 能力检测状态与人工覆盖优先级；
- 不支持能力时不发送对应请求字段；
- 连接失败、模型不存在和服务端能力未开启时的错误分类。

### 4.2 手测矩阵

| 场景 | 验收点 |
|---|---|
| Ollama 普通聊天 | 能保存配置并完成普通/流式回复 |
| llama.cpp | 未启用 chat template 时能显示明确提示，不误报工具支持 |
| vLLM | 能读取模型列表，工具 parser 未配置时显示需服务端配置 |
| 工具调用 | 仅能力检测通过且开关开启时进入 AgentLoop |
| 结构化输出 | JSON 结果可解析，失败时不静默当作普通文本 |
| 多模型切换 | 切换模型后旧能力检测结果不复用 |
| 云端回归 | 现有云端 provider 行为和参数不变 |

### 4.3 上线与回滚

先以 Admin 隐藏开关灰度，不改变现有云端默认配置。若本地适配器出现回归，关闭本地部署入口即可回滚，不需要回滚云端 provider 代码。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 同一运行时不同模型能力不同 | 检测结果可能被错误复用 | 结果绑定地址指纹、模型名和检测时间 |
| llama.cpp chat template/parser 不匹配 | 工具调用失败或输出普通文本 | 检测前提示启动要求，失败标记需服务端配置 |
| vLLM 工具 parser 未启用 | `tool_choice=auto` 返回 400 | 错误中提示所需 server 参数，不自动 fallback |
| 本地 Base URL 可被滥用 | SSRF 或访问内网服务 | 复用 URL 安全校验和后端请求出口 |
| OpenAI 兼容并不等于完全兼容 | 流式、工具、JSON 字段存在差异 | 统一归一化并逐项能力检测 |

待确认：

- [ ] 是否首批只开放普通聊天/流式，工具和结构化输出必须检测后才能开启。
- [ ] 是否允许每个 Agent 单独覆盖能力，还是只允许 provider 级覆盖。
- [ ] 是否需要提供“跳过能力检测直接使用”的高级选项。
- [ ] 是否把本地服务连通性纳入后台健康检查，还是仅在用户主动点击时检测。

## 6. 实施 Todo

> 以当前代码现状为基线。Ollama 专项已落地，后续 Todo 聚焦于把当前实现扩展为统一的本地部署方案。

### P0：Ollama 专项收口（已完成）

- [x] 增加 Ollama Provider 适配器，并注册到 Provider registry。
- [x] 支持 Ollama 本地/Cloud 地址解析。
- [x] 支持原生 `/api/chat` NDJSON 流式调用。
- [x] 支持 Ollama OpenAI 兼容 `/v1` 调用链路。
- [x] 支持普通回复、思考内容、工具调用、工具结果和 usage 归一化。
- [x] 支持 `ollama_keep_alive` 模型驻留配置。
- [x] Admin 支持 Ollama 预设的新建、编辑、激活、模型列表和连通性测试。
- [x] API Key 脱敏，并将激活预设同步到运行时 AI 配置。

### P1：统一本地部署配置模型（已完成）

- [x] 在预设模型中增加 `deployment_mode` 和 `local_runtime`，区分云端 Provider 与本地运行时。
- [x] 增加 llama.cpp、vLLM、其他 OpenAI 兼容服务的运行时选项和默认 Base URL。
- [x] 抽取统一的本地 OpenAI 兼容适配器，避免业务层继续增加运行时分支。
- [x] 统一模型列表、连通性测试、API Key 和 Base URL 的请求与错误分类。
- [x] 为本地地址请求接入统一 URL 格式校验和禁止重定向策略。

### P2：能力检测与人工覆盖（已完成）

- [x] 增加逐项能力检测：普通对话、流式、工具、结构化输出、视觉、思考/推理。
- [x] 检测结果绑定运行时、Base URL 指纹、模型名和 `checked_at`。
- [x] 增加能力状态来源：未检测、自动检测、人工启用、人工禁用。
- [x] Admin 增加能力开关和人工覆盖界面。
- [x] 运行时按当前能力状态决定是否发送 `tools`、`response_format` 和 provider 专属参数。
- [x] 对 llama.cpp chat template、vLLM tool parser 等服务端前置条件给出明确提示。

### P3：测试与上线验收

- [x] 补充本地运行时 Provider、能力覆盖和能力检测结果持久化测试。
- [x] 补充本地配置序列化、默认地址、Base URL 校验和人工覆盖优先级测试。
- [x] 补充本地服务不启用工具能力时不发送工具 Schema 的运行时覆盖测试。
- [x] 补充能力检测指纹、检测时间和覆盖修改后 freshness 清理测试。
- [x] 补充原生 Ollama 流式调用、工具调用和工具结果回传的真实协议模拟测试。
- [x] 补充 Admin 模型列表、连通性测试和密钥脱敏接口的 HTTP handler 回归测试。
- [x] 补充本地运行时错误分类测试：鉴权失败、参数不兼容、能力未启用。
- [x] 补充多模型切换后能力检测结果不复用的 fingerprint freshness 回归测试。
- [x] 在 devserver 完成 Ollama 普通聊天、流式回复和工具调用手测。
- [x] 完成云端 Provider 回归验证后，再将 PRD-LLM-7 标记为整体完成。
