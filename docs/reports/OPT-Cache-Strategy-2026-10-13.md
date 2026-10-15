# 真实 run 的记忆反思缓存前缀修复与 A/B

## 结论

在 devserver 使用两条真实 MiniMax-M3.1-Flash-Preview / Anthropic run 的请求数据完成隔离回放。主请求恢复历史原生 `thinking/signature`，反思却再次无条件删除它们，导致第 6 条消息处前缀断开。保留同模型 wire 快照的原生推理块后，两组实测缓存率分别由 37.88%、0% 提升至 96.18%、96.60%。

这证明同模型快照分支的前缀一致性修复有效；不是后台数据库重建路径的缓存保证，也不代表业务面板整体缓存率已恢复至 96%。运行中服务未重启，历史用量不会被追溯修改。

## 原故障统计核对

用户提供的场景统计为 7 次调用、416.8K 输入、5.7K 输出、33.4% 缓存率。业务数据库与 LoopScope 的实际值为 416,843 完整输入、5,690 输出、139,276 缓存读取。

| 路径 | 调用数 | 完整输入 | 缓存读取 | 缓存率 |
|---|---:|---:|---:|---:|
| 长会话 Owner 快照反思 | 3 | 266,119 | 105,224 | 39.54% |
| 较短会话 Owner 快照反思 | 1 | 41,111 | 33,488 | 81.46% |
| 后台历史重建反思 | 3 | 109,613 | 564 | 0.51% |
| 合计 | 7 | 416,843 | 139,276 | 33.41% |

场景统计按所有调用的 token 加权，包含 Owner、群与成员记忆反思。后台三次调用均未携带原主请求的工具声明，system/history 重新组装，每次只有 188 token 缓存读取。本次没有改变这条重建路径。

## 修复责任边界

- `backend/agent/loop_drivers.py` 的主 Anthropic driver 恢复加密续接状态中的原生推理块，随后捕获不可变 Provider 快照。
- `backend/agent/context/provider_runner.py` 的分支入口调用 `sanitize_anthropic_branch_history()`；旧实现删除快照中所有 `thinking`，首处原生推理块后的缓存失配。
- 修复后的分支保留原生 `thinking/signature` 与 `redacted_thinking`，仍清理 OpenAI 专属 `reasoning_content`、空消息及孤立工具事件。
- `strip_thinking_blocks()` 默认语义保持原来的完整清理；只有同路由分支显式开启原生块保留。Provider/格式切换的历史清理、模型身份校验与加密续接状态失效规则保持既有边界。

## 真实数据重建与实验控制

1. 只读打开 LoopScope SQLite，读取真实 run 最后一个 LLM round 的 system、消息和缓存锚点。两组分别为 172、205 条消息，均有 4 个工具声明。
2. Trace 中一个深层工具参数存在 `<max-depth>` 展示截断；从该 run 所属会话的持久化工具调用中恢复参数，按原 JSON 类型解析。
3. 只读解密所属会话的 Provider 续接状态，分别恢复 30、40 个原生 thinking 块。未调用会更新状态时间的服务加载方法。
4. 按原 run 的锚点恢复消息后，重算 wire digest。两组分别精确匹配 `c4abac2b70a0171f`、`96458da3bfd8ffae`；不匹配或模型、工具 schema 改变时拒绝真实调用。
5. A/B 每个 arm 使用不同的随机诊断 system 前缀，先用原生主请求历史预热，再发反思分支，避免两臂彼此预热。除隔离标记外，system、模型配置、工具声明与反思 delta 相同。
6. A 复现修复前清洗；B 经过修改后的正式 `provider_runner.complete_messages()`。反思 delta 使用当前反思规则与 JSON 输出契约，限定最近回合；历史反思只保存缓存探针，因此不声称恢复当时记忆状态或历史反思 delta。
7. 预热尾部追加禁止工具调用的诊断指令；SDK 返回的任何工具请求均不派发。账本写入被隔离，未更新记忆、会话、用户运行配置或 Provider 状态；正文和签名未落盘。
8. 每次输出预算由正式 `output_budget()` 归一为 4,096 token；预热输出为 2–4 token，反思输出为 379–567 token。实验串行执行。

