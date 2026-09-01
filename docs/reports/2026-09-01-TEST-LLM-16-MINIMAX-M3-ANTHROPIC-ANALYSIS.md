# MiniMax M3 Anthropic 工具调用专项分析

日期：2026-09-01  
环境：devserver `192.168.110.51`  
协议：MiniMax Anthropic-compatible API  
模型：`MiniMax-M3`

## 1. 报告目的

本报告单独分析 MiniMax M3 在 5 tools 多模型测试中表现明显偏弱的原因，重点区分：

1. Anthropic tool-call 历史回传是否被应用侧破坏；
2. thinking 是否没有正确启用；
3. Schema 注入和缓存边界是否造成额外干扰；
4. 在链路修复后，剩余问题是否更可能属于模型自身的工具路由能力。

本报告不改变原始多模型对比报告的统计口径，也不把模型能力问题误判为接口传输问题。

## 2. 已有真实测试结果

测试固定为 5 个目标工具：

- `list_folders`
- `read_file`
- `list_events`
- `create_project`
- `note_create`

每种模式 20 个测量用例，工具 dispatch 使用 no-op 拦截，不写入真实业务数据。

| 模式 | 工具 Schema 数 | Provider input | Cache rate | 工具准确率 | Schema errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| 简介模式 | 4 + 工具目录 | 508,301 | 99.04% | 12/20（60%） | 8 |
| 全量模式 | 100 | 978,324 | 98.72% | 16/20（80%） | 4 |

失败主要表现为模型没有选择目标工具并直接输出文本，或 `note_create.blocks` 参数结构不符合诊断预期；不是 HTTP、鉴权或工具执行异常。

对照模型在同一轮复测中：

| 模型 | 简介模式准确率 | 全量模式准确率 |
| --- | ---: | ---: |
| GLM | 16/20（80%） | 20/20（100%） |
| DeepSeek | 20/20（100%） | 20/20（100%） |
| Qwen | 20/20（100%） | 20/20（100%） |

MiniMax 在两种模式下都低于对照模型，尤其在全量 Schema 下仍有 4 次路由失败。

完整原始统计见：[5 tools 多模型 Schema 模式复测报告](2026-09-01-TEST-LLM-16-5TOOLS-MULTI-MODEL-RETEST.md)。

## 3. Anthropic 链路核查结果

MiniMax 官方要求多轮工具调用时，把完整的 `assistant response.content` 回传，包括 `thinking`、`text`、`tool_use` 和 `signature`。官方 Anthropic 示例也采用完整 `response.content` 作为下一轮 assistant message。[MiniMax 官方文档](https://platform.minimaxi.com/docs/guides/text-m3-function-call)

当前代码已完成以下处理：

- `AnthropicDriver.build_tool_round()` 直接使用 `result.raw` 的所有 block；
- `thinking`、`signature`、`text`、`tool_use` 不再由文本和工具调用重新拼接；
- 工具结果使用匹配的 `tool_use_id` 回传；
- 曾临时为 MiniMax M3 显式发送 `thinking.enabled` 和 `budget_tokens=8192`，随后用同一口径重新测试；准确率没有改善，已回退该 provider 专用参数，恢复服务端默认行为。

- 增加 Anthropic 专用 LoopScope 结构探针，只记录 block 类型、工具名、signature 是否存在、digest 和 round-trip 是否一致，不记录思考正文、用户正文或工具参数；
- 固定缓存逻辑只在稳定 system/history 前缀上设置缓存锚点，动态尾部不会被纳入稳定前缀。

本地及 devserver 相关回归测试均通过：

- 之前完整相关测试：74 项通过；
- 本次预算调整后的 MiniMax/Anthropic 相关测试：本地 41 项、devserver 41 项通过；
- devserver 已确认 MiniMax M3 使用 `anthropic` 协议和 active cache；当前不再强制附加 thinking 参数。

因此，目前没有证据表明“只因 Anthropic assistant block 被错误重组”导致 MiniMax 的主要失败。

## 4. 为什么更像模型能力问题

### 4.1 失败类型与协议错误不一致

MiniMax 的主要失败是“没有调用目标工具而直接回复文本”。如果是 Anthropic wire history 被破坏，更常见的表现应是：

- API 拒绝请求；
- 缺少或不匹配 `tool_use_id`；
- `signature` 校验失败；
- 第二轮上下文断裂或重复调用。

现有统计中，MiniMax 请求能够正常完成，且没有出现成批的 Anthropic 格式拒绝，失败集中在工具选择阶段，符合模型路由决策不稳定，而不是消息格式损坏。

### 4.2 全量 Schema 没有改善到对照模型水平

全量模式从简介模式的 12/20 提升到 16/20，说明完整 Schema 对 MiniMax 有帮助；但它仍低于 GLM、DeepSeek、Qwen 的全量结果。

这说明问题不是“模型完全看不到工具定义”，而更可能是：

- 工具数量增大后，候选工具之间的区分度不足；
- 模型对工具描述和目标任务的匹配不稳定；
- 连续多轮后工具选择状态容易漂移；
- 对 `note_create.blocks` 这类嵌套结构的生成约束能力弱于对照模型。

### 4.3 缓存率高不能证明工具选择正确

MiniMax 两种模式的缓存率都接近 99%，但准确率仍低于对照模型。缓存只说明请求前缀复用良好，主要影响成本和延迟，不代表模型理解了 Schema，也不代表工具路由准确。

### 4.4 预算增加只能解决思考截断，不能保证路由正确

已将 M3 thinking budget 从 4096 调整为 8192，以降低复杂任务中 thinking 被截断的可能性。该调整可能改善长任务，但不能直接证明或保证工具选择准确率提升。

如果 8192 预算下仍保持类似错误类型，则“模型能力/工具路由能力”的解释进一步增强。

## 5. 当前结论

当前证据支持以下判断：

1. **Anthropic 多轮回传链路已经按 MiniMax 要求保留完整 response blocks。**
2. **显式 thinking 曾以 8192 预算进行验证，但简介模式准确率没有改善，现已回退为服务端默认行为。**
3. **缓存前缀不是主要矛盾。** 当前缓存率高，但与工具准确率没有直接正相关。
4. **MiniMax M3 的剩余主要风险更像工具路由和复杂参数生成能力，而不是 Anthropic 协议兼容问题。**
5. **全量模式可以降低部分 MiniMax 错误，但不能达到对照模型的稳定性，因此不建议仅依靠扩大 Schema 解决。**

这里的结论是基于当前 20 用例、5 tools、两种 Schema 模式的专项测试，不能外推为 MiniMax M3 在所有任务上的总体能力排名。

## 6. 后续建议

建议下一轮只做针对性验证，不立即再改 provider 协议：

1. 如仍需研究 thinking，使用同一批 prompt 对比服务端默认、4096 与 8192；
2. 将 5 tools 拆成单工具、低歧义工具组和全量工具组，观察错误率随候选数量变化；
3. 把“未选工具”和“参数结构错误”分开统计；
4. 使用新的 Anthropic 结构探针确认每次工具续轮的 `assistant_roundtrip_same=true`；
5. 如果 round-trip 始终为 true，而 MiniMax 仍直接文本回答，则可以把问题正式归类为模型能力/路由能力限制。

本报告没有包含模型思考正文、用户消息、API key、Cookie 或其他凭据。
