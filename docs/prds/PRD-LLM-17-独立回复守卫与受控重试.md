# PRD-LLM-17：独立回复守卫与受控重试

> 状态：规划中，尚未实施
> 创建：2026-08-31
> 所属层：Agent / LLM Reliability / Context Boundary / LoopScope
> 前置：`PRD-LLM-10-工具调用守卫升级`、`PRD-LLM-16-工具SCHEMA语义显式化与注入优化`
> 主要目标：将“本轮回复是否可以交付”的判断从主对话上下文中隔离出来。

## 0. 核心结论

当前守卫主要由主循环中的代码规则完成：当模型出现空回复、行动宣告、过程播报或“声称完成但没有工具回执”时，向同一个主对话追加内部 follow-up，再请求主模型一次。

本 PRD 将新增一个独立的 `ResponseGuard` 模型调用：

```text
主模型完成当前 round
        ↓
构建 RoundPacket（不含完整历史）
        ↓
独立守卫模型判断 accept / retry / stop
        ├─ accept → 交付当前回复
        ├─ retry  → 给主模型追加最小 retry hint，再调用一次
        └─ stop   → 等待确认或结束当前 run
```

守卫调用不参与主模型上下文，不写入 `ConversationMessage`，不改变主模型的稳定 system prefix、历史缓存边界或下一轮 session history。

守卫只负责“回复是否满足本轮协议和工具事实”，不负责事实查证、风格评分、用户满意度判断，也不替代码决定权限。

## 1. 当前问题

### 1.1 现有机制

当前主循环在 `backend/agent/core.py` 中直接使用多类代码守卫：

- 空回复重试；
- 叙事守卫：模型声称读、改、建、删，但没有工具回执；
- 意图守卫：模型说“我去查/我来修改”，但没有发起工具调用；
- 工具进度守卫：只输出“正在查询”等占位话术；
- 决策守卫：用户明确要求改动，模型却凭空判断“不需要改”；
- 增删改后的查询核实和最终收束。

部分守卫通过 `build_guard_followup()` 追加内部 system 消息。虽然历史持久化过滤会排除部分合成消息，但它们仍会进入当前 run 的主模型请求，可能造成：

1. 主对话上下文变长；
2. 动态尾部和工具历史增加，影响 cache prefix 稳定性；
3. 守卫提示与真实用户请求混在一起，增加提示词污染风险；
4. 多条正则规则叠加后，难以判断某次重试的真实原因；
5. 守卫规则只能从文本表面推断，无法统一查看本轮工具事实。

### 1.2 需要解决的边界

以下事实只能由代码和真实执行状态决定，不能交给守卫模型臆测：

- 工具是否在有效能力集合中；
- 工具权限和资源归属；
- Schema、参数和 destructive confirm gate 是否通过；
- 工具是否真正 dispatch；
- 工具结果是否成功、失败或等待确认。

独立守卫只能消费这些代码已经生成的结构化事实，并决定是否需要让主模型重新处理回复。

## 2. 目标与非目标

### 2.1 目标

1. 增加一个不读取完整 session history 的独立回复守卫调用。
2. 统一判断本轮输出、工具调用和工具结果是否一致。
3. 守卫输入使用固定结构的 `RoundPacket`，不把完整工具结果、凭据或上下文重复发送给守卫。
4. 守卫输出使用严格 JSON 协议，只有 `accept`、`retry`、`stop` 三种最终决策。
5. 重试最多发生一次，且只追加最小、明确、不可持久化的 retry hint。
6. 不改变主模型的稳定 system prompt、session history 和缓存锚点。
7. Web、IM、scheduled 和其他 Agent 入口共用相同的守卫边界。
8. LoopScope 独立记录守卫 span、输入摘要、决策、原因和时延。
9. 守卫不可用时不阻断主链路，不把守卫故障伪装成用户请求失败。

### 2.2 非目标

- 不使用守卫模型进行完整事实核查或第二次工具执行。
- 不让守卫访问完整对话、Memory、RAG、Skill 正文或全部工具 Schema。
- 不让守卫决定工具权限、资源范围、用户确认和数据归属。
- 不用守卫替代工具 dispatch、confirm gate、Schema 校验和工具结果落库。
- 不把守卫判断写入用户可见回复或 `ConversationMessage`。
- 不为每个中间工具 round 都增加一次独立守卫调用。
- 不通过无限重试提高回答质量。

## 3. 目录与责任边界

### 3.1 目标目录树

