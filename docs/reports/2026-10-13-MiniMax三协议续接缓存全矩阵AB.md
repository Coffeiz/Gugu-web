# MiniMax 三协议、续接开关缓存 A/B 完整报告

日期：2026-10-13。状态：真实调用完成；代码保留在工作区，未提交、未重启服务。

## 结论

- Anthropic 原生续接的反思前缀破坏已修复，主矩阵加权缓存率从 37.68% 提升到 96.12%。关闭续接时两组均约 95.63%，没有同类回归。
- Chat Completions 修复重复基础 system 后，关闭续接从 0.11% 提升到 95.82%。该 driver 不支持原生续接，开关配置都实际关闭，不能宣称验证了原生续接。
- Responses 关闭续接、没有返回状态和携带真实原生状态三种路径均保留输入前缀、工具和推理参数。真实状态可以回放，但 provider 偶发冷缓存依然存在，不能承诺每次命中 96%。
- 修复针对原生快照反思；从数据库重建的后台反思没有完整主请求前缀，仍是另一条链路。

## 实验设计及隔离

使用 devserver 当前绑定的 MiniMax 配置，模型 `MiniMax-M3.1-Flash-Preview`。仅在进程内复制配置切换三种 API 和 reasoning_persistence；没有修改用户配置。Anthropic 使用对应协议入口，Chat Completions 和 Responses 使用同一供应商的兼容入口。

输入来自同一条真实历史：172 条消息、4 个工具声明、30 个原生 thinking 块。读取加密续接状态并恢复 trace 深层截断参数，重建 wire 摘要 `c4abac2b70a0171f` 与原请求完全相同。真实上下文、签名、密钥未写入报告或探针结果。

A 使用修复前的分支清洗和重复 system 行为；B 使用修复后的代码。每格两轮，第一轮 A→B，第二轮 B→A。每个实验臂以独立随机 system 标识预热主调用，再调用反思分支，避免另一实验臂直接命中同一缓存。系统标识位于前缀，因此预热本身基本冷缓存。这不是与生产延迟严格同条件的负载基准。

主调用经过实际 driver 的 prepare/run_round/原生状态恢复；反思经过 capture_reflection_snapshot 和 complete_messages，真实 SDK 请求供应商。禁止工具派发，用量写入被替换为空操作；不写记忆、会话、业务账本。不重启现有服务。

缓存率 = cache_read / (fresh_input + cache_read + cache_write)，聚合按 token 加权；不能把两次百分比简单平均。反思新增约 3.8K–4.3K 输入，本来就不能复用主调用缓存。

## 主矩阵

| API | 请求续接 | 实际续接 | A 旧逻辑 | B 修复逻辑 |
|---|---|---|---:|---:|
| anthropic | off | 否 | 95.62% | 95.62% |
| anthropic | continuation | 是 | 37.68% | 96.12% |
| openai | off | 否 | 0.11% | 95.82% |
| openai | continuation | 否 | 0.17% | 47.94% |
| responses | off | 否 | 95.69% | 95.90% |
| responses | continuation | 否 | 47.95% | 95.44% |

`openai` 指 Chat Completions。Responses 的主矩阵“开启”没有得到 reasoning item，因此实际续接否；下节另测实际原生状态。没有丢弃任何冷缓存样本。

### 所有主矩阵分支样本

| API | 续接配置 | 轮次 | 实验臂 | 总输入 | 未缓存输入 | 缓存读取 | 缓存率 | 秒 |
|---|---|---:|---|---:|---:|---:|---:|---:|
| anthropic | off | 1 | baseline | 92883 | 3825 | 89058 | 95.88% | 5.741 |
| anthropic | off | 1 | fixed | 92878 | 4302 | 88576 | 95.37% | 5.92 |
| anthropic | off | 2 | fixed | 92882 | 3825 | 89057 | 95.88% | 5.732 |
| anthropic | off | 2 | baseline | 92879 | 4303 | 88576 | 95.37% | 4.569 |
| anthropic | continuation | 1 | baseline | 92879 | 57703 | 35176 | 37.87% | 6.534 |
| anthropic | continuation | 1 | fixed | 99932 | 3824 | 96108 | 96.17% | 3.656 |
| anthropic | continuation | 2 | fixed | 99938 | 3938 | 96000 | 96.06% | 4.116 |
| anthropic | continuation | 2 | baseline | 92879 | 58063 | 34816 | 37.49% | 6.879 |
| openai | off | 1 | baseline | 112475 | 112347 | 128 | 0.11% | 6.305 |
| openai | off | 1 | fixed | 92895 | 3825 | 89070 | 95.88% | 2.117 |
| openai | off | 2 | fixed | 92894 | 3934 | 88960 | 95.77% | 5.14 |
| openai | off | 2 | baseline | 112470 | 112342 | 128 | 0.11% | 9.398 |
| openai | continuation | 1 | baseline | 112467 | 112279 | 188 | 0.17% | 13.231 |
| openai | continuation | 1 | fixed | 92898 | 3825 | 89073 | 95.88% | 3.419 |
| openai | continuation | 2 | fixed | 92895 | 92895 | 0 | 0.00% | 7.641 |
| openai | continuation | 2 | baseline | 112468 | 112280 | 188 | 0.17% | 6.275 |
| responses | off | 1 | baseline | 93300 | 3825 | 89475 | 95.90% | 4.427 |
| responses | off | 1 | fixed | 93305 | 3825 | 89480 | 95.90% | 3.877 |
| responses | off | 2 | fixed | 93301 | 3825 | 89476 | 95.90% | 3.304 |
| responses | off | 2 | baseline | 93299 | 4211 | 89088 | 95.49% | 5.24 |
| responses | continuation | 1 | baseline | 93350 | 93350 | 0 | 0.00% | 10.908 |
| responses | continuation | 1 | fixed | 93348 | 4260 | 89088 | 95.44% | 5.879 |
| responses | continuation | 2 | fixed | 93348 | 4260 | 89088 | 95.44% | 7.852 |
| responses | continuation | 2 | baseline | 93349 | 3825 | 89524 | 95.90% | 4.18 |

