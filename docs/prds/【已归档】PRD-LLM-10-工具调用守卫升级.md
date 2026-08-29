# PRD-LLM-10：工具调用意图与事实守卫升级

> 状态：规划中，尚未实施
> 创建：2026-08-24
> 最近更新：2026-08-24
> 所属层：Agent / Tool Contract / Reliability / Adapter Tool
> 关联模块：`backend/agent/core.py`、`backend/agent/security/core_guards.py`、`backend/agent/tools/meta.py`、`backend/agent/tools/base.py`、`backend/agent/loop_drivers.py`、`backend/agent/context/canonical_tool_history.py`

## 0. 核心结论

本 PRD 解决的不是“代码预判本轮是否需要工具”，而是校验模型已经表达的工具意图是否真的进入工具调用生命周期。

目标协议：

```text
模型准备使用工具
  ↓
文本先声明 canonical 工具名
  ↓
同一轮提交结构化 tool_call
  ↓
后端权限 / Schema / confirm 校验
  ↓
真实 dispatch
  ↓
canonical tool_result
```

工具权限、范围、功能开关和确认要求永远由代码决定。Prompt 只声明稳定的交互协议，不能描述当前用户或会话的权限状态。

正常路径不新增额外的“是否需要工具” LLM round。只有检测到协议不一致时，才允许最多一次守卫重试。

## 1. 当前问题

当前模型可能输出：

```text
我已经调用 shell 了，但服务器没有返回结果。
```

但本轮实际没有任何 `tool_call` 或 `tool_result`。现有守卫主要依赖结果断言、行动宣告和进度话术的正则，不能稳定识别“工具意图声明没有进入真实调用”的情况。

当前 `RoundResult.requires_tools` 主要由：

```python
requires_tools = bool(tool_calls)
```

反推，因此只能表示“已经收到结构化调用”，不能表达：

- 模型文本声明要使用工具，但没有提交调用；
- 模型提交了调用，但没有执行结果；
- 模型调用了一个工具，却声明的是另一个工具；
- 工具执行失败，但模型仍然声称成功。

## 2. 目标与非目标

### 2.1 目标

1. 让模型在需要使用工具时，先用 canonical 工具名做简短文本声明。
2. 守卫校验文本声明、结构化 `tool_call` 和 `tool_result` 是否一致。
3. 工具名从当前 Tool Registry 动态取得，不为单个工具手写守卫逻辑。
4. 保持 `call_tool`、`use_skill`、`ask_user` 的固定 Adapter 入口。
5. Web、QQ、群聊、其他 IM 和 scheduled 入口使用同一套事实守卫。
6. 工具失败、无权限和缺少结果时不允许模型伪造成功结论。
7. 守卫重试时只补充当前目标工具的最小 Schema，不重新注入全部工具。
8. LoopScope 能展示声明、调用、结果和守卫原因。

### 2.2 非目标

- 不新增正常路径的额外 LLM 调用。
- 不让模型或 Prompt 决定工具权限、Shell 范围或权限回落。
- 不把 BM25、关键词或自然语言识别当作工具执行事实。
- 不复制 Tool Registry、权限校验、Schema 校验或 confirm gate。
- 不永久全量注入业务工具 Schema。
- 不在本 PRD 重写 Provider、Skill Registry 或 canonical history 架构。

## 3. 权限与能力边界

代码先计算当前请求的有效能力，但不预判用户这句话一定需要哪个工具：

```text
Profile 工具集
  + 当前用户 / 平台权限
  + 当前会话运行时策略
  + Skill 关联工具
  + Shell 等特殊策略
        ↓
effective_tools
        ↓
CapabilitySnapshot
```

权限事实的唯一来源是 Tool Registry 过滤、请求权限快照、Schema 校验、dispatch 校验和 destructive confirm gate。

Prompt、Skill 正文、动态 reminder、RAG 和历史包装不得写入当前用户的工具权限、当前 Shell 范围或权限回落策略。

Provider 首轮仍只注册固定 Adapter：

```text
call_tool
use_skill
ask_user
```

业务工具通过 `call_tool(name, arguments)` 进入既有 Registry。`use_skill` 成功后，按现有机制追加关联工具 Schema。

## 4. 显式工具意图协议

### 4.1 Prompt 稳定规则

`policy.md` 可以加入稳定协议：

