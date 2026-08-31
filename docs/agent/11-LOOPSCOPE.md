# LoopScope 开发观测与排障

LoopScope 是 Gugu 的 AgentLoop 开发观测工具。它不参与业务决策、不改变 Agent 请求，也不承担生产业务数据的事实来源；它把一次 Run 的执行过程、上下文来源、Provider 用量和代码位置整理成可比较的诊断记录，帮助开发者回答：

- 这次请求实际经过了哪些 Round、Tool、Guard 和 Context Source？
- 模型收到的输入是在哪里变长、变形或打断稳定前缀的？
- cache read 下降是 Provider 没命中，还是本地输入前缀已经发生变化？
- 某个 Prompt、Memory、RAG、Schema 或历史包装来自哪里，改动后是否进入了本轮？
- 一个问题是在 Agent 内部发生，还是在渠道、事件、数据库或外部 Provider 边界发生？

## 1. 定位与边界

LoopScope 服务于开发、回归和真实运行诊断，当前由独立 TypeScript Collector、SQLite 和 Vue 前端组成。Gugu 仍由 Python/FastAPI、Python Agent/Worker 和 Python IM 网关运行；Gugu 侧只保留可关闭的 trace bridge。

```text
Gugu Agent / IM / Web
        |
        | 结构化的 Run snapshot（允许开发正文）
        v
LoopScope trace bridge
        |
        | HTTP POST，短超时，失败静默
        v
TypeScript Collector -> SQLite -> LoopScope Vue
```

LoopScope Collector 不在 Agent 主链路上。Collector 不可达、写入失败或 SQLite 暂时不可用时，不能阻塞回复、工具执行、消息落库或渠道发送。

以下内容不属于 LoopScope 的职责：

- 不替代 Gugu 的 canonical history、PostgreSQL、Redis event bus 或业务审计；
- 不把 LoopScope 登录 Token、Cookie 或 Provider API Key 写入 trace；开发 trace 可以保留正文和工具参数，但不能混入普通诊断日志；
- 不通过 trace 重新执行工具，不通过 UI 修改 Agent 运行状态；
- 不把 Provider 返回的 cache read 当成“缓存一定命中”的业务事实；它只是观测值。

## 2. 一次 Run 的观测模型

```text
Session
  └─ Run
      ├─ Context Source spans
      ├─ LLM round 1
      │   ├─ Tool / Guard spans
      │   └─ Tool result
      ├─ LLM round 2
      └─ Final output / error / cancelled
```

### 2.1 Session

Session 是 LoopScope 的导航和比较范围，使用 `session_key` 区分来源与外部会话。Web、IM、定时任务等路径可以使用不同的 source，但不能仅凭标题或用户昵称判断它们是不是同一会话。

### 2.2 Run

Run 对应一次 Agent 执行生命周期，包含：

| 字段 | 用途 |
|---|---|
| `id` / `trace_id` | 定位一次执行及跨进程关联 |
| `session_key` / `external_session_id` | 关联 Gugu 会话 |
| `status` | `running`、成功、失败、取消等最终状态 |
| `started_at` / `ended_at` / `duration_ms` | 时间和性能诊断 |
| `input` / `output` | Run 级摘要，不替代完整业务历史 |
| `usage` | 汇总 input、output、cache read/write、fresh input 和 total |
| `attributes` | cache、canonical event、adapter 和上下文布局等结构化诊断 |

非 Web 路径通过 `restore_trace()` 恢复跨进程 trace，并在结束时异步提交 snapshot。trace 上报失败不能改变主链路结果。

### 2.3 Span

Span 是 Run 内一个可定位的步骤。常见类型包括：

| Span 类型 | 关注点 |
|---|---|
| `context` | Prompt、Memory、DB loader、RAG、snapshot、最终 Provider 输入布局 |
| `llm` | 每个 Round 的输入、输出、工具调用和 Provider usage |
| `tool` | 工具调用参数形状、结果摘要、耗时和父子关系 |
| `guard` | Schema、意图、确认和决策守卫 |
| `database` / `memory` / `file` | 数据读取来源和写入边界 |
| `history` / `cache` / `state` | 历史包装、缓存断点和运行状态 |
| `output` | 渠道或 Web 输出阶段 |

每个 Span 保留 `parent_span_id`、`ordinal`、状态、时间、输入/输出摘要、`code` 和 `attributes`。父子关系用于判断“工具失败”是在调用前、执行中还是结果回写后发生的。