## Provider 实测结果

缓存率 = `cache_read / (fresh_input + cache_read + cache_write)`。全部用量来自 provider 返回，未使用本地 token 估算。

| 真实前缀 | 组 | 完整输入 | 未命中输入 | 缓存读取 | 缓存率 | 首条改写消息 |
|---|---|---:|---:|---:|---:|---:|
| 172 消息 / 30 个 thinking | A 旧清洗 | 92,871 | 57,693 | 35,178 | 37.8783% | 6 |
| 172 消息 / 30 个 thinking | B 保留原生块 | 99,918 | 3,817 | 96,101 | 96.1799% | 无 |
| 205 消息 / 40 个 thinking | A 旧清洗 | 103,263 | 103,263 | 0 | 0% | 6 |
| 205 消息 / 40 个 thinking | B 保留原生块 | 112,255 | 3,817 | 108,438 | 96.5997% | 无 |

B 保留原生推理块，完整输入比 A 大，但两组未命中输入合计从 160,956 降至 7,634，降低约 95.26%。第二组 A 未命中公共前缀，显示 provider 缓存仍存在波动；两组 B 都稳定保留历史前缀。本实验不据此承诺其他模型、过期缓存或重建历史的命中率。

## 回归与收尾

- 新增两个行为回归：实际分支 SDK payload 保留原生推理与签名，且不修改源快照；修复孤立工具结果时保留合法原生块并清除外协议推理。
- 修复前两个用例均失败，修复后通过。已有跨 Provider 历史清理断言未放宽。
- 本地定向回归 98 项通过；devserver 串行运行 Provider 历史、Anthropic 协议、ContextBranch、反思快照/BYOK、缓存边界、压缩、Knowledge 与推理状态相关回归，227 项通过。
- 临时回放脚本和请求探针已删除，仅保留生产修复、合成回归测试与本报告。未重启服务或触发 CI。

## Responses 与关闭续接的扩展复查

后续复查覆盖 6 组请求级用例：

| 协议/状态 | 验证结果 |
|---|---|
| Responses，续接开启 | 主驱动 SDK input 经快照进入反思后保持完整前缀，原生 encrypted reasoning、function-call ID 和结果未丢失；instructions、tools、reasoning 参数、store 策略与缓存路由 key 一致。 |
| Responses，续接关闭 | input 前缀保持一致，不补入私有 reasoning 状态；仍走完整历史，未依赖 previous_response_id。 |
| Anthropic，续接关闭，默认思考 | 对比主驱动与反思实际请求，排除缓存标记后文本和工具前缀一致；不凭空补入 thinking。 |
| Anthropic，续接关闭，关闭思考 | 同上，system、工具声明和 thinking 请求参数也保持一致。 |
| Chat Completions，关闭续接，字符串 system | 发现并修复基础 system 重复插入问题；已有基础人格与会话快照的前缀原样保留。 |
| Chat Completions，关闭续接，text block system | 同样修复重复 system，保留 block 内容与顺序，不修改源快照。 |

Chat Completions 主请求的 wire 历史已经包含基础 system。旧 `_branch_projection()` 仍无条件插入一次基础 system，后续合并会在第一条消息处重复人格内容。现仅在前缀未携带该基础 system 时补入。Responses 使用独立 instructions 组装，不走此插入路径，未发现相同重复问题。

新增用例位于 `backend/tests/agent/context/test_branch_request_prefix.py`。Responses 与 Anthropic 用例实际执行主驱动、快照捕获及反思发送，拦截 SDK 请求验证契约；Chat 用例从不可变 wire 快照执行正式分支发送。未用源码字符串断言代替 payload 验证。

6 组扩展用例通过；devserver 串行相关回归更新为 **233 passed**。这一轮是协议 payload 与状态隔离回归，不是 Responses 的真实 provider 缓存 A/B，不能据此承诺其缓存率数值。
