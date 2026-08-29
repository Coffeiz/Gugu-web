# 工具调用校验与联网搜索可靠性 PRD

> 状态：Phase 1～5 已实现，待 PR 合并与生产环境验证
> 创建：2026-08-08
> 最近更新：2026-08-11
> 所属层：Agent / Tool Contract / 联网搜索
> 关联模块：`backend/agent/tools/base.py`、`backend/agent/loop_drivers.py`、`backend/agent/core.py`、`backend/agent/tools/search.py`、`backend/agent/skills/web-search.md`、`backend/app/core/config.py`
> 关联测试：`backend/tests/test_core_loop_characterization.py`、`backend/tests/test_tool_isolation.py`、待新增工具契约与 SearXNG 回归测试
> 背景参考：当前 `web_search` / `image_search` 走自建 SearXNG；本 PRD 同时解决工具输入“合法 JSON 但不符合 schema”与 SearXNG “空结果无法区分真空结果和引擎故障”两个可靠性缺口。

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 现状摸底 | ✅ 已完成 | 已确认当前有 JSON 语法解析、截断保护、ID 弱归一化、工具定义基础检查，但中央 `dispatch` 没有按 `input_schema` 做运行时实例校验。 |
| SearXNG 现状摸底 | ✅ 已完成 | 已确认 `web_search` 只读取 `data.results`，没有保留 `unresponsive_engines` 等引擎健康信息；空数组统一被解释为“没搜到结果”。 |
| Phase 1：工具 schema 运行时校验 | ✅ 已完成 | 唯一工具派发入口已增加 object 检查、现有 ID normalize、JSON Schema validate 和结构化错误回传；非法参数不会执行 handler。 |
| Phase 2：工具 schema 注册期完整检查 | ✅ 已完成 | 工具注册时校验 schema 并预编译 validator；dispatch 对直接注入 registry 的扩展保留延迟构建保护。 |
| Phase 3：SearXNG 状态可观测性 | ✅ 已完成 | 已区分 `ok / degraded / empty / unavailable`，并把引擎失败信息转成稳定、精简的 `search_status`。 |
| Phase 4：搜索 query 语义约束 | ✅ 已完成 | 已补强 `query` schema 描述与联网技能说明，并限制 `max_results` 为 1～20。 |
| Phase 5：回归验证 | ✅ 已完成 | 新增工具参数错误边界、SearXNG 空结果/部分故障/全故障和 query 说明测试；后端全量测试通过。 |

---

## 1. 背景与目标

### 1.1 问题 A：当前“会解析 JSON”不等于“参数符合工具 schema”

咕咕当前工具链已经有几层保护：

- OpenAI 兼容路径会把流式 `function.arguments` 拼接后执行 `json.loads()`；JSON 被截断或语法错误时标记 `parse_error`，核心循环不会拿空参数执行工具，而是把“参数不完整”反馈给模型重试。
- Anthropic 路径拿到 SDK 已解析的 tool input。
- `SkillRegistry.add()` 会检查工具名、重复注册、`input_schema` 顶层是否为 `{"type": "object"}`、handler 是否 callable。
- `dispatch()` 会对常见 ID 字段做弱归一化，例如 `"#91"` / `"91"` → `91`，用于兼容模型偶发把数据库整数 ID 输出成字符串的情况。

但中央派发入口目前**没有执行“实例是否符合这个工具的 `input_schema`”的运行时校验**。因此以下输入只要 JSON 语法合法，就可能继续进入 handler：

```json
{"status": "active"}
```

如果目标工具要求 `project_id`，这里只是缺 `required` 字段，但中央层不会统一拦截。

```json
{"project_id": 12, "status": "banana"}
```

即使 schema 对 `status` 声明了 `enum`，中央层也不会统一拒绝。

```json
[]
```

这同样是合法 JSON；OpenAI 路径的 `json.loads()` 可以成功，但它不是工具约定的 object。当前只能依赖后续 handler 自己报错，错误语义不稳定。

结果是：**JSON 语法正确性、工具参数契约正确性、业务 handler 正确性三层边界没有完全分开。** 对只读工具通常表现为“查不到 / 执行报错”，对 mutation 工具则是更高风险的可靠性缺口。