> 如果本轮需要使用工具，先用完整 canonical 工具名简短声明，例如“我要使用 `shell` 查看服务器状态”，然后在同一轮提交结构化工具调用。没有真实工具回执，不得声称工具已经执行或任务已经完成。

这条规则不包含任何运行时权限信息。

### 4.2 合法输出示例

```text
我要使用 `shell` 查看服务器状态。
```

同一轮结构化调用：

```json
{
  "type": "tool_call",
  "name": "call_tool",
  "arguments": {
    "name": "shell",
    "arguments": {
      "command": "uptime"
    }
  }
}
```

多工具调用时，声明可以列出多个 canonical 名称，调用集合必须与声明集合一致或是其子集。

### 4.3 不应触发工具守卫的文本

```text
Shell 工具是做什么的？
你觉得应该使用 web_search 吗？
我没有调用工具，只是解释一下原理。
```

守卫需要排除问句、讨论、否定和引用上下文，不能因为出现工具名就强制调用。

## 5. ToolFactGuard

所有工具相关一致性检查统一进入一个事实守卫，不拆成互相独立的“意图守卫”和“结果守卫”。

### 5.1 统一事实模型

```python
ToolRoundFact(
    declared_tools=["shell"],
    tool_calls=[ToolCall(id="call-1", name="shell")],
    tool_results=[ToolResult(call_id="call-1", name="shell", status="success")],
)
```

三个来源分别代表：

```text
declared_tools：模型文本明确声明的工具意图
tool_calls：Provider 提交的结构化调用
tool_results：后端真实执行结果
```

只有 `tool_calls` 和 `tool_results` 能证明执行事实；文本声明只用于检查协议一致性。

### 5.2 守卫状态

| 状态 | 条件 | 处理 |
|---|---|---|
| `normal_text` | 无声明、无调用 | 正常放行 |
| `declared_and_called` | 文本声明与结构化调用一致 | 执行工具 |
| `intent_without_call` | 声明工具但没有 `tool_call` | 守卫重试 |
| `call_without_declaration` | 有调用但没有文本声明 | 守卫重试或记录兼容诊断 |
| `declaration_mismatch` | 声明工具与调用工具不一致 | 守卫重试 |
| `missing_result` | 有调用但没有对应结果 | 阻止成功结论，继续执行或报错 |
| `failed_claimed_success` | 结果失败但文本声称成功 | 守卫重试 |
| `historical_execution_claim` | 声称过去调用过但没有对应事件 | 守卫重试 |
| `unauthorized_tool_claim` | 声明工具不在有效能力集合 | 返回结构化不可用结果 |

第一阶段可以对 `call_without_declaration` 保留兼容放行，但必须记录诊断；协议稳定后再切换为严格重试，避免 Provider 过渡期回归。

### 5.3 工具名识别

工具名和别名由 Registry 动态提供：

```python
registry.canonical_names()
registry.aliases()
```

禁止为单个工具写特判。识别器只负责发现文本声明和匹配工具，不负责权限判定，也不负责证明执行。自然语言匹配可以支持多语言，但允许漏报，不能把匹配结果当作成功事实。

## 6. 守卫执行流程

```text
LLM round 完成
  ↓
解析结构化 tool_calls
  ↓
从文本提取 declared_tools
  ↓
构建 ToolRoundFact
  ↓
ToolFactGuard.evaluate()
  ├─ normal_text → 结束本轮
  ├─ declared_and_called → 权限 / Schema / confirm / dispatch
  ├─ intent_without_call → 计算 retry 工具
  ├─ declaration_mismatch → 重新要求一致声明和调用
  ├─ missing_result → 等待或补执行，不发送成功结论
  └─ failed_claimed_success → 要求如实说明失败
```

守卫重试最多一次。重试仍不满足协议时，不再循环，不伪造工具事件，向用户说明真实状态。

## 7. 守卫重试与 Schema

当 `intent_without_call` 或 `declaration_mismatch` 发生时，守卫结果包括：

```json
{
  "decision": "retry",
  "reason": "intent_without_call",
  "declared_tools": ["shell"],
  "missing_tools": ["shell"],
  "schema_tools": ["shell"]
}
```

重试请求只追加：

```text
你刚才声明要使用 `shell`，但没有提交结构化工具调用。
请现在提交对应调用；如果工具不可用，请直接说明，不能假装已经执行。
```

