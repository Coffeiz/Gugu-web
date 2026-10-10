# INVEST：MiMo Cache read 未随稳定前缀逐轮增长

> 排查日期：2026-10-10
> 排查对象：MiMo Responses API 的多轮缓存用量
> 排查依据：用户提供的 LoopScope trace 与当前适配器实现
> 排查目的：判断第三轮 Cache read 未增长是否由本地上下文重建造成

---

## 现象

Trace 中第二轮输入约 45.4k tokens，Cache read 为 35,776；第三轮输入约 45.9k，Cache read 仍为 35,776。后续轮次 Cache read 又增长至 40,960、73,728，并非严格逐轮单调增长。

## 核查结果

- 第二轮开头的 29 个应用消息对象与第三轮对应前缀一致；第三轮消息也完整延续到第四轮。System 指令和工具定义指纹没有变化，未发现本地删减或重排历史前缀的证据。
- 本地“稳定前缀 token 估算”不是 Provider 的缓存计量值，两者使用的 tokenizer 和统计口径可能不同，不能用估算值推导 Cache read 应增加多少。
- 当前 MiMo 适配器未声明咕咕侧主动 Prompt Cache 控制能力；Responses 请求不会由咕咕指定 `prompt_cache_key`。Trace 中的 Cache read 是 Provider 返回的实际 usage，因此命中与否由服务端缓存策略决定。

## 结论

现有证据不支持“本地每轮没有完整沿用上一轮前缀”这一判断。Cache read 第二、三轮持平更符合 Provider 返回值并非稳定前缀长度或单调进度的表现。仅凭这份 trace，无法进一步确认 MiMo 服务端具体为何未增加命中量，也不能据此认定为服务端故障。

MiMo 文档将 `cached_tokens` 描述为缓存命中的输入 token，但没有承诺逐轮单调增长或给出可由客户端控制的缓存生命周期规则：[Responses API](https://mimo.mi.com/docs/zh-CN/api/chat/responses)、[按量计费说明](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)。

## LoopScope 可读性改进

为避免把本地估算误读成 Provider 缓存进度，相关诊断字段已使用 `stable_prefix_tokens_estimate` 命名；详情卡分别展示“稳定前缀估算”和“Provider 实际 Cache read”，并说明两者口径不同。兼容读取旧 trace 字段。定向后端测试、LoopScope 前端类型检查与生产构建均已通过。

## 后续验证

若要判断是否存在 MiMo 服务端异常，应在相同模型、相同会话前缀下重复采样多轮 usage，并记录请求关联标识；当前公开文档和单份 trace 不足以定位服务端缓存决策。
