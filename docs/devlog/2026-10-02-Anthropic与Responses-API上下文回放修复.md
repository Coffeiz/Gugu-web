# Anthropic 与 Responses API 上下文回放修复

## 背景

LLM-29 将对话上下文迁移到统一的 canonical `MessageArea`，Provider 再按协议生成不可变的 `ProviderConversation`。今晚复查 MiniMax Responses 的多轮真实会话时，出现了“工具/技能已经调用，但后续回答忘记最初任务”的现象；同一轮排查也检查了 Anthropic 与 Chat/Responses 驱动，避免上下文类型迁移后仍有 Provider 使用旧消息形状。

此前 Anthropic 工具轮签名 thinking 的持久化恢复和跨 run 缓存前缀修复已单独记录在 [LLM-29 历史工具签名恢复回归与缓存 A/B 验证](./2026-10-02-LLM29历史工具签名恢复回归与缓存AB验证.md)，本文记录其后续 API 边界适配、Responses 续接问题及真实模型复测，不重复缓存 A/B 的历史数据。

## Responses：工具回执后的续接丢失原任务意图

### 现象与定位

LoopScope 导出的真实 run 中，发给第二轮的本地 Provider 投影仍包含最初用户任务、`use_skill` 调用及其结果，也包含搜索工具定义。因此没有证据表明应用组装时丢弃了用户原始意图。问题出现在依赖 `previous_response_id` 的增量续接：兼容服务对 `function_call_output` 的 response-chain 续接行为不一致，旧链路可能返回 HTTP 400，或在接受请求后只回应“工具已加载”，没有继续原任务。

另一条可复现边界是增量投影只剩 reasoning-only/空 assistant 项。Responses 序列化会过滤这些不可发送项，结果可能变成 `input=[]`，被上游以参数错误拒绝。

### 修复

- 当 response-chain 增量包含 `function_call_output` 时，改用本地完整 canonical 历史做无状态重放，并不发送 `previous_response_id`。工具调用、工具结果和最初用户消息按原顺序一起发给模型。
- 当增量过滤后为空时，如果完整本地历史仍有可发送输入，就回放完整历史；若完整历史也为空，则在发起网络请求前明确报错，不发送 `input=[]`。
- 保留已有 stale response-chain 恢复边界：只有明确识别到 response/tool ID 丢失时才去掉旧 chain 并以本地历史重放，避免把普通模型路由或参数错误误当成可恢复的 chain 失效。
- 不对所有 Responses 请求无条件全量回放：没有工具回执且增量有效时仍可使用既有 response-chain 路径。

### 真实模型 A/B

在 devserver 使用实际配置的 MiniMax 与 Agnes Responses 模型，执行脚本化多轮对话。测试将真实驱动置于两组路径中：旧组使用 `previous_response_id` 增量续接，修复组使用工具回执后的 canonical 全量回放；工具返回内容为合成结果，没有执行真实网页搜索，也未修改业务会话。

| 接口配置 | 旧增量续接 | 修复后的回放 | 原任务理解检查 |
| --- | --- | --- | --- |
| MiniMax Responses（MiniMax-M3.1-Flash-Preview） | HTTP 400 | 继续调用搜索工具并生成最终答复 | 最终答复包含校验短语 `ORBIT-42` |
| Agnes，经 APIHub | HTTP 400 | 继续调用搜索工具并生成最终答复 | 最终答复包含 `ORBIT-42` |
| Agnes 直连接口 | HTTP 400 | 继续调用搜索工具并生成最终答复 | 工具链继续，但最终答复未包含 `ORBIT-42` |

三种配置的旧续接都复现失败，修复路径都能继续最初任务并发起预期工具调用。最终指令校验通过 2/3；Agnes 直连接口虽未遗忘任务流程，但没有遵守必须回显校验短语的约束，因此不把结果夸大为所有端点都完全正确。该脚本验证的是这三种具体模型/端点和该类多轮工具流程，不构成所有 Responses 服务兼容性的保证。

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

- 本地行为测试覆盖 Responses 空增量与工具回执回放，以及 Anthropic Provider round-trip 和异常包装诊断。
- Anthropic 定向回归在 devserver 的 round-trip/reasoning driver 测试组共 42 项通过；历史签名与缓存前缀专门测试的结果另见前述 LLM-29 记录。
- Responses 真实模型 A/B 已按上表复测。旧链路在三种目标配置均以 HTTP 400 失败；修复链路均继续工具流程，原始任务约束最终通过 2/3。
- A/B 不执行真实搜索、不写业务数据、不记录 API 密钥或原始聊天内容。结果仅代表当晚使用的具体端点、模型和脚本输入；网络响应和模型版本变化后应重新验证。
- 本文是排查记录，不表示其他无关工作区改动已通过测试、已提交或已发布。