```text
backend/
├── agent/
│   ├── core.py                         # 主循环编排；调用守卫并执行有限重试
│   ├── loop_drivers.py                 # Provider round 边界，不承载守卫判断
│   ├── security/
│   │   └── core_guards.py              # 保留纯代码硬规则和安全协议检查
│   ├── response_guard/
│   │   ├── __init__.py
│   │   ├── models.py                   # RoundPacket、GuardDecision、枚举和版本
│   │   ├── packet.py                   # 从 RoundResult 和工具事实构建最小输入
│   │   ├── prompt.py                   # 守卫专用稳定 system prompt
│   │   ├── service.py                  # 独立 provider 调用、超时和 JSON 解析
│   │   └── policy.py                   # 触发条件、重试上限和故障降级
│   └── runtime/
│       └── loopscope_trace/             # 新增 guard span 的旁路观测
├── tests/
│   ├── test_response_guard.py          # 判定解析、降级和重试策略
│   └── test_response_guard_integration.py
└── docs/
    └── devlog/                         # 实施和验证记录
```

### 3.2 所有权

| 责任 | 唯一事实来源 |
|---|---|
| 有效工具集合与权限 | Tool Registry、请求权限快照、dispatch 校验 |
| 工具真实调用 | `RoundResult.tool_calls` 与 dispatch 事件 |
| 工具执行状态 | 工具 handler 返回的结构化结果 |
| 用户确认状态 | Interaction / confirm gate |
| 是否触发守卫 | `response_guard/policy.py` 与主循环状态 |
| 守卫判断 | 独立 Guard provider 调用 |
| 是否执行重试 | 主循环根据结构化 `GuardDecision` 决定 |
| 观测记录 | LoopScope 旁路 trace |

## 4. RoundPacket 协议

守卫不接收主模型的完整 messages，只接收本轮的最小事实包。协议必须带版本号，便于后续兼容。

```json
{
  "schema_version": 1,
  "user_request": "用户本轮原始请求",
  "assistant_output": "主模型本轮最终文本",
  "tool_usage": {
    "called": true,
    "calls": [
      {"name": "read_file", "status": "success"}
    ],
    "failed": false,
    "pending_confirmation": false
  },
  "round_state": {
    "is_final_candidate": true,
    "verify_mode": false,
    "interaction_pending": false
  }
}
```

### 4.1 输入规则

- `user_request` 只保留本轮用户请求，不附带完整历史。
- `assistant_output` 是本轮最终文本，不包含思考块、工具参数和内部控制消息。
- `tool_usage.calls` 只传工具名和结构化状态；工具参数、结果正文按场景只传短错误类别或状态码摘要。
- 不传 API Key、Cookie、Token、密码、完整文件正文、完整工具结果或其他凭据。
- 不传 Memory、RAG、Skill 正文、系统提示词和历史消息。
- 如果输出来自交互等待、核验中间态或工具调用中间态，不触发最终回复守卫。

### 4.2 事实优先级

```text
代码生成的 tool_usage > 主模型文字中的工具声明
```

模型说“已经调用工具”不能证明工具执行；只有代码记录的真实 dispatch 和结果才能证明。

## 5. GuardDecision 协议

守卫必须输出单个 JSON 对象，不允许输出 Markdown、解释性前后缀或工具调用。

```json
{
  "decision": "accept|retry|stop",
  "reason_code": "ok|empty_output|missing_tool|tool_failed_claimed_success|pending_confirmation|protocol_mismatch|guard_error",
  "retry_hint": "仅 decision=retry 时填写，最多 240 字",
  "confidence": 0.0
}
```

### 5.1 决策规则

| 决策 | 典型条件 | 主流程处理 |
|---|---|---|
| `accept` | 输出可交付，工具事实与结论一致 | 发送当前回复 |
| `retry` | 空回复、声称完成但无回执、工具失败却声称成功、明确需要工具但未调用 | 追加 retry hint，最多重新调用主模型一次 |
| `stop` | 等待用户确认、输入信息不足、工具额度或交互状态要求用户介入 | 不自动重试，保留当前交互流程 |

守卫不能因为风格、长度、措辞偏好或主观事实怀疑而触发重试。高精度优先于“看起来更聪明”。

### 5.2 代码硬规则优先

以下情况不等待模型守卫判断，直接由代码处理：

- provider 调用异常、超时和连接错误；
- 工具参数解析失败；
- 无权限或归属校验失败；
- destructive 操作确认不完整；
- 交互等待和取消；
- 工具预算耗尽；
- 工具结果缺失或协议不完整。

守卫只能在“本轮已经得到一个候选最终文本”后判断是否应该要求主模型重新组织或补做。

## 6. 调用时机与流程

### 6.1 触发时机

默认只在以下条件同时满足时调用：

1. `RoundResult` 已经有候选最终文本；
2. 当前没有待执行工具调用；
3. 当前没有待确认交互；
4. 当前不是核验过程中的中间文字；
5. 当前 run 尚未完成守卫重试；
6. 当前回复属于需要协议检查的 Agent round。

普通闲聊可通过轻量规则直接跳过守卫。含工具调用、工具失败、操作性动词或空回复风险的 round 才进入模型守卫。