## 3. Context Provenance

Context Provenance 解决“模型为什么看到这段内容”的问题。Gugu 侧在 Context Assembly、Prompt 加载、Memory/RAG 读取和 Provider 边界记录结构化 source span，LoopScope 展示以下关系：

```text
数据库 / 文件 / Memory / RAG / Prompt Markdown
                  |
                  v
          Context Assembly
                  |
        stable prefix + dynamic tail
                  |
                  v
          Provider input messages
```

Context Source 可以记录完整正文、来源类别、长度、token 估算、digest、是否包含以及代码位置。LoopScope 是开发诊断工具，Input、Output、Context 和 Tool 面板需要直接查看真实组装结果；这些内容属于受控开发数据，不应复制到普通日志、用户可见错误或业务审计记录。

当前可见的诊断信号包括：

- Prompt 文件、Memory、DB loader、RAG 和工具 Schema 是否参与组装；
- source tokens 与 included tokens 的差异，判断预算裁剪；
- system 的 location、digest 和是否复用上一 Round；
- Provider 实际收到的消息数量、首尾形状、序列 fingerprint 和 system fingerprint；
- 当前上下文的 canonical layout、context epoch、snapshot hash 和应用边界；
- 工具 Schema digest、Schema 错误类别和参数形状。

## 4. Prefix Diff：快速定位前缀变化

Prefix Diff 是 LoopScope 用来解释 cache 变化的核心功能。它不比较“看起来相似的文字”，而是比较两次 Provider Input 中按顺序排列的消息结构，优先判断最早发生变化的消息位置。

### 4.1 比较对象

- 当前 Round 与同一 Run 的上一 Round 比较；
- Round 1 没有同 Run 上一 Round 时，与上一个 Run 的最后一个 LLM Round 比较；
- 没有可比较的输入、消息数量不同或前缀无法对齐时，明确显示无法比较，不伪造稳定结论。

### 4.2 比较步骤

1. 取两次 LLM Span 的 `input.messages`。
2. 从第 0 条开始按稳定 JSON 结构比较，忽略对象键顺序，不忽略数组顺序。
3. 找到第一条不相同的消息，记录 `index`、上一轮形状、本轮形状和变化原因。
4. 同时读取 Context Assembly 中的 `prefix_integrity`，区分“本地前缀稳定”与“已经断开”。
5. 在 Input 面板标记该消息，并提供“定位到 Input”和“对比上一轮 Input”。

当前变化原因包括：

| 原因 | 含义 |
|---|---|
| `wrapper_changed` | 同一语义被不同 wrapper、摘要或 reminder 包装 |
| `role_changed` | `system`、`user`、`assistant`、`tool` 角色变化 |
| `block_shape_changed` | 字符串与 content blocks、附件块或工具块结构变化 |
| `content_kind_changed` | compacted summary、system reminder 等内容类别变化 |
| `content_changed` | 消息结构相同但正文或字段发生变化 |
| `message_count_changed` | 消息数量变化，无法继续保持同一位置映射 |

### 4.3 诊断字段

`cache_diagnostics` 记录脱敏的缓存结构信息：

```json
{
  "cache_supported": true,
  "conversation_messages": 18,
  "cache_anchor_count": 1,
  "cache_anchor_last_index": 4,
  "cache_anchor_tokens_estimate": 3200,
  "cache_prefix_digest": "...",
  "stable_message_count": 5,
  "stable_prefix_digest": "...",
  "tool_count": 12,
  "tool_schema_bytes": 18400,
  "tool_schema_tokens_estimate": 4600,
  "tool_schema_digest": "..."
}
```

这些字段回答的是“本地组装结构是否改变”，不是“Provider 一定会如何缓存”。`digest` 是比较指纹，不是可逆正文；`tool_schema_digest` 变化通常意味着工具目录或 Schema 进入了新的缓存边界。

### 4.4 Cache 率下降排查顺序

看到 Round 1 的 cache 率比上一 Run 最后一 Round 低时，按以下顺序排查：

