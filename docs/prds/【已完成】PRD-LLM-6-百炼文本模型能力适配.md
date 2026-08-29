# PRD-LLM-6：百炼文本模型能力适配

> 状态：🟡 Phase 1-4 已完成，Batch 后置
> 创建：2026-08-12
> 最近更新：2026-08-24
> 所属层：LLM / Provider 适配层
> 关联模块：`backend/agent/providers.py`、`backend/agent/llm/llm_select.py`、`backend/agent/loop_drivers.py`、`backend/agent/memory/_llm.py`、`backend/app/api/v1/agent_admin.py`
> 背景参考：[百炼文本生成](https://help.aliyun.com/zh/model-studio/text-generation)、[百炼多轮对话](https://help.aliyun.com/zh/model-studio/multi-round-conversation)、[百炼文本生成模型](https://help.aliyun.com/zh/model-studio/text-generation-model/)、[百炼批量推理](https://help.aliyun.com/zh/model-studio/batch-inference)

> 本次指定的模型能力页：
> - [百炼模型文档 2862210](https://bailian.console.aliyun.com/cn-beijing?spm=5176.30204012.0.0.654458d7yWcVrm&tab=doc#/doc/?type=model&url=2862210)
> - [百炼模型文档 2862577](https://bailian.console.aliyun.com/cn-beijing?spm=5176.30204012.0.0.654458d7yWcVrm&tab=doc#/doc/?type=model&url=2862577)

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 现状摸底 | ✅ 已完成 | devserver 实际预设为 `Bailian / qwen3.6-flash`，已确认使用百炼 OpenAI 兼容接口，现有链路支持流式、多轮消息、Function Calling 和多轮工具循环。 |
| Provider 能力建模 | ✅ 已完成 | `QwenAdapter` 按 `qwen3*` 模型族开启思考、JSON Object/Schema 能力；并行工具保持保守关闭。 |
| Qwen 实时参数适配 | ✅ 已完成 | `disabled` 发送 `extra_body.enable_thinking=false`，自适应模式发送 `preserve_thinking=true`；后台探测和正式 OpenAI 请求复用同一参数构造。 |
| 结构化输出适配 | ✅ 已完成 | 统一支持 `json_object`，并兼容完整或裸 JSON Schema 输入；调用方仍需按任务关闭思考。 |
| 工具与多模态验证 | 🟡 部分完成 | devserver 已实测普通请求、流式、单工具、JSON Object/Schema；并行工具、图片/视频仍按模型能力后置验证。 |
| 百炼 Batch 独立服务 | 🔲 后置 | 不进入实时 AgentLoop，另建批量任务服务。 |

## 1. 背景与目标

### 现状

咕咕已经通过 OpenAI 兼容接口接入百炼模型。当前 devserver 的主要百炼预设为 `qwen3.6-flash`，实际链路已经支持：

- `messages` 历史传入的多轮对话；
- 流式响应和 usage 统计；
- OpenAI 兼容 `tools` / `tool_choice="auto"`；
- 工具结果回传和连续工具调用；
- 图片、视频能力配置及后台探测入口。

Qwen 专属参数现在由 `QwenAdapter` 统一处理；结构化输出也已提供通用 adapter 接口。百炼 Batch API 尚未接入，仍作为独立后续阶段。

### 目标

1. 让百炼 Qwen 模型在实时聊天中正确使用自身支持的思考开关。
2. 让需要稳定 JSON 的后台任务使用 provider 无关的结构化输出接口。
3. 验证并明确 Qwen 各模型的工具调用、多轮工具调用和多模态边界。
4. 为未来批量摘要、批量记忆整理等离线任务预留独立 Batch 服务，不污染实时对话链路。

### 非目标

- 不把百炼云端 Assistant/Workflow 会话替换现有本地会话机制。
- 不把 Batch API 混入 `OpenAIDriver.run_round()`。
- 不因单个 Qwen 模型支持某能力，就默认所有百炼模型都支持；能力必须按 provider/model 配置或实测结果判断。

## 2. 功能需求

### FR-LLM-6-1：Qwen 思考开关（✅ 已完成）

- `thinking=disabled` 时，Qwen 发送 `extra_body: {"enable_thinking": false}`。
- `thinking=adaptive` 时保留百炼默认行为，并发送 `preserve_thinking=true`，保证带 `reasoning_content` 的历史可以继续回放。
- 其它 provider 保持现有参数：DeepSeek/MiMo 继续使用现有 `thinking` / `reasoning_effort` 逻辑。
- 后台“测试连接”和正式聊天必须调用同一参数构造函数。
- 不向不支持该参数的 OpenAI 兼容模型盲目发送 `enable_thinking`。

### FR-LLM-6-2：结构化输出（✅ 已完成）

新增统一请求能力，至少支持：

```json
{"response_format": {"type": "json_object"}}
```

并为支持的模型提供严格 schema：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {"name": "memory_result", "schema": {}}
  }
}
```

首批迁移范围：

- 用户记忆反思；
- 群组/成员记忆整理；
- 记忆维护预览和确认任务；
- 后台模型能力测试。

普通聊天不默认开启结构化输出。解析失败时保留现有错误记录和重试边界，不用宽松 fallback 掩盖模型不兼容。

### FR-LLM-6-3：工具调用能力位（✅ 基础完成）

Provider 能力模型需要明确：

- 是否支持 Function Calling；
- 是否支持 `tool_choice="auto"`；
- 是否支持并行工具调用；
- 是否支持工具调用后继续思考和再次调用；
- 工具参数是否支持严格 JSON schema。

Qwen3 的基础工具调用能力已通过 devserver 真实请求确认；并行工具调用仍未确认，因此默认关闭。

### FR-LLM-6-4：多轮对话与思考内容回传（✅ 基础完成）

- 继续由咕咕本地维护 `messages`；
- Qwen 的 assistant 消息、工具调用消息和工具结果必须保持 OpenAI 兼容格式；
- 如果 Qwen 返回 reasoning 内容，按 OpenAI 兼容消息结构保留到下一轮；Qwen3 自适应模式通过 `preserve_thinking` 保持该字段语义；
- 不把 reasoning 内容展示给用户或写入普通回复正文。

### FR-LLM-6-5：百炼 Batch 独立服务（🔲 后置）

后续新增独立模块：

```text
backend/agent/batch/
  models.py
  provider.py
  bailian.py
  service.py
```

提供：

- JSONL 任务生成；
- 批量任务提交；
- 状态查询；
- 结果下载和解析；
- 失败、过期和取消处理。

首批使用场景为批量记忆整理、文件摘要和离线分析，不用于网页/IM 实时回复。

## 3. 技术方案

### 3.1 Provider 能力模型

在 `ProviderAdapter` 增加能力描述或方法：

```python
thinking_style: str
supports_json_object: bool
supports_json_schema: bool
supports_parallel_tools: bool
supports_vision: bool
supports_video: bool
```

参数构造统一由 adapter 提供，`loop_drivers.py` 只负责调用，不再按 provider 写分支。

### 3.2 实时请求参数

保留 OpenAI 兼容的 `messages`、`tools`、`stream` 和工具循环；只把 provider 专属参数放入 `extra_body` 或 `response_format`。

Qwen 示例：

```python
extra_body = {"enable_thinking": False}
```

结构化输出示例：

```python
response_format = {"type": "json_object"}
```

具体字段以当前百炼模型文档和真实测试结果为准。

### 3.3 日志与隐私

- 不记录 prompt 原文、工具参数原文或用户输入；
- 只记录 provider、model、能力开关、耗时、token 数和错误分类；
- 上游错误经过脱敏出口，原始响应仅进入受限诊断日志；
- 结构化输出测试使用虚构数据。

## 4. 验证与上线

### 4.1 单元测试

- Qwen `enable_thinking=false` 参数构造；
- adaptive 模式不发送错误参数；
- DeepSeek/MiMo 旧参数不回归；
- `json_object` / `json_schema` 能力判定；
- 不支持结构化输出的模型不发送该参数；
- 并行工具能力位判定；
- 工具参数截断和 JSON 解析失败处理。

### 4.2 devserver 真实验证矩阵

对当前百炼模型至少验证：

| 场景 | 验收点 |
|---|---|
| 普通单轮 | 正常流式返回 |
| 多轮对话 | 第二轮能引用第一轮上下文 |
| 思考关闭 | 不产生异常参数错误，响应延迟下降 |
| 单工具 | 能调用并消费工具结果 |
| 连续工具 | 工具结果后能继续调用或总结 |
| 并行工具 | 仅在能力确认后开启 |
| JSON Object | 返回可解析 JSON |
| JSON Schema | 接口接受 schema；业务任务仍需校验字段完整性 |
| 图片 | 正确理解图片内容 |
| 视频 | 仅在模型明确支持时测试 |

### 4.3 上线观察

- Qwen HTTP 400 参数错误；
- 工具调用 JSON 解析失败；
- `finish_reason` 异常或空回复；
- 结构化输出解析失败率；
- 思考关闭前后的输入/输出 token 和延迟；
- Batch 任务提交失败、超时和结果缺失。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 不同 Qwen 型号能力不一致 | 同一 provider 配置在不同模型上行为不同 | 能力按模型覆盖，并用真实请求验证 |
| `enable_thinking` 与通用 `thinking` 混用 | 可能返回 HTTP 400 | 由 adapter 统一构造，禁止调用点自行拼参数 |
| 结构化输出并非所有模型支持 | 后台任务解析失败 | 先做能力探测，失败时明确报错并保留原始诊断 |
| 并行工具调用兼容性不明 | 工具状态机收到异常调用结构 | 默认关闭，确认后按模型开启 |
| Batch API 与实时任务生命周期不同 | 任务状态、重试和结果关联复杂 | 独立服务和数据库任务表，后置实现 |

已确认/待确认：

- [x] 当前 devserver `qwen3.6-flash` 的 `enable_thinking=false`、JSON Object、基础工具调用和流式请求均返回成功。
- [x] 当前模型的 JSON Schema 请求被接口接受；业务侧仍需用完整 schema 做内容断言。
- [ ] 当前模型是否支持并行工具调用，以及流式分片的完整格式。
- [ ] 百炼 Batch 是否纳入咕咕首批离线任务，还是先保留 provider 接口。

真实验证记录：2026-08-24，使用 devserver `Bailian / qwen3.6-flash`，普通、JSON Object、JSON Schema、强制单工具和流式请求均返回 HTTP 200；JSON Schema 最小测试因 `max_tokens=16` 以 `length` 结束，不能代替业务 schema 完整性测试。
