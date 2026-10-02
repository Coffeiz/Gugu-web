# Anthropic 与 Responses API 上下文回放修复

## 背景

LLM-29 将对话上下文迁移到统一的 canonical `MessageArea`，Provider 再按协议生成不可变的 `ProviderConversation`。今晚复查 MiniMax Responses 的多轮真实会话时，出现了“工具/技能已经调用，但后续回答忘记最初任务”的现象；同一轮排查也检查了 Anthropic 与 Chat/Responses 驱动，避免上下文类型迁移后仍有 Provider 使用旧消息形状。

此前 Anthropic 工具轮签名 thinking 的持久化恢复和跨 run 缓存前缀修复已单独记录在 [LLM-29 历史工具签名恢复回归与缓存 A/B 验证](./2026-10-02-LLM29历史工具签名恢复回归与缓存AB验证.md)，本文记录其后续 API 边界适配、Responses 续接问题及真实模型复测，不重复缓存 A/B 的历史数据。

## Responses：完整历史回放与推理续接策略

### 现象与定位

LoopScope 导出的真实 run 中，发给后续轮次的本地 Provider 投影仍包含最初用户任务、工具调用及结果。因此没有证据表明应用组装时丢弃了用户原始意图。问题出现在依赖 `previous_response_id` 的增量续接：兼容服务对 `function_call_output` 的 response-chain 行为不一致，可能返回 HTTP 400，或接受请求后只回应“工具已加载”，没有继续原任务。

另一条可复现边界是增量投影只剩 reasoning-only/空 assistant 项。Responses 序列化会过滤这些不可发送项，结果可能变成 `input=[]`，被上游以参数错误拒绝。

### 修复

- 所有 Responses 请求统一由本地完整 canonical 历史生成 `input`，不再发送 `previous_response_id`，也不保留增量续接及 stale-chain fallback。用户消息、assistant 回复、工具调用和工具结果按 Provider 协议投影后按序回放；过滤后没有可发送输入时，在发起网络请求前明确报错，不发送 `input=[]`。
- “推理续接”负责控制 provider-specific reasoning item 的提取、加密持久化与后续回放策略，不再决定是否使用 response chain。关闭时只回放普通完整历史，不注入 reasoning item；开启时从已完成响应提取 reasoning item，在完整历史中按 assistant 输出顺序重放，并按 Provider 能力请求可恢复的加密 reasoning 内容。
- reasoning item 不写入 canonical 对话正文或普通日志；跨 run 状态仍受现有加密存储、模型/配置指纹、生命周期和并发校验约束。Responses 的推理内容只在续接策略允许时参与重放。

### 真实模型 A/B

早期 response-chain 故障定位阶段，曾以 `previous_response_id` 增量路径和工具回执后的完整历史路径作隔离对照；这批结果说明旧增量续接在当时选取的三个配置上失败，完整历史能继续工具流程，但不代表当前“推理回放开关”的 A/B。可复用脚本现已改为只比较完整历史的两种策略：`canonical_only` 与 `reasoning_replay`。脚本会在模型声明支持时仅对内存测试副本启用推理档位，不改持久化预设；两组均不发送 `previous_response_id`，并用合成天气工具回执，不执行真实网页搜索、不修改业务会话。

| 早期接口配置 | response-chain 增量 | 完整历史 | 原任务理解检查 |
| --- | --- | --- | --- |
| MiniMax Responses（MiniMax-M3.1-Flash-Preview） | HTTP 400 | 继续调用搜索工具并生成最终答复 | 最终答复包含校验短语 `ORBIT-42` |
| Agnes，经 APIHub | HTTP 400 | 继续调用搜索工具并生成最终答复 | 最终答复包含 `ORBIT-42` |
| Agnes 直连接口 | HTTP 400 | 继续调用搜索工具并生成最终答复 | 工具链继续，但最终答复未包含 `ORBIT-42` |

三种配置的旧续接都复现失败，完整历史路径都能继续最初任务并发起预期工具调用。最终指令校验通过 2/3；Agnes 直连接口虽未遗忘任务流程，但没有遵守必须回显校验短语的约束。以上仅是旧链路故障定位数据，不是当前推理回放策略的验收结果。

当前策略的真实模型 A/B 使用“南京天气 → 合成工具结果 → ‘一会儿呢？’”多轮探针。验收同时检查后续是否继续调用 `weather_lookup(city=南京, period=next_hour)`，以及 reasoning-replay 组是否至少有一轮实际把 reasoning item 放入后续完整历史。推理档位只在脚本创建的内存模型配置副本中启用，报告确认原持久化配置未改。

| Responses 配置 | 完整历史意图识别 | reasoning 回放观测 | 结论 |
| --- | --- | --- | --- |
| Agnes，经 APIHub（`agnes-2.5-flash`） | 两组均 3/3 正确调用下一小时天气工具 | 关闭 0/3；开启 3/3 实际回放 | 推理续接 A/B 通过 |
| MiniMax（`MiniMax-M3.1-Flash-Preview`） | 两组各 5 轮合计：关闭 9/10、开启 10/10 正确调用下一小时天气工具 | 关闭组 0/10 回放；开启组 5/10 实际收到并回放 reasoning item | 确认推理回放链路有效；样本不足以证明意图正确率有因果提升 |