以及当前有效权限过滤后的最小工具 Schema。

规则：

- 只注入 `missing_tools` / `schema_tools`；
- 注入前重新执行当前用户、平台、Profile、Skill 和会话范围过滤；
- 未授权工具不注入 Schema；
- Schema 必须来自 Tool Registry；
- 纠偏提示和临时 Schema 不写入普通历史；
- 真实 `tool_call/tool_result` 按 canonical history 持久化；
- 异常重试导致 cache 断点移动是可接受的，正常路径不应产生额外注入。

## 8. Provider 与平台一致性

Provider 适配器负责把 Anthropic/OpenAI-compatible 的原生结构转为统一的 `ToolCall`、`ToolResult` 和 `ToolRoundFact`。

Web、QQ、群聊、飞书、微信和 scheduled 不得各自实现守卫。入口只提供请求权限和上下文，事实判断统一在共享 Agent Core 执行。

## 9. LoopScope 与诊断

每个 LLM round 记录脱敏后的结构化字段：

```json
{
  "tool_intent": {
    "source": "text|call|none",
    "declared_names": ["shell"]
  },
  "tool_calls": [
    {"id": "call-1", "name": "shell", "status": "dispatched"}
  ],
  "tool_results": [
    {"call_id": "call-1", "name": "shell", "status": "success"}
  ],
  "guard": {
    "triggered": false,
    "reason": null,
    "retry_count": 0
  }
}
```

禁止记录用户正文、附件内容、完整命令参数和凭据。工具名、状态、数量和脱敏 digest 可以记录。

## 10. 实施阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| Phase 0：协议审查 | ✅ 已完成 | 确认权限由代码决定，工具意图声明与执行事实分离但由同一事实守卫统一校验。 |
| Phase 1：事实模型 | 🔲 待实施 | 新增 `ToolRoundFact`、统一 ToolCall/ToolResult 映射和事实状态。 |
| Phase 2：声明识别 | 🔲 待实施 | Registry 驱动 canonical 工具名、别名、多语言声明识别，排除问句和否定句。 |
| Phase 3：守卫与重试 | 🔲 待实施 | 接入共享 Agent Core，支持缺少调用、声明不一致、缺少结果和失败伪成功。 |
| Phase 4：最小 Schema | 🔲 待实施 | 重试时只注入声明工具的最小 Schema，复用权限和 Registry，不改变正常缓存路径。 |
| Phase 5：平台与 Provider parity | 🔲 待实施 | Web/IM/scheduled 统一接入，多 Provider canonical 转换。 |
| Phase 6：LoopScope 与回归 | 🔲 待实施 | 展示声明/调用/结果/守卫，补充多语言、权限、失败和无限重试测试。 |

## 11. 文件计划

预计修改：

- `backend/agent/core.py`：接入共享事实守卫和统一重试出口；
- `backend/agent/security/core_guards.py`：旧正则降级为辅助检测；
- `backend/agent/tools/meta.py`：明确 `call_tool` canonical contract；
- `backend/agent/tools/base.py`：复用 Registry 能力快照；
- `backend/agent/loop_drivers.py`：统一 ToolCall/ToolResult 映射；
- `backend/agent/runtime/loopscope_trace/`：记录事实和守卫诊断；
- `backend/agent/prompts/policy.md`：加入稳定的工具声明协议，不写运行时权限；
- `backend/tests/`：补充声明、调用、结果一致性回归。

可能新增：

- `backend/agent/security/tool_fact_guard.py`：事实模型、声明识别和状态判定；
- `backend/tests/test_tool_fact_guard.py`：守卫和重试测试。

不新增第二套工具执行器，不复制 Tool Registry、权限、Schema 和 confirm gate。

## 12. 验收标准

- 普通文本轮不增加额外 LLM 调用；
- 模型声明 `shell` 后能提交对应结构化调用；
- 声明工具但没有 `tool_call` 时最多重试一次；
- 声明工具与实际调用工具不一致时不能直接放行；
- 工具失败时不能输出成功结论；
- 没有工具声明的普通聊天不被误拦；
- 问句、讨论、否定句不被误判为工具意图；
- Web 与所有 IM 入口使用同一事实守卫；
- 不把权限状态写入 Prompt；
- 不产生孤立 `tool_result`；
- 不产生守卫无限循环；
- LoopScope 能区分声明、真实调用、执行结果和守卫重试。