## 原生 Responses 续接补测

默认及显式低推理强度的长历史诊断 seed 都未返回 reasoning item。独立短计算请求的非流式调用返回 reasoning/message；独立 SSE 请求也出现 reasoning added/done（completed）及 completed.output 的 reasoning/message。因此不能把长历史没有状态归因于“流式 API 不支持”，也没有发现本次流式 driver 丢状态的证据。

使用真实非流式计算结果的一条已完成 reasoning item 作为种子，经实际 driver restore → 流式主调用 → 原生快照 → 反思分支回放。未伪造签名或 reasoning 内容。补测显式 adaptive/low，仅作用于配置副本。四个请求的主调用与分支均包含 1 条相同 reasoning item，前缀及 tools/instructions/reasoning/cache key 均一致；不使用 previous_response_id，store=false。

| API | 请求续接 | 实际续接 | A 旧逻辑 | B 修复逻辑 |
|---|---|---|---:|---:|
| responses | continuation | 是 | 95.90% | 48.02% |

| 轮次 | 实验臂 | 总输入 | 未缓存输入 | 缓存读取 | 缓存率 | 秒 |
|---:|---|---:|---:|---:|---:|---:|
| 1 | baseline | 93375 | 3824 | 89551 | 95.90% | 4.051 |
| 1 | fixed | 93375 | 3825 | 89550 | 95.90% | 4.349 |
| 2 | fixed | 93372 | 93244 | 128 | 0.14% | 26.417 |
| 2 | baseline | 93374 | 3824 | 89550 | 95.90% | 8.116 |

B 第二轮只命中 128 token，耗时 26.417 秒；所有已检查的请求前缀和状态仍一致。这说明请求一致不能保证 provider 每次路由到热缓存；本次实验不能确定其内部路由、缓存驱逐或匹配规则。A/B 在 Responses 中没有不同的修复逻辑，不应据偶发样本得出修复降低 Responses 缓存的结论。B 原生状态一热一冷，必须如实保留。

## Chat Completions 完整 wire 与重复请求检查

补测一次完整 request：A 第一条消息就不同（重复 system），命中 0.17%；B 第一条相同，语义前缀相同，命中 95.88%。B 完整 wire 在第 169 条出现 list/string 差异：主调用添加缓存锚点把字符串转为单 text block，而快照保留标记前表示。它发生在历史尾部，没有复现早期基础前缀破坏；仍是潜在缓存形态差异，未证明是偶发 0 命中的原因。

对 A 和 B 分支各重复完全相同请求，均命中约 99.999%（仅 1 token 未缓存）。A 的低命中是相对主请求而言，自己预热后也可命中。主矩阵 B 开启配置第二轮 0 缓存、Responses A 开启配置第一轮 0 缓存，以及原生 Responses B 第二轮低命中，都未删除。

JSON 主矩阵 system_equal 比较顶层 system/instructions；Chat 中两者缺省，不能用该标志判断 system 一致。Chat 应依据 first_difference 和本补测 first_message_equal。

## 成功范围、调用成本与限制

主矩阵 49 次 SDK 请求、24 次分支成功；Chat 严格检查 6 次；显式 low 长历史补测 9 次；真实原生 Responses 补测 9 次；独立非流式与 SSE 能力检查各 1 次，合计 75 次完成的补充/矩阵 SDK 请求，未出现协议 4xx/5xx。此前修复实验另计；早期探针缺少 SDK stream 包装的方法错误在正式矩阵前已排除，不计入有效样本。

显式 low 长历史补测四次分支均约 95.56%–95.91%，但 seed 无状态，不能充作原生续接覆盖。所有实验串行，没有并发压测；每臂两次不能形成统计显著性或长期缓存 SLA。当前账户、当前模型结论不能外推到所有供应商/模型。

本次没有增加生产补丁：沿用已实现的 Anthropic 原生 thinking 保留及 Chat 基础 system 去重。相关串行行为回归 233 项通过，另有 helper 提取后 18 项定向回归通过。Responses 现有原生快照回归覆盖续接开/关、ID、工具声明和 store=false；真实调用补齐实际 provider 验证。

后续应分别观察缓存率和是否有效续接，避免仅按配置开关划分；数据库重建反思需要独立方案，不能通过关闭推理或删除签名掩盖。暂不根据偶发冷缓存增加自动重试、强制思考或兼容兜底。

## 数据与关联记录

数值、前缀比较和预热用量完整保存于 [实验指标 JSON](./MiniMax-API-Cache-AB-2026-10-13.json)。其中不含请求正文、真实账号、签名、密钥及环境地址。

先前根因和两条原生历史实验见 [缓存策略报告](./OPT-Cache-Strategy-2026-10-13.md)；修复及回归见 [开发记录](../devlog/2026-10-13-记忆反思原生推理前缀缓存修复.md)。