1. 对比 `cache_read`、`input`、`fresh_input`，先确认是绝对命中量下降还是输入总量变大。
2. 打开 LLM Span 的 `Earliest input change`，查看第一变化消息的 reason 和两侧内容形状。
3. 打开 `Assembly`，比较 system location、system digest、复用 Round 和消息数量。
4. 打开 `Diagnostics`，检查 `prefix_integrity.stable`、`stable_prefix_digest`、anchor index、tool schema digest 和 volatile image。
5. 检查第一变化点之前是否出现动态时间、请求 ID、随机后缀、不同顺序的工具 Schema、不同角色包装或新注入的 RAG/Memory。
6. 再检查 Provider 的 `cache_mode` 和 capability：主动缓存、被动缓存和不支持缓存不能用同一套阈值解释。
7. 最后用同一模型、同一会话类型和同一输入做 A/B；不要把跨 Provider、跨模型或跨上下文预算的结果直接比较。

常见判断：

| 现象 | 优先怀疑 |
|---|---|
| `first_diff` 很靠前且 `prefix_integrity=false` | Prompt/system/snapshot 包装变化 |
| `first_diff` 在工具 Schema 附近 | 工具目录顺序、Schema digest 或注入模式变化 |
| 本地 digest 不变但 `cache_read` 下降 | Provider 缓存策略、模型能力、TTL 或服务端状态 |
| `input` 增大、`fresh_input` 增大但前缀稳定 | 新动态尾部、历史增长或 RAG 注入变大 |
| 有 volatile image 且变化点靠近附件 | 图片/多模态内容导致缓存边界改变 |
| cache 为 0 且 `cache_mode=none` | 模型或 adapter 本身不支持当前缓存模式 |

## 5. Token Usage 语义

LoopScope 对不同 Provider 的 usage 做观测层归一，不改变 Agent core 的原始 usage：

```text
input       = 本轮输入总量
cache_read  = Provider 报告的缓存读取量
fresh_input = input - cache_read（按 Provider 格式校正）
total       = input + output
cache_ratio = cache_read / input
```

Anthropic 风格的 `input_tokens` 与 `cache_read_input_tokens` 分列，LoopScope 会合并为可比较的 `input`；OpenAI/DeepSeek 风格的 prompt tokens 可能已经包含 cache hit，不能再次相加。UI 同时显示 usage 来源是 Provider reported 还是 local estimate。

Provider 能力至少分为：

- `active`：adapter 会设置显式缓存控制或模型支持主动缓存；
- `passive`：服务端可能自动缓存，但 API 不提供可靠命中统计；
- `none`：当前 Provider/模型不应发送主动缓存参数。

因此，cache ratio 只能在相同模型、相同 Provider、相同 cache mode 和相近输入规模下做趋势比较。

## 6. 上下文工程与工具观测入口

LoopScope 只负责观测，不维护上下文工程或工具 Schema 的完成度结论。权威内容归位如下：

- 上下文组成、Canonical Assembly、稳定前缀/动态尾部、压缩、baseline 和缓存边界：见 [04-CONTEXT-ENGINEERING.md](./04-CONTEXT-ENGINEERING.md)。
- 工具 Schema 的简介/全量模式、注入成本、准确率和 A/B 结果：见 [PRD-LLM-16](../prds/【已完成】PRD-LLM-16-工具SCHEMA语义显式化与注入优化.md) 与 [工具 Schema 优化实施报告](../reports/2026-08-29-OPT-LLM-16-TOOL-SCHEMA-BASELINE.md)。
- MiniMax、GLM 与 DeepSeek 的实际缓存率、稳定阶段和 Provider 差异：见 [2026-08-26 20 轮缓存测试报告](../reports/2026-08-26-TEST-CACHE-MINIMAX-GLM-DEEPSEEK-20RUN.md)。

LoopScope 中对应的观测入口是 Context Provenance、Token Usage、Cache Diagnostics 和 Prefix Diff；它们用于验证上述文档描述的实现是否在实际 Provider 输入中成立。

## 7. 用 LoopScope 开发咕咕

### 7.1 新功能开发

1. 先打开 Gugu `/dev` 并确认 LoopScope bridge 已连接。
2. 只做一个最小请求，记录 Session、Run、模型和渠道。
3. 先看 Run 状态与 Round 数，再展开 Context、LLM、Tool 和 Output。
4. 确认新增 Prompt、Memory、RAG 或工具 Schema 出现在正确的 Context Source 中。
5. 检查最终 Provider Input，而不是只看本地 builder 的中间对象。
6. 用同一请求重复运行，比较 prefix digest、cache usage、Round 数和工具调用次数。