### 1.2 问题 B：SearXNG 的“真没结果”和“引擎没工作”被压成同一个结果

当前 `backend/agent/tools/search.py` 的 `web_search` 请求 SearXNG：

```text
q=<query>
format=json
engines=<settings.search.searxng_engines>
```

当前默认搜索引擎配置为：

```text
sogou,quark,360search
```

成功得到 HTTP 200 + JSON 后，代码只抽取：

```python
data.get("results")
```

如果 `results` 为空，就统一返回：

```text
没搜到结果；换个关键词，或改用 deep_research 深度研究兜底
```

问题在于 SearXNG 的响应还可能携带引擎不可用信息（例如超时、验证码、限流、暂停等）。当前这些诊断信息没有进入咕咕的工具结果，因此下面两种情况在 Agent 看来完全一样：

```text
情况 1：三个引擎都正常，只是关键词确实没有结果
→ results = []

情况 2：sogou CAPTCHA，quark timeout，360search 被暂停
→ results = [] + 引擎故障信息
```

最终都被解释成“没搜到”。这会误导模型继续改关键词，甚至让用户误以为互联网上没有相关资料，而真实问题可能是搜索基础设施当前不可用。

### 1.3 问题 C：`query` 的 schema 语义太弱

当前 `web_search` / `image_search` 对 `query` 的描述基本只有“搜索关键词”。模型因此可能把用户完整自然语言问题原样塞给传统搜索引擎，例如：

```text
请帮我查一下最近有没有关于 Anthropic 新模型以及它和 GPT-5.6 在 coding benchmark 上性能差异的相关新闻
```

而当前 SearXNG 主要依赖 Sogou / Quark / 360 这类传统搜索源时，更稳定的形式往往是：

```text
Anthropic 新模型 GPT-5.6 coding benchmark 2026
```

现有 `web-search.md` 已要求“空了先换个搜法或关键词”，但没有给模型明确的 query 构造契约，也没有告诉它“先判断搜索设施是否健康，再决定要不要换关键词”。

### 1.4 目标

本 PRD 的目标不是重写搜索系统，而是补齐两个通用可靠性边界：

1. **工具输入契约必须在 handler 之前得到统一验证**：语法错误、类型错误、required 缺失、enum 非法等都应在中央入口被识别，非法参数绝不执行工具。
2. **SearXNG 搜索结果必须带上基础设施健康语义**：Agent 能分清“真的没结果”“部分引擎坏了”“所有引擎不可用”。
3. **搜索 query 给出明确语义约束**：让模型优先传短、可检索的关键词组合，而不是整段复述用户问题。
4. **保持 Provider parity**：Anthropic / OpenAI 兼容路径最终都进入同一套本地校验，不依赖供应商是否替我们校验 tool schema。
5. **错误可修复**：schema 错误以结构化、简短的形式反馈给模型，让模型在现有 AgentLoop 轮次内自行修正并重试。

### 1.5 非目标

- **不引入激进 JSON repair**：缺引号、尾逗号、截断 JSON 等继续按当前策略“拒绝执行 → 告诉模型重试”，尤其 mutation 工具不允许猜测式修复参数。
- **不在本 PRD 更换 SearXNG / Tavily / 搜索引擎供应商**。
- **不让 `web_search` 在工具内部偷偷调用 `deep_research`**：跨工具兜底仍由 AgentLoop 决策，避免在 handler 内形成隐藏编排。
- **不全局强制 `additionalProperties: false`**：JSON Schema 默认允许额外字段；只有某个工具自己显式声明禁止额外字段时才拒绝。
- **不在本 PRD 扩大 HTTP 重试策略**：网络层 retry 是否统一另行评估，本次只解决“输入契约”和“搜索状态语义”。
- **不自动在后端改写用户 query**：query 语义优化优先通过 tool schema 描述 + skill 指令让模型自己生成，后端只负责执行和报告状态。

---

## 2. 功能需求

### FR-LLM-4-1：中央工具输入必须经过 JSON Schema 实例校验（🔲 待评估）

所有工具调用在进入 handler 前统一经过以下顺序：