### 6.2 重试流程

```text
候选最终回复
  ↓
代码整理 RoundPacket
  ↓
ResponseGuard.evaluate()
  ├─ accept → 输出候选回复
  ├─ stop   → 保留交互/确认状态
  └─ retry
       ↓
     记录 retry_count += 1
       ↓
     仅追加短 retry hint 到主模型动态尾部
       ↓
     主模型重新处理当前 round
       ↓
     第二次候选回复直接交付或按降级规则结束
```

retry hint 不得带守卫完整输出，不得写入持久化历史。为避免缓存前缀变化，hint 必须位于当前主模型请求的动态尾部。

### 6.3 重试上限

- 每个用户请求最多一次 ResponseGuard 触发的主模型重试。
- 守卫本身不允许调用工具，也不允许递归调用守卫。
- 第二次候选仍不满足时，默认交付可见结果或转为明确失败说明，不能继续循环。
- 原有工具核验轮和 provider 瞬时错误重试属于不同预算，不能相互叠加放大。

## 7. 守卫模型调用

### 7.1 Provider 配置

第一阶段复用当前有效模型路由，但使用独立请求配置：

- 无工具 Schema；
- `temperature=0` 或 provider 等价设置；
- 输出预算建议 128～256 token；
- 独立超时，建议 3～8 秒；
- 不复用主模型的完整 `ContextBranch`、session history 或动态注入；
- 可预留独立 guard model 配置，后续切换为更快、更便宜的小模型。

### 7.2 Prompt 原则

守卫 system prompt 只描述稳定判断协议，例如：

> 你是回复协议检查器。根据用户本轮请求、助手候选回复和代码提供的工具事实，判断候选回复是否可以交付。不要补充事实，不要调用工具，不要评价文风。仅输出规定格式的 JSON。

禁止在守卫 Prompt 中写入当前用户权限、当前可用工具列表、资源范围或任何运行时事实；这些内容通过结构化 packet 由代码控制。

## 8. 故障与降级

| 故障 | 处理 | 可见性 |
|---|---|---|
| 守卫超时 | 放行当前候选回复，记录 `guard_timeout` | 不提示用户守卫存在 |
| 守卫网络错误 | 放行当前候选回复 | 仅诊断记录 |
| JSON 解析失败 | 视为 `guard_error`，放行且不重试 | 仅诊断记录 |
| 守卫返回未知决策 | 同上 | 仅诊断记录 |
| 守卫建议重复重试 | 主循环按计数器拒绝 | 不进入无限循环 |
| 守卫 provider 鉴权失败 | 不影响主模型 | 诊断记录脱敏错误类型 |

守卫是质量增强旁路，不是主链路依赖。守卫不可用不能导致正常对话不可用。

## 9. LoopScope 观测

每次守卫调用记录独立 span，建议字段：

```json
{
  "span_type": "response_guard",
  "round_id": "round-3",
  "trigger": "tool_failed_claimed_success",
  "decision": "retry",
  "reason_code": "tool_failed_claimed_success",
  "retry_count": 0,
  "provider": "qwen",
  "model": "guard-model",
  "usage_in": 180,
  "usage_out": 42,
  "latency_ms": 620,
  "packet_digest": "..."
}
```

LoopScope 可以保留受控开发环境下的完整 `RoundPacket` 和守卫原始输出，便于诊断；普通应用日志只记录脱敏后的状态、原因码和耗时。守卫请求不得包含凭据，凭据也不得进入 trace。

需要能区分：

- 主模型 round；
- ResponseGuard span；
- Guard retry 触发的主模型 round；
- 原有工具核验 round；
- provider 网络错误重试。

## 10. 与现有守卫的迁移关系

### 第一阶段

- 保留工具权限、Schema、confirm gate、dispatch、工具结果协议等代码硬规则。
- 保留 provider 瞬时错误重试、工具参数解析失败处理和交互等待逻辑。
- 新增 ResponseGuard，但只接管最终候选回复的一致性判断。
- 现有正则守卫先降级为兼容兜底，并记录命中原因，避免一次迁移同时改变行为。

### 第二阶段

- 对照 LoopScope 数据，确认 ResponseGuard 能覆盖现有叙事、意图、空回复和失败声称场景。
- 删除与 ResponseGuard 重复且误报率高的主循环 follow-up 规则。
- 保留无法由模型判断的代码硬规则。

### 第三阶段

- 根据 provider、模型和入口统计，决定是否为守卫配置独立小模型。
- 对普通闲聊扩大跳过范围，降低无必要的额外请求。
- 固化 guard span contract 和回归样本。

## 11. 验收标准

### 11.1 功能验收