MiniMax 探针显式发送已声明支持的 `reasoning.effort=max`，并确认未修改持久化预设。调查发现原先“查询当前天气→简单追问”的探针太简单：5 轮中没有一次产出 reasoning item。单独 Responses 探针显示，普通短答、必须调用工具的请求与多因素天气判断会产生不同输出；在完整多轮 A/B 中加入多因素天气比较后，推理回放组 10 轮里有 5 轮实际收到并回放 reasoning item，另一半没有输出该 item。所有 10 轮都没有 API 错误；两组意图检查合计 19/20。由此未发现 MiniMax reasoning item 被驱动漏读或漏回放的问题；当前限制是模型对简单工具任务不稳定地产生可回放推理项。这个小样本只能确认路径能工作，不能据此声称回放提高任务成功率。Responses 驱动的捕获/插入/关闭隔离另由行为测试覆盖。结果仅代表这些端点、模型和脚本输入，不构成所有兼容 Responses 服务的保证。

对应行为回归覆盖：空增量回放、完整历史为空时请求前拒绝，以及工具回执后保留原始用户请求、工具调用和工具结果，并不使用旧 response chain。

## Anthropic：上下文投影边界与失败诊断

- Anthropic 工具调用历史 ID 不再直接扫描通用消息对象，而是从 adapter 生成的实际 Provider 投影读取。这样数据库恢复的 row envelope（工具内容在 `content_json`）与本轮 live entry 使用同一出站形状，避免恢复路径漏掉有效 `tool_use`，或把已裁剪的调用误计入历史。
- 历史签名 thinking 只插入本次请求的 Provider 副本；SDK 调用边界显式转成普通消息列表。恢复过程不改写 canonical `MessageArea`，也不把签名或 thinking 文本写回普通消息持久化记录。
- Anthropic 请求失败诊断会穿过应用层 `RetryableError` 找到 Provider 根因，保留白名单中的 HTTP 状态、错误类别/错误码及重试次数。诊断仅记录结构摘要、哈希、工具 ID 指纹和上下文投影身份，不保存用户正文、Provider 原始响应体或 thinking/signature 内容。
- Anthropic round-trip 回归测试覆盖数据库恢复后的历史 thinking、工具轮配对、canonical 区域不变，以及包装异常下错误码仍可观测且正文不泄露。

Anthropic 历史签名恢复的真实缓存验证、数据和局限详见前述 LLM-29 记录；本次未将 Responses 的 A/B 结果套用到 Anthropic。

## Chat Completions 与统一 Provider 边界

本轮 API 适配也收紧了 Chat Completions 的 Provider 历史处理：工具历史清理、系统消息合并、Responses 专属 item ID 清理及缓存身份均在 `ProviderConversation` 出站副本上完成。缓存诊断绑定 Area revision/digest 与投影前缀；provider-only 动态尾部不混入 canonical 区域。Anthropic、Chat Completions、Responses 和 Ollama 的 SDK/HTTP 边界各自显式消费消息列表，避免把内部 Area/Projection 容器直接传给第三方 SDK。

这部分是上下文迁移的协议边界收口；它不改变普通对话历史的产品语义，也不声称三个协议的序列化彼此相同。

推理状态持久化能力也改为通过 Provider adapter 解析出的 wire 协议判断，而非维护一份 Provider 名称白名单。明确为 Chat Completions 的配置不启用续接状态；Responses、Anthropic 等协议再按各自 adapter/driver 能力处理，避免新 Provider 或同一 Provider 的不同 API 格式被错误归类。

## MiniMax API 错误信息

MiniMax adapter 新增对上游错误的结构化解析：沿异常链查找 MiniMax 响应，仅从白名单字段提取服务端错误码、HTTP 状态、受限字符集的 request ID 和错误类别，再映射为可读说明/i18n key。原始错误正文不返回给 UI，非 MiniMax 主机且不含 MiniMax `base_resp` 结构的异常不会被错误映射成 MiniMax 错误。解析逻辑供聊天/Responses、模型连通性测试及语音相关 API 共用；它改善错误定位，不改变请求参数或重试策略。

## 验证与边界

- 本地行为测试覆盖 Responses 完整历史、推理项捕获/回放与关闭隔离，以及 Anthropic Provider round-trip 和异常包装诊断。
- Anthropic 定向回归在 devserver 的 round-trip/reasoning driver 测试组共 42 项通过；历史签名与缓存前缀专门测试的结果另见前述 LLM-29 记录。
- Responses 真实模型 A/B 已按上表复测：Agnes 推理关闭/开启组意图识别均 3/3，开启组 reasoning 项实际回放 3/3；MiniMax 在更丰富的天气比较探针中开启组 5/10 实际回放 reasoning item、关闭组 0/10，意图检查分别为 10/10 和 9/10，差异只作观测、不作因果结论。
- A/B 不执行真实搜索、不写业务数据、不记录 API 密钥或原始聊天内容。结果仅代表当晚使用的具体端点、模型和脚本输入；网络响应和模型版本变化后应重新验证。
- 本文是排查记录，不表示其他无关工作区改动已通过测试、已提交或已发布。