```text
LLM tool call
   ↓
provider 侧解析 / OpenAI json.loads
   ↓
必须是 object
   ↓
现有轻量 normalize
"91" / "#91" → 91（仅现有 ID 兼容字段）
   ↓
JSON Schema instance validate
required / type / enum / minimum / maximum / ...
   ↓
失败：不执行 handler
   → 返回结构化 validation error 给模型
   → 模型在下一轮修正参数
   ↓
成功：进入现有 permission / confirm / handler / verify 流程
```

要求：

- 顶层 input 不是 `dict/object` 时直接拒绝，不进入 `_coerce_int_ids()` 后续 handler。
- 保留当前 ID 弱归一化行为，且在 schema 校验前执行，避免已有 `"91"` → `91` 兼容能力被新 validator 破坏。
- 除现有明确的 ID normalize 外，不新增“大范围自动类型转换”：例如 `"5"` 不应普遍自动变成整数 5，避免掩盖真实模型输出错误。
- 按工具自身 `input_schema` 校验 `required`、`type`、`enum`、数值边界、数组/对象嵌套结构等标准约束。
- schema 校验失败时**不得执行 handler**，不得产生 mutation、副作用、确认凭证或 mutation verify 状态。
- Anthropic / OpenAI 兼容两条 provider 路径行为一致，统一在本地 `dispatch` 边界执行，不信任上游一定完成 schema 校验。

建议新增独立的结构化错误形态：

```json
{
  "error": "tool_input_invalid",
  "tool": "update_project",
  "issues": [
    {"path": "project_id", "rule": "required", "message": "缺少必填字段 project_id"},
    {"path": "status", "rule": "enum", "message": "status 不在允许范围内"}
  ]
}
```

约束：

- 不把完整原始 args 回显进错误，避免日志/模型上下文重复携带可能敏感的数据。
- 单次最多返回少量 issue（建议 3～5 条），防止复杂嵌套 schema 报错把上下文刷满。
- `path` 只给字段路径，`message` 给期望约束，不回显非法实际值。

### FR-LLM-4-2：工具 schema 本身在注册期 fail-fast（🔲 待评估）

当前注册期只检查 `input_schema` 是 dict 且顶层 `type == "object"`。新增完整 schema 自检：

- 工具注册时检查 schema 自身是否符合选定 JSON Schema Draft。
- schema 写错（例如 `required` 类型错误、非法 keyword 结构）时启动/测试阶段直接抛 `ToolContractError`，不允许带病运行。
- validator 建议在注册时创建/缓存，运行时直接复用，避免每次 tool call 重建 validator。
- `Tool.to_anthropic()` / `Tool.to_openai()` 继续使用同一份 `input_schema`，本地 validator 只是防御性校验，不维护第二份契约。

依赖方案建议：

- 显式增加 `jsonschema` 生产依赖（当前 `backend/requirements.txt` 未直接声明）。
- pin 到稳定的 4.x 范围；具体 Draft 在实现前统一跑现有全部工具 schema 的 `check_schema` 后确定。
- 建议优先使用现代 Draft（例如 Draft 2020-12）；若现有 provider schema 兼容性验证发现问题，可退到项目明确 pin 的 Draft，但全项目必须统一，不能不同工具各自猜。

### FR-LLM-4-3：语法错误与 schema 错误必须保持不同错误语义（🔲 待评估）

现有 OpenAI 路径对 JSON 截断/语法错误已有 `parse_error` 保护，应保留并与新 schema validation 分层：

```text
JSON parse error
→ “参数 JSON 不完整/语法错误”
→ 不执行

JSON parse success + schema invalid
→ “参数结构不符合工具契约”
→ 不执行

schema valid + handler business error
→ 进入现有工具业务错误处理
```

不得把三类错误合并成一个“工具执行失败”。这样模型才能采取正确修复动作，也方便以后在 LoopScope / trajectory 里统计模型到底在哪一层失败。

### FR-LLM-4-4：`max_results` 等简单边界补进 schema（🔲 待评估）

`web_search` / `image_search` / `deep_research` 当前声明 `max_results` 为 integer，但没有数值边界。实现 schema validator 后，应顺手把明显的输入边界写入 schema，而不是继续留给 handler 猜：

