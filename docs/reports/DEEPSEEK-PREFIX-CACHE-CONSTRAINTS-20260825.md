# DeepSeek 前缀缓存限制与上下文断点报告

日期：2026-08-25
范围：Gugu-web 的 DeepSeek OpenAI-compatible 请求链路
关联：`PRD-LLM-12-DeepSeek自动缓存与上下文断点专项优化.md`、`TEST-Cache-DeepSeek-MiniMax-M3-20run-20260825.md`

## 1. 结论摘要

DeepSeek 当前使用服务端自动前缀缓存，不应照搬 MiniMax/Anthropic 的显式
`cache_control` 断点策略。请求每次无状态重发完整上下文，因此能否命中取决于本次请求从
开头开始的结构和字节序列是否与服务端已有前缀一致。

当前最重要的限制不是“DeepSeek 不能缓存”，而是：

1. 缓存是前缀匹配，前面任意一处结构变化都会使后续内容无法复用；
2. 自动缓存断点由服务端决定，客户端不能指定或强制推进；
3. 目前没有确认 DeepSeek 接受或需要消息级 `cache_control`，因此不能发送未声明的显式标记；
4. 工具 schema、工具历史、消息角色、thinking 参数、图片块和动态尾部都可能改变请求序列，必须保持稳定或被诊断；
5. 当前真实测试中，DeepSeek 曾在跨 run 后固定命中约 `12,032` token；随着历史增长，缓存率从
   `78.04%` 降至 `68.10%`，说明早期前缀命中了，但缓存断点没有随工具历史继续向后推进；
6. 这不能直接归因于 provider 缓存能力不足，也不能仅凭单轮低命中断言业务组装错误，必须结合 canonical/wire/schema/tail digest 对比。

## 2. 已确认的请求约束

### 2.1 只依赖自动前缀缓存

DeepSeek 走 OpenAI-compatible 接口，当前策略为：

```text
automatic_prefix_cache = true
explicit_cache_control = false
```

因此业务层不得：

- 注入 Anthropic 风格的 `cache_control`；
- 复用 MiniMax 的显式缓存锚点函数；
- 假定自定义 role 或自定义字段能形成 provider 缓存断点；
- 为了缓存删除必要的时间、工具结果、引用、RAG 或视觉信息。

### 2.2 前缀必须字节级稳定

前缀比较不是语义相似匹配。以下变化都可能使变化位置之后的内容失去缓存：

- system、snapshot 或 history 的顺序变化；
- `system`/`user` role 改变；
- 同一消息从字符串变成 content block，或反过来；
- JSON key 顺序、空字段、换行、空格或序列化方式变化；
- 工具 schema 顺序、描述、参数 schema 或工具集合变化；
- 工具调用/结果的格式、id、配对关系变化；
- 图片从 base64 变成占位文本，或上一轮是占位文本、下一轮又恢复 base64；
- 当前轮 dynamic tail 被插入到不同位置；
- thinking、response format、tool choice 等请求参数变化；
- 服务端缓存 TTL 过期、模型路由变化或冷缓存建立。

所以“内容语义没变”不等于“缓存前缀没变”。

### 2.3 自动缓存断点不可客户端指定

DeepSeek 返回的 `prompt_cache_hit_tokens` 是当前可观察的命中量，应映射到统一 usage 的
`cache_read` 字段。客户端可以记录命中量和请求结构，但不能把它反推成一个绝对可靠的消息边界。

报告中出现的 `12,032` token 是测试样本的稳定命中量，不是 DeepSeek 官方固定缓存块大小。缓存粒度、
最小命中阈值和断点推进规则仍需以官方资料或同模型同条件实测确认。

## 3. Gugu 当前请求结构的影响

目标结构为：

```text
static system
→ session snapshot
→ baseline history / summary
→ canonical history
→ current turn
→ dynamic tail
→ provider request metadata
```

其中：

| 区域 | 对 DeepSeek 缓存的要求 |
| --- | --- |
| static system | 跨 run 保持完全不变；不要混入时间、项目、memory 或 provider 诊断 |
| snapshot | 只在 TTL、业务 revision 或压缩 baseline 更新时变化；变化后接受一次前缀重建 |
| baseline/history | 只从新 baseline 增量追加，不能每轮滑动窗口或重新排序 |
| current turn | 当前 user、assistant、tool call、tool result 保持 canonical 顺序和合法配对 |
| dynamic tail | 只能放真正 request-volatile 内容；turn-stable 内容必须有稳定 canonical 表达 |
| tools schema | 排序、字段序列化和注入集合稳定；变化必须记录 schema digest |
| 诊断字段 | 只在 LoopScope span attributes/脱敏日志中保存，不能进入 messages/tools |