### 7.2 Prompt/Context 修改

修改 Prompt、人格、历史包装、RAG 或 Memory 时，至少保存修改前后两条 Run：

| 检查项 | 目的 |
|---|---|
| system digest | 确认稳定系统内容是否真的改变 |
| first diff | 确认变化从预期位置开始，而不是提前污染前缀 |
| message representation | 确认字符串、blocks、summary、tool pair 没有意外切换 |
| stable prefix digest | 确认改动没有影响不相关的稳定内容 |
| prompt growth / token impact | 确认新增内容成本可接受 |
| cache read / fresh input | 判断性能影响是否与结构变化一致 |

### 7.3 工具和 Schema 修改

工具问题先看 `Tool`、`Guard` 和 `Schema` Span：

- 工具没有出现：检查 capability selector、工具注入模式和权限边界；
- 工具出现但参数错误：打开 Schema error，看 `tool_name`、`error_kind`、Schema digest 和 arguments shape；
- 工具成功但模型重复调用：比较 Round 之间的 tool call/result 配对和 canonical history；
- 工具副作用重复：检查 Run 是否重试、工具 `mutates` 元数据、确认门和外部幂等键；
- 工具描述变更导致 cache 下降：比较 `tool_schema_digest` 和第一变化点，不要只看工具数量。

### 7.4 压缩和历史修改

压缩问题应同时看 `Context`、`History`、`Cache` 和 LLM Span：

- baseline 更新是否产生新的 snapshot hash；
- 压缩前后 system/snapshot 是否仍处于稳定前缀；
- tool call 与 tool result 是否保持原子配对；
- 动态尾部是否被错误写入 canonical history；
- 压缩失败是否保留原 history，是否出现无工具的多余续轮；
- Round 1 与上一 Run 最后一 Round 的比较是否因为历史裁剪失去可比性。

### 7.5 渠道和 IM 问题

LoopScope 不是渠道抓包工具，但可以用 trace 分层定位：

```text
Gateway 入站 -> Agent Input -> Context -> LLM/Tool -> Output -> Gateway 出站
```

如果 Agent Input 没有消息，查 Gateway/Redis/worker；如果 Input 正常但没有输出，查 LLM/Tool/Guard；如果 Output 正常但用户没收到，查渠道发送和平台响应。不要用“LoopScope 有 Run”推断平台一定已经收到消息。

## 8. 导出、比较与数据使用

Run 支持多选导出。导出保留原始 Span，并附加按 Round 组织的索引，便于离线比较不同实现；Round 摘要不替代原始 Span，也不重复复制所有工具结果。

建议比较顺序：

1. 同一 Session 的相邻 Run：看真实输入变化和缓存趋势；
2. 同一 Run 的相邻 Round：看工具调用是否改变后续输入；
3. 同一功能改动前后：固定 Provider、模型、渠道、上下文规模和测试输入；
4. 真实用户故障与最小复现：先用 fingerprint 建立关联，再在受控界面查看正文。

导出和截图前应检查：

- 是否把开发 trace 导出到了不受控位置；正文、附件名和群成员昵称允许出现在受控 trace，但不应进入普通日志；
- 是否包含 LoopScope 登录 Token、Cookie、Provider API Key 或工具认证信息；这些凭据绝不能进入 trace；
- 是否把内部 trace ID 当作用户可见 ID；
- 是否把诊断估算值描述成 Provider 真实值；
- 是否把未完成 Run 当成成功行为。

## 9. 现有实现与目录

```text
loopscope/
├─ apps/collector/              # TypeScript Collector HTTP API
├─ packages/contracts/          # Trace 输入契约和 Zod 校验
├─ packages/db/                 # Drizzle SQLite 数据访问
├─ packages/storage/            # Trace 存储和查询
└─ frontend/
   ├─ src/components/SessionMonitor.vue  # Session/Run/Span 观测
   ├─ src/components/TraceSpanCard.vue   # Context、Input、Diff、Schema 详情
   ├─ src/services/api.ts                # Collector API client
   └─ src/utils/runExport.ts             # Run/round 导出

backend/agent/runtime/
└─ loopscope_trace/
   ├─ state.py                   # Run/Span、usage、snapshot 上报
   ├─ hooks.py                   # Agent/LLM/Tool/Context hook
   └─ utils.py                   # JSON 序列化、token 估算、cache diagnostics
```