```json
"max_results": {
  "type": "integer",
  "minimum": 1,
  "maximum": 20
}
```

`query` 至少继续要求 string + required；空白字符串仍由 handler `.strip()` 后返回“需要提供搜索关键词”，或实现前统一决定是否增加最小非空 normalize。不要为追求 schema 完整度一次性给所有工具加大量未经验证的限制。

### FR-LLM-4-5：SearXNG 工具必须返回可判读的搜索健康状态（🔲 待评估）

`web_search` 与 `image_search` 都应在解析 SearXNG JSON 时读取引擎故障信息，并转换为稳定的内部结构。例如：

```json
{
  "query": "SGLang founder interview",
  "results": [],
  "search_status": {
    "state": "unavailable",
    "requested_engines": ["sogou", "quark", "360search"],
    "failed_engines": [
      {"engine": "sogou", "reason": "captcha"},
      {"engine": "quark", "reason": "timeout"},
      {"engine": "360search", "reason": "suspended"}
    ],
    "working_engine_count": 0,
    "result_count": 0
  }
}
```

`state` 统一为以下四类：

| state | 条件 | Agent 应理解为 |
|---|---|---|
| `ok` | 有结果，且无已知引擎故障 | 搜索基础设施正常，结果可直接使用 |
| `degraded` | 存在部分引擎故障；可能仍有结果，也可能暂时为 0 | 搜索覆盖下降，空结果不能等价于“网上没有” |
| `empty` | 0 结果，且没有已知引擎故障 | 更像是真空结果或 query 质量问题，可改关键词再搜一次 |
| `unavailable` | 已配置/请求的引擎全部不可用 | 搜索设施不可用，不应继续把换关键词当首选动作，应改用 `deep_research` 或告知当前搜索不可用 |

要求：

- `requested_engines` 从实际配置解析，不硬编码三个引擎名，兼容后台后续调整。
- 对 SearXNG 的 `unresponsive_engines` 等上游字段做容错解析；字段缺失时按“未知/未报告故障”处理，不能因为字段版本变化把整个搜索打挂。
- `failed_engines.reason` 使用内部归一化分类（如 `timeout / captcha / rate_limited / suspended / unavailable / unknown`），不要把上游大段原始异常直接塞给模型。
- 可在受限诊断日志保留必要原始原因，但普通工具结果与常规日志只输出归一化后的状态。
- 结果非空但部分引擎故障时不能丢弃已有结果；返回结果 + `state=degraded` 即可。

### FR-LLM-4-6：空结果文案必须区分“没搜到”和“没法搜”（🔲 待评估）

替换当前一刀切的空结果说明。

真实健康空结果：

```text
当前可用搜索引擎没有返回结果；可以换一组更短/更宽的关键词再搜一次。
```

部分故障 + 0 结果：

```text
本次没有返回结果，但部分搜索引擎不可用，不能据此判断网上没有相关内容；可换关键词重试一次，或改用 deep_research。
```

全部故障：

```text
当前配置的 SearXNG 搜索引擎均不可用；这不代表没有相关结果。请改用 deep_research 兜底。
```

核心原则：**“内容不存在”和“观测手段失效”必须是两种不同事实。**

### FR-LLM-4-7：给 `query` 增加适合传统搜索源的语义契约（🔲 待评估）

更新 `web_search` / `image_search` 的 `input_schema.properties.query.description`，并同步 `backend/agent/skills/web-search.md`。

建议描述：

```text
搜索关键词。优先使用简短关键词组合，不要直接复制用户的完整问题或写成长句；
保留实体名、产品名、版本号、年份/日期和关键术语。
例如用户问“最近 Anthropic 发布了什么新模型”，可传“Anthropic 新模型 2026”。
```

skill 中明确搜索策略：

```text
1. 第一次：提炼实体 + 关键术语，做一次较宽的短关键词搜索。
2. state=empty：说明搜索设施健康但无结果，可换同义词/中英文/更宽关键词再搜一次。
3. state=degraded 且 results=[]：先意识到覆盖下降，最多做一次更宽查询；仍空则考虑 deep_research。
4. state=unavailable：不要重复换关键词轰炸同一个 SearXNG，直接走 deep_research 兜底。
5. 已有足够结果就停，不为凑数量反复搜。
```