## 4. 真实测试观察

`TEST-Cache-DeepSeek-MiniMax-M3-20run-20260825.md` 的 DeepSeek 20-run 样本：

| 指标 | 结果 |
| --- | ---: |
| 完成 run | 20/20 |
| 平均缓存率 | 67.08% |
| 最高缓存率 | 78.04% |
| 最低缓存率 | 0.00%（首轮冷缓存） |
| Run 3-20 固定命中 | 12,032 token |
| 输入增长 | 15,417 → 17,667 token |
| Run 3-20 缓存率 | 78.04% → 68.10% |

解释：首轮是缓存建立阶段；第二轮只命中 4,608 token；第三轮开始命中早期稳定前缀，但之后工具历史和新增消息进入 fresh 区，服务端没有表现出与 MiniMax 相同的缓存断点向后推进。

这组结果能证明“当前请求存在稳定早期前缀”，不能证明：

- DeepSeek 一定只支持单个缓存块；
- 12,032 一定是固定 4K 分块的整数倍规则；
- 工具 schema 一定是唯一断点来源；
- dynamic tail 一定是每个低命中轮次的第一处变化。

## 5. 必须重点检查的断点

每次低命中请求应按以下顺序比较上一请求和当前请求：

1. `canonical_digest`：canonical context 是否变化；
2. `system_digest` / `snapshot_digest`：稳定前缀是否变化；
3. `history_digest`：第一条变化消息、role、block shape 和工具配对位置；
4. `current_turn_digest`：新增消息是否被放到了上一轮历史之前或顺序变化；
5. `current_turn_digest`：时间、姿态、RAG 是否移动或重复注入；
6. `tool_schema_digest`：工具数量、排序、名称和 schema 是否变化；
7. 图片边界：是否出现 base64/attach_id/占位文本切换；
8. provider 参数：thinking、response format、tool choice、stream 等是否变化；
9. `wire_digest`：adapter 渲染后的最终结构是否变化；
10. 最后才考虑 TTL、模型路由和服务端缓存淘汰。

诊断只保存 digest、数量、索引、role/block shape 和 first diff index，不保存正文、工具参数、附件名、图片 URL、用户标识、token 或密钥。

## 6. 当前应采用的优化边界

### 已采用

- DeepSeek 不发送显式 `cache_control`；
- 统一走 Canonical Context → Provider Adapter；
- system/snapshot/history/dynamic tail 分层；
- 工具历史保持 canonical 配对，由 adapter 处理 provider wire format；
- 图片首轮可保留原始视觉输入，后续 round/run 折叠为稳定引用/占位结构；
- 工具 schema 使用稳定排序和稳定序列化；
- provider usage 统一记录 `cache_read`，LoopScope 只展示脱敏诊断；
- 通过 baseline/TTL/真实 provider usage 推进压缩，不用本地估算主动改变正常前缀。

### 明确不采用

- 不为 DeepSeek 增加业务层 `if provider == deepseek` 的缓存拼装分支；
- 不把 MiniMax 的单锚点或 Anthropic 的显式 marker 复制过来；
- 不为了追求缓存删除当前时间、RAG、工具结果或图片上下文；
- 不把诊断信息拼入 prompt；
- 不通过额外 LLM round 询问缓存断点；
- 不把“固定命中 12,032”硬编码成策略或预算。

## 7. 后续验证计划

1. 同一真实 session 分别比较当前多锚点、仅最新锚点和无显式锚点三种请求结构；
2. 每种策略至少运行 5 个 run，记录 first diff、schema digest、工具历史数量和 cache_read；
3. 再做 3/10/20 run 的稳定阶段统计，单独排除首轮冷缓存；
4. 对纯聊天、工具调用、Skill 注入、RAG、图片和压缩场景分别测量；
5. 同时回归 MiniMax、Qwen、Anthropic，确认 DeepSeek 诊断不会改变其他 provider 的 payload；
6. 只有当断点变化可解释且语义回归通过，才考虑启用新的 DeepSeek 专项策略。

## 8. 安全与发布要求

- 诊断不得记录完整 prompt、用户正文、工具参数、附件内容、URL、token 或密钥；
- 真实 trace 只保留脱敏统计和结构 digest；
- provider 文档未确认的行为必须标记为“待验证”，不能写成能力契约；
- 清理临时探针后再提交，正式的 digest 诊断字段可以保留。