- [ ] 正常文本回复得到 `accept` 并只发送一次。
- [ ] 空回复最多触发一次主模型重试。
- [ ] 模型声称完成但无工具回执时触发 `retry`。
- [ ] 工具失败但模型声称成功时触发 `retry` 或明确阻止成功结论。
- [ ] 待用户确认时返回 `stop`，不自动执行或重试。
- [ ] 工具真实成功后正常总结，不因“没有文字声明工具”误触发死循环。
- [ ] 第二次候选仍异常时不会继续递归。

### 11.2 上下文与缓存验收

- [ ] 守卫请求不包含完整主对话 history。
- [ ] 守卫消息不出现在 `ConversationMessage` 或下一轮 session history。
- [ ] 主模型稳定 system prefix 和 cache anchor 不因 accept 守卫调用改变。
- [ ] retry hint 只出现在重试请求的动态尾部。
- [ ] 普通无工具对话不产生不必要的守卫请求。

### 11.3 稳定性与安全验收

- [ ] 守卫超时、网络错误、非法 JSON 都不会阻断主链路。
- [ ] 守卫没有工具权限，不能触发外部副作用。
- [ ] RoundPacket、trace 和日志不包含 Token、Cookie、API Key、密码。
- [ ] Web、IM、scheduled 入口使用同一套策略。
- [ ] `git diff --check`、后端测试、ownership/confirm 守卫和 compileall 通过。

### 11.4 观测验收

- [ ] LoopScope 能单独看到 guard span。
- [ ] 能区分 `accept`、`retry`、`stop`、timeout 和 parse error。
- [ ] 能统计守卫调用率、重试率、二次候选成功率、平均时延和额外 token。
- [ ] 能对比迁移前后主模型 context token、cache read 和最终回复失败率。

## 12. 测试计划

### 12.1 纯单元测试

- `RoundPacket` 不携带完整 history、Schema、凭据和工具正文。
- `GuardDecision` 严格解析、未知字段和非法 JSON 处理。
- 各类 reason code 到 retry/stop/accept 的映射。
- 重试计数器达到上限后拒绝再次重试。
- 守卫异常统一降级为放行。

### 12.2 主循环集成测试

- 无工具普通回复；
- 工具成功后最终总结；
- 工具失败后错误说明；
- 无工具但声称已执行；
- 只输出进度话术；
- 用户确认等待；
- 守卫第一次要求 retry，第二次通过；
- 守卫连续要求 retry；
- provider 和守卫同时出现异常。

### 12.3 缓存与上下文测试

- 同一 session 连续 round 对比守卫启用前后的主模型 messages；
- 验证守卫调用不会改变主模型稳定 system prefix；
- 验证守卫不会进入持久化 history；
- 验证 retry hint 只出现在 retry round 的动态尾部；
- 使用 LoopScope 检查主模型 cache read、fresh input、guard token 和 round 数量。

## 13. 风险与取舍

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 每次调用增加延迟和成本 | 普通对话变慢 | 只对高风险 round 触发，守卫低预算 |
| 守卫模型误判 | 产生不必要重试或打断 | 高精度规则、单次上限、失败放行 |
| packet 信息不足 | 无法判断复杂事实 | 由代码补充结构化工具状态，不传完整历史 |
| 守卫输出污染主上下文 | cache 或语义受影响 | 守卫完全独立；retry hint 仅动态尾部且不落库 |
| 与旧代码守卫重复 | 两套规则互相触发 | 分阶段迁移，LoopScope 统计后删除重复路径 |
| 把质量判断误当事实判断 | 模型自信地否定用户结果 | 明确非目标，不让守卫做事实审查 |

## 14. 实施顺序

1. 冻结 `RoundPacket` 与 `GuardDecision` contract。
2. 新增独立 `response_guard` 服务层和纯单元测试。
3. 接入主循环，仅在最终候选回复阶段旁路调用，默认不触发重试。
4. 接入 LoopScope guard span 和统计字段。
5. 开启有限 retry，补齐主循环集成测试。
6. 用真实 Web/IM 连续 session 验证上下文、cache 和最终回复行为。
7. 根据误报、漏报、延迟和 token 数据，删除重复的正则 follow-up。
8. 更新 `docs/devlog/`、`docs/backend/OVERVIEW.md` 和相关测试说明。

## 15. 完成定义

本 PRD 只有在以下条件全部满足后才可标记完成：

1. 独立守卫调用与主模型上下文边界在代码和测试中明确成立。
2. 工具事实仍由代码决定，守卫不能绕过权限、Schema 或确认门。
3. 守卫重试有界，异常可降级，主链路不会因守卫不可用而失败。
4. 守卫不会进入 session history，不改变主模型稳定缓存前缀。
5. LoopScope 可区分主模型 round、守卫调用和重试原因。
6. 迁移前后的真实回归样本已比较，并记录延迟、token、cache 和误判数据。