不要求所有 query 都极短：精确文件名、报错文本、论文标题、产品完整型号等本身就是高价值检索词，应完整保留。

### FR-LLM-4-8：搜索诊断进入可观测性，但不新增原始 query 日志（🔲 待评估）

为以后判断“搜不到到底是模型 query 差还是引擎坏了”，搜索工具执行记录至少应能统计：

- `search_status.state`
- 请求引擎数量
- 失败引擎数量
- 归一化失败原因计数
- `result_count`
- query 长度（可选）

不因为这次需求额外把完整 query 原文写进新日志。若现有 tool trajectory 已按现有安全策略记录 args，则沿用现有出口；新增搜索健康指标本身不需要复制 query。

---

## 3. 技术方案

### 3.1 工具契约校验放在唯一 `dispatch` 边界

推荐把契约校验实现集中在 `backend/agent/tools/base.py` 或拆出轻量模块 `backend/agent/tool_contract.py`，但调用点必须只有一个：`SkillRegistry.dispatch()`。

推荐逻辑：

```python
async def dispatch(user_id, name, args):
    tool = self._tools.get(name)
    if not tool:
        ...

    if not isinstance(args, dict):
        return tool_input_invalid(...), None

    _coerce_int_ids(args)

    issues = validate_tool_input(tool, args)
    if issues:
        return tool_input_invalid(tool.name, issues), None

    # 后面继续走现有 permission / progress / db / handler / confirm / redact / traj
    ...
```

注意顺序：

1. **tool 是否存在**；
2. **input 是否 object**；
3. **现有 ID normalize**；
4. **schema validate**；
5. 再进入真正执行链路。

如果 IM permission / destructive confirm 的现有顺序与此有安全语义要求，实现时可以保留权限检查更早执行；但无论如何 **handler 之前必须完成 schema validation**，且 validation 失败不能触发副作用。

### 3.2 validator 在注册时构建

建议：

```text
Tool 注册
  ↓
check_schema(input_schema)
  ↓
构建 validator
  ↓
缓存到 Tool / Registry 内部
  ↓
每次 dispatch 只跑 validator.iter_errors(args)
```

收益：

- schema 本身写错时 fail-fast；
- 不需要每次调用重新分析 schema；
- 所有 provider 共用同一份本地契约。

实现前必须对当前全部已注册工具跑一次 schema inventory，确认现有 schema 能通过 `check_schema`。如果发现历史 schema 有错，先修 schema，再开启运行时 enforcement，不允许用 try/except 静默跳过 validator。

### 3.3 validation error 归一化

不要直接把 `jsonschema.ValidationError.message` 原样全量返回。建立小型 mapper：

```text
validator == required  → rule=required
validator == type      → rule=type
validator == enum      → rule=enum
validator == minimum   → rule=minimum
validator == maximum   → rule=maximum
其它                   → rule=<validator name / invalid>
```

字段路径使用 `absolute_path` 转成：

```text
project_id
items.0.name
target.folder_id
```

消息只描述约束，不拼接实际非法值。

### 3.4 SearXNG 响应统一转换

在 `search.py` 内增加共享 helper，供 `web_search` / `image_search` 共用：

```text
_parse_requested_engines(config_string)
_normalize_engine_failures(data)
_build_search_status(results, requested_engines, failures)
```

避免网页搜索和图片搜索分别复制一套状态判断。

工具结果建议统一：

```json
{
  "query": "...",
  "results": [...],
  "search_status": {
    "state": "ok",
    "requested_engines": [...],
    "failed_engines": [...],
    "working_engine_count": 3,
    "result_count": 5
  }
}
```

如果是 `unavailable`，可以额外带 `error`/`note` 明确要求模型走兜底；但仍建议保留 `search_status`，方便 Agent 和可观测性系统识别根因。

### 3.5 不做 backend query rewrite

不建议在 `_searxng_search()` 里做类似：

```python
query = query[:64]
query = remove_stop_words(query)
query = auto_extract_keywords(query)
```