常用配置：

| 配置 | 作用 |
|---|---|
| `LOOPSCOPE_ENABLED` | Gugu 侧是否启用 trace bridge |
| `LOOPSCOPE_ENDPOINT` | Collector 接收地址，默认 `http://127.0.0.1:4320` |
| `LOOPSCOPE_DB_PATH` | Collector SQLite 路径 |
| `LOOPSCOPE_HOST` / `LOOPSCOPE_PORT` | Collector 监听地址和端口 |

LoopScope 前端默认通过 `/loopscope-api` 访问 Collector，开发时由 Vite 代理到 `127.0.0.1:4320`；不要把 Collector 地址写入用户可见 URL 以传递认证信息。

### 9.1 认证边界

LoopScope 有两条不同的链路：

```text
LoopScope 前端 --Bearer Gugu 登录 Token--> Gugu API（读取受保护的 session/message）
Gugu bridge   --结构化 trace--> LoopScope Collector（开发数据写入）
```

- 前端从 Gugu `/dev` 通过 `postMessage` 完成 bootstrap，Token 只放在当前浏览器的 `sessionStorage`，用于请求 Gugu API；不放进 URL、trace payload 或 Collector SQLite。
- Collector 当前默认绑定本机地址，接收 Gugu bridge 的 trace；它不需要把 Gugu 登录 Token 写入每条 Run。若 Collector 暴露到非本机网络，应在部署层增加独立认证和网络访问控制。
- Trace 可以包含完整开发上下文，但访问权限依赖 LoopScope 入口、Collector 网络边界和开发环境数据目录，不能把它当作脱敏数据或生产审计数据。

## 10. 验证与测试

### 10.1 Collector

```bash
cd loopscope
pnpm test
pnpm --filter @loopscope/collector build
```

重点验证：Trace payload Zod 校验、超大 payload 拒绝、sessions/runs/spans 分页、SQLite migration、CORS 和关闭时 store 正常释放。

### 10.2 Gugu bridge

```bash
cd backend
pytest -q tests/test_loopscope_usage.py \
  tests/test_loopscope_trace_restore.py \
  tests/test_loopscope_tokenizer.py \
  tests/test_context_audit.py
```

重点验证：usage 不重复计算、Provider 格式归一、跨进程 trace restore、取消/生成器关闭、无 Collector 时主链路仍成功、日志不写敏感正文。

### 10.3 Prefix Diff 回归

Prefix Diff 相关回归至少覆盖：

- 完全相同的 messages 不产生 diff；
- 仅正文变化时定位 `content_changed`；
- 字符串与 blocks 切换时定位 `block_shape_changed`；
- summary、system reminder、role 变化分别得到可解释原因；
- 消息数量变化不会越界；
- Round 1 能回退比较上一 Run 最后一个 LLM Round；
- 没有 previous span 时仍能正常查看当前 Input；
- cache diagnostics 只含长度、数量、位置和 digest，不含完整正文。

### 10.4 运行时验证

代码测试通过后，仍要在 LoopScope UI 验证：

1. `/dev` 能打开 LoopScope 且显示 Gugu connected；
2. 发起一条普通请求后出现 Session、Run 和 LLM Span；
3. 使用工具时能看到 Tool/Result/下一 Round 的父子关系；
4. 修改 Prompt 或 Schema 后，Input 面板能定位最早变化点；
5. Collector 停止时 Gugu 请求仍能完成；
6. 重载页面后，Run、usage 和 Span 仍能从 SQLite 读出。

## 11. 已知限制与后续方向

- Prefix Diff 是本地结构比较，不是 Provider 内部缓存断点的直接证明；服务端 TTL、缓存容量和模型策略仍需结合真实 usage 判断。
- 当前比较以同一 Run 的上一 Round、或上一 Run 最后 LLM Round 为主，尚未提供任意两个 Run 的独立可视化 diff 工作区。
- Trace snapshot 是开发诊断副本，不保证覆盖进程崩溃前最后一个微秒级事件；业务最终状态仍以 Gugu canonical history 和数据库为准。
- Provider usage 字段可能缺失或只提供估算；UI 必须显示数据来源，不能把估算当精确计费数据。
- 需要继续补充跨渠道 Run 关联、Context Source 可筛选视图、任意 Run A/B diff、cache 变化自动归因和受控导出检查。