原因：

- 搜索词本身是模型决策的一部分，后端静默改写会造成“模型以为搜 A，实际搜 B”的不可观测行为。
- 精确标题/报错/文件名可能因为清洗被破坏。
- 真正需要 query expansion 时，应在 AgentLoop 或未来独立 search planner 中显式发生，而不是藏在 HTTP adapter。

本阶段只增强工具契约描述和 skill 策略。

### 3.6 与现有 mutation verify 的关系

本 PRD 的 schema validation 是**执行前正确性**：

```text
参数合法吗？
```

现有 mutation 后的 read-back verify 是**执行后正确性**：

```text
副作用真的按预期发生了吗？
```

两者不能互相替代。最终链路应该是：

```text
parse
→ normalize
→ schema validate
→ permission/confirm
→ handler
→ mutation read-back verify
```

---

## 4. 验证与上线

### 4.1 Phase 1：工具 schema validation

建议新增 `backend/tests/test_tool_schema_validation.py`，至少覆盖：

- 非 object（`[]` / string / number）被拒绝，handler 未调用；
- 缺 required 字段被拒绝；
- 类型错误被拒绝；
- enum 非法被拒绝；
- `additionalProperties` 默认未声明时仍允许额外字段；
- 某工具显式 `additionalProperties: false` 时额外字段被拒绝；
- `"#91"` / `"91"` 经现有 ID normalize 后可以通过 integer schema；
- validation error 不回显实际非法值；
- mutation 工具 validation 失败时 handler 未调用、`did_mutate` 不应成立、不会进入 mutation verify；
- Anthropic / OpenAI NormalizedToolCall 最终走同一 dispatch validator。

注册期新增覆盖：

- 非法 JSON Schema 注册时抛 `ToolContractError`；
- 合法 schema 能完成注册；
- validator 可复用，不改变 `to_openai()` / `to_anthropic()` 输出。

上线前：

1. 跑全量 pytest；
2. 单独枚举所有已注册 Tool 执行 `check_schema`；
3. 对常用 mutation 工具做一轮正常参数回归，确认 schema 没有比 handler 实际能力更窄。

风险等级：**中**。这是中央工具入口行为变化，一旦历史 schema 写错会扩大影响面，所以必须先做 schema inventory。

回滚方式：回滚 validator 接入提交即可；不要留下“validation 失败就偷偷放行”的长期开关，否则契约会再次变得不可信。

### 4.2 Phase 2：SearXNG 状态语义

建议新增 `backend/tests/test_searxng_search_status.py`，mock SearXNG JSON：

1. 有结果 + 无失败 → `ok`；
2. 有结果 + 一个引擎失败 → `degraded`，仍保留结果；
3. 无结果 + 无失败 → `empty`；
4. 无结果 + 部分失败 → `degraded`，note 明确“不代表没有”；
5. 无结果 + 全部失败 → `unavailable`，提示 `deep_research`；
6. `unresponsive_engines` 缺失/格式异常 → 不抛异常，降级成可解释状态；
7. `image_search` 复用同一状态 helper；
8. 后台修改 `searxng_engines` 后 `requested_engines` 随配置变化，不硬编码三引擎。

风险等级：**低到中**。主要是工具返回结构增加字段；现有模型消费 dict，对新增字段通常兼容，但要确认没有测试/代码做严格等值比较。

回滚方式：回滚 `search_status` helper 与返回结构修改。

### 4.3 Phase 3：query 契约与实际观测

更新 schema 描述 + `web-search.md` 后，做一组固定场景对照：

```text
用户自然语言问题
→ 模型实际 tool query
→ SearXNG state
→ result_count
→ 是否发生二次改词
→ 是否错误地把 unavailable 当 empty
```

至少覆盖：

- 中文新闻事实；
- 英文技术项目 / GitHub / 文档；
- 带版本号/年份的查询；
- 精确错误文本；
- 冷门实体；
- 人为模拟全引擎不可用。

上线后一段时间重点统计：

- `web_search` 的 `state=empty` 比例；
- `state=degraded` / `unavailable` 比例；
- 各引擎 `timeout/captcha/rate_limited/suspended` 计数；
- `empty → 第二次改词 → 有结果` 的恢复率（若 trajectory 能关联同一轮）；
- `unavailable → deep_research` 的兜底成功率。

这些数据能第一次真正回答“咕咕为什么经常搜不到”：是 query 质量、搜索覆盖，还是引擎本身不健康。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 历史工具 schema 比 handler 实际能力更窄/写错 | 新 validator 上线后原本能跑的合法调用被拒绝 | Phase 1 前枚举全部工具 `check_schema` + 常用工具正常参数回归；先修 schema 再 enforcement |
| 大量 schema validation error 让模型反复重试 | 消耗 AgentLoop 轮次、最终无法完成任务 | 错误保持短、字段路径明确；继续受现有 MAX_ROUNDS 约束，不增加无限自动重试 |
| ID normalize 在 schema 前执行会“放宽” integer 输入 | 模型传字符串 ID 仍被接受 | 这是现有明确兼容策略，保留；只允许当前白名单 ID 字段做这种 coercion，不扩散到所有类型 |
| 新增 `jsonschema` 依赖 | 增加一个生产依赖与少量运行开销 | 注册期预编译 validator；依赖显式 pin，避免依赖隐式传递 |
| SearXNG 不同版本的故障字段格式变化 | 状态解析可能失真 | 容错解析；未知原因归类 `unknown`，不能因诊断字段异常让正常 results 丢失 |
| 把上游异常原文返回给模型 | 上下文污染、可能包含不必要信息 | 只返回 engine + 归一化 reason；原始异常仅按现有受限诊断出口处理 |
| query 规则过度“关键词化” | 精确标题/错误文本等查询反而变差 | skill 明确例外：精确标题、错误文本、文件名、完整型号应完整保留；不做后端强制改写 |
| `state=degraded` 时模型过早切 Tavily | 增加配额消耗 | skill 规定：已有足够 results 就直接用；0 结果时最多换一次更宽 query，再决定兜底 |

待确认：

- 🔲 JSON Schema Draft 最终 pin 哪一版：建议先对全量现有 `input_schema` 跑 `check_schema`，优先现代 Draft；若 provider 工具描述兼容性有问题再调整。
- 🔲 `tool_input_invalid` 的结构化结果是否统一由 `base.py` helper 生成，还是单独放 `tool_contract.py`；倾向后者仅在逻辑增长明显时拆，避免为一个 validator 提前造新层。
- 🔲 `unresponsive_engines` 的失败原因映射表需要根据当前线上 SearXNG 实际返回样本补齐；未知值必须有 `unknown` 兜底。
- 🔲 是否给搜索健康状态增加后台面板可视化。本 PRD 只要求工具结果 + 可统计日志，不要求 UI。
- ✅ 不做 JSON 自动修复：对有副作用工具，严格 parse / validate / reject / retry 比猜测修复更安全。
- ✅ 不在 handler 内自动调用 `deep_research`：保持工具边界和 AgentLoop 决策可观测。
- ✅ 不全局注入 `additionalProperties: false`：是否禁止额外字段由各工具 schema 自己声明。

---

## 6. 预期完成后的行为

### 6.1 参数错时

现在可能是：

```text
LLM → 合法 JSON，但漏字段/类型错
→ handler 才报错，甚至出现难以理解的业务异常
```

目标：

```text
LLM → 合法 JSON，但 schema 不合法
→ 中央契约层拒绝执行
→ 告诉模型“哪个字段违反什么规则”
→ 模型修正
→ 再调用
```

### 6.2 SearXNG 空结果时

现在：

```text
results=[]
→ “没搜到结果”
```

目标：

```text
results=[] + engines healthy
→ “这次真的没搜到，换关键词”

results=[] + some engines failed
→ “覆盖下降，不能据此判断没有；换一次更宽关键词或兜底”

results=[] + all engines failed
→ “搜索设施不可用，不代表没有；直接 deep_research”
```

最终目标不是让每次搜索都一定有结果，而是让咕咕**知道自己为什么没得到结果，并把‘参数错、query 差、内容不存在、搜索设施故障’四件事分开处理**。
