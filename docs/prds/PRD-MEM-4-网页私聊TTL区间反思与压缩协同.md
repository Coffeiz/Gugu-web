# PRD-MEM-4：网页与私聊 TTL 区间反思及压缩协同

> 状态：待实施；方案草案待评审
> 创建：2026-09-22
> 最近更新：2026-09-22
> 关联模块：`backend/agent/memory/`、`backend/agent/context/`、Agent/Admin 反思阈值配置
> 背景参考：PRD-IM-11、PRD-LLM-27、PRD-AGENT-5

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 网页/私聊基于 4 分 30 秒 TTL 的区间反思 | 🔲 待评估 | 当前 PRD 方案尚未实施；现有轮数阈值仍需核对并清理。 |
| 压缩调用协同产出摘要与反思候选 | 🔲 待评估 | 尚未接入同一次 provider 调用及独立持久化。 |
| 群消息 50 条阈值 | ✅ 已完成 | 本需求要求保留现有群级、群友批量及群内 Owner 行为。 |

## 1. 背景与目标

网页和私聊当前同时使用轮数阈值与 4 分 30 秒闲置收束触发反思。轮数阈值会在会话持续活跃时提前冲刷缓冲；而会话压缩生成的 baseline 摘要不等于长期记忆反思。目标是由 TTL 闲置收束和压缩协同共同保证覆盖：每次反思都对应可冻结、可重试的精确消息区间；压缩时在同一次模型调用中产出压缩摘要与尚未反思区间的 Memory 候选。

本方案必须同时保证：消息不漏反思、已反思区间不重复提取、压缩 baseline 与 TTL 水位保持一致、历史前缀不被改写以尽可能复用 provider cache。缓存命中率受 provider 行为影响，不作绝对保证。

明确不做：

- 不将 TTL marker、游标、区间 ID 或反思任务写入 canonical history。
- 不裁剪、重排、改写或规范化既有历史消息来标注反思区间。
- 不把压缩摘要当作长期记忆，不以压缩成功代替反思成功。
- 不改变群消息 50 条阈值、群记忆主体边界和群内 Owner 语义。
- 不批量改写 `backend/config.override.json`、`.env` 等用户运行配置；旧网页/私聊阈值字段停用后由用户自行决定是否清理。

## 2. 功能需求

### FR-MEM4-01：网页与私聊 TTL 闲置反思

符合反思范围的已完成会话活动更新隐藏活动时间和消息水位，并重置 4 分 30 秒闲置窗口。窗口到期后冻结高水位并创建幂等任务；任务只处理最后一次成功反思水位之后至冻结高水位之间的消息。窗口到期与新消息并发时，必须重新校验活动代次，不能提前结算新消息。

### FR-MEM4-02：反思区间与失败恢复

反思任务冻结实际首尾消息 ID 和高水位。成功写入或经过验证的合法空增量才推进水位；失败、超时、输出无效或写入失败时保留原区间并退避重试。任务重复投递或 worker 重启不得造成重复写入、漏项或范围漂移。每个区间仅属于一个 session/scope。

### FR-MEM4-03：压缩反思仅覆盖最后 TTL 之后的增量

压缩请求捕获最近一次成功 TTL 反思水位及本次冻结高水位。反思提示词明确要求只从“最近一次成功 TTL 反思之后、此次压缩冻结高水位之前”的增量提取新记忆；更早历史和已反思内容只可用于消解指代，不可再次作为新增记忆来源。必要的精确消息范围作为历史之后的任务增量提供。

### FR-MEM4-04：单次压缩调用双结果独立提交

同一次压缩 provider 调用产出两个逻辑独立结果：会话压缩摘要与 Memory 反思候选。两者分别解析、验证、持久化和记录状态；一侧成功不能伪报另一侧成功。压缩分块必须能将消息来源映射回唯一冻结区间，不能从滚动旧摘要重复提取记忆。

### FR-MEM4-05：缓存前缀与会话历史不变

反思区间信息只能附加在压缩请求已有历史之后的动态 task delta。`stable_system`、`history_messages`、`tools` 的顺序和内容完全保持原样；不插入标记消息或改变 provider-ready 历史前缀。运行时通过 prefix digest 和 provider cache usage 验证，不假设所有 provider 都会命中缓存。

### FR-MEM4-06：Baseline 推进与 TTL 水位重置

baseline 成功切换后，将 TTL 区间参照水位同步到新 baseline 的 `covered_through_message_id`，后续 TTL 区间从该边界之后开始，避免跨 baseline 重复处理。若压缩反思未成功，原冻结区间必须作为 pending job 保留并可重试；游标重置不得清除、跳过或覆盖未成功区间。baseline、水位、pending job 的更新通过事务/CAS 保证一致性。

### FR-MEM4-07：群反思阈值保持

继续保留 `GROUP_MESSAGE_THRESHOLD = 50`、群级/群友批量/群内 Owner 反思和 4 分 30 秒群闲置收束。网页/私聊轮数阈值的删除不得改变群消息计数、群成员游标或触发行为。

## 3. 技术方案

### 3.1 区间与水位

- **反思水位**：scope 内最近一次成功反思覆盖到的持久消息 ID。
- **baseline 水位**：当前压缩 baseline 覆盖到的最后一条 canonical message ID，即 `covered_through_message_id`。
- **冻结反思区间**：按 scope 内消息顺序，取起点水位之后至任务冻结 `high_water_message_id`（含）之间符合该 scope 规则的消息；任务需持久化实际首尾消息 ID。并发到达的更高 ID 留给下一批。
- **TTL 参照水位**：正常情况下取最近一次成功反思水位；baseline 切换后同步到新 baseline 覆盖水位。未成功区间不因参照水位重置而丢弃，必须由原 pending job 独立保存和重试。
- 消息 ID 只在所属 session/scope 内比较，禁止跨用户、会话或 IM scope 组装区间。

### 3.2 请求组装和缓存边界

- 压缩请求保留原 `stable_system`、`history_messages`、`tools` 结构和顺序。
- 仅将摘要/反思输出格式及本次冻结范围说明追加到历史之后的任务增量；确需提供范围原文时，也只能置于该动态增量中。
- 反思范围标注为“最后一次成功 TTL 之后”，同时携带服务端冻结的区间边界，提示模型只从该增量提取新事实。
- 不在 canonical history 或历史消息数组中插入 watermark、marker、ID、时间标签或边界消息；不为反思过滤、重排、改写历史。
- 使用现有文本输出模式，通过明确分隔结构解析摘要和 Memory 候选，不增加反思工具声明或 `tool_choice`。
- 对照改动前后的 provider-ready history prefix digest、tools digest、输入 token、cache-read/cache-write；缓存行为按 provider 分析。

### 3.3 持久化、并发和部分失败

优先复用 `MemoryReflectionCursor` / `MemoryReflectionJob` 的范围、幂等和重试语义。网页 session 若不能直接映射现有 scope，则新增明确的 session scope 或专用 cursor/job，不以无消息 ID 的 Redis 文本列表作为唯一事实源。baseline 提交、TTL 参照水位重置和 pending job 维护须事务化或使用版本 CAS；baseline 与反思结果独立提交，重试只处理未成功的一侧。

任务记录至少包含 scope identity、冻结起止消息 ID、触发原因（`idle`/`compaction`）、幂等键、抽取器版本、状态/重试信息和创建时活动代次/游标版本。日志与 Loopscope 只记录脱敏 scope、区间 ID、状态和 fingerprint，不记录聊天正文、附件名、工具参数或完整提示词。

| 摘要结果 | 反思结果 | 处理 |
|---|---|---|
| 成功 | 成功或合法空增量 | 分别提交；baseline 与反思水位推进。 |
| 成功 | 失败/无效 | baseline 可按现有规则提交；原反思区间保留 pending，重试成功前不得将其标记为已反思。 |
| 失败 | 成功 | Memory 独立提交该区间；压缩走现有失败/确定性回退策略。 |
| 失败 | 失败 | 两者均不提交，按各自幂等范围重试。 |

### 3.4 文件范围

```text
backend/agent/memory/
├── reflection.py                 【条件】复用/调整 scope 反思 writer 和水位语义
├── reflection_jobs.py            【条件】复用/调整持久任务、幂等与重试
└── reflection_idle.py            【条件】接入网页/私聊 TTL 冻结和调度
backend/agent/context/
├── compaction.py                 【修改】单次调用双结果及 baseline 协调
└── run_finalize.py               【条件】90% 收尾压缩入口接入
backend/app/models/__init__.py    【条件】仅当现有模型无法表达 scope/cursor/job 时修改
backend/tests/                    【新增/修改】区间、竞态、失败恢复、缓存边界和群回归
frontend/src/                     【条件】仅在网页/私聊阈值仍暴露 Admin/API 时清除其配置界面与类型
```

以现有稳定模块为准，不新建平行反思框架；仅在现有持久化模型无法承载 session scope、冻结区间或 pending 状态时扩展 schema。不得修改用户运行配置文件。开发前按实际代码确认前端/API 阈值归属；如某目录不存在对应实现，不为满足文件树而创建空层。

## 4. 验证与上线

- 区间测试覆盖相邻 TTL 批次无遗漏/重复、冻结高水位、并发新消息、重复投递、重启、失败退避、合法空结果及跨 scope 隔离。
- 请求组装测试确认 `history_messages` 和 `tools` 深度相等、范围提示只位于 task delta、冻结范围与数据库查询消息一致。
- 压缩测试覆盖分块来源映射、摘要与反思四种成功/失败组合、baseline 推进后 TTL 水位对齐，以及反思失败时 pending 区间不丢失。
- 配置回归确认网页/私聊轮数阈值不再读取或触发，旧用户配置不被自动改写；群消息第 49 条不触发、第 50 条触发，群闲置收束保持原行为。
- 运行验收选取连续网页/私聊会话，检查相邻 TTL 区间与一次压缩协同区间；核对实际写回范围、baseline 水位、TTL 游标、pending job 和 provider cache usage。
- 上线时按实施阶段验收；若 baseline/cursor 状态不一致、出现区间漏项/重复，停止扩大范围并按部署回滚流程恢复旧反思触发配置/代码。用户运行配置不由回滚脚本覆盖。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 压缩成功但 Memory 写入失败 | baseline 已变化，反思若无独立 pending 区间可能漏记 | pending job 保存原冻结区间；baseline 水位重置不得删除任务；覆盖部分成功故障注入测试。 |
| 反思水位与 baseline 水位语义混淆 | 导致重复反思或跳过尚未反思消息 | 分别持久化/定义水位；切换 baseline 时显式同步 TTL 参照水位并保留 pending 区间。 |
| 历史尾部追加范围内容影响缓存 | provider cache 命中可能下降 | 不改变稳定历史前缀；将范围增量放尾部并测量 cache usage，不承诺跨 provider 命中。 |
| 不同压缩块与反思区间映射不精确 | 重复提取或漏提事实 | 冻结来源消息映射；旧 baseline/summary 仅用于理解，不作为新反思源。 |
| 清除网页/私聊阈值时误删群路径 | 群长期活跃会话不再反思 | 独立保留群 50 条阈值并执行群行为边界回归。 |

待确认问题：无。若实现调查发现现有 cursor/job 无法满足 pending 区间跨 baseline 保留，应先更新本 PRD 并评审数据模型，不得用内存状态或清空游标绕过。

## 6. 唯一实施 TODO

### Phase 1：持久化区间与并发正确性

- [ ] `MEM4-001` 明确并实现 session/scope 反思 cursor、冻结区间及 baseline 水位的数据契约；责任：Memory 数据模型与迁移；验收：起止消息 ID、scope、baseline covered-through 和版本均可持久化，跨 scope 查询隔离测试通过。
- [ ] `MEM4-002` 实现反思 job 幂等、重试和水位 CAS/事务推进；责任：Memory job/cursor 服务；验收：失败/超时不推进，合法空增量推进，重复投递/worker 重启仍处理同一冻结区间。
- [ ] `MEM4-003` 实现 baseline 提交与 TTL 参照水位同步，并保留失败反思 pending 区间；责任：Context compaction 与 Memory 持久化边界；验收：baseline 成功而反思失败时，参照水位按 baseline 对齐且原区间仍可重试，无漏项/重复。

### Phase 2：网页与私聊 TTL 区间反思

- [ ] `MEM4-004` 将网页/私聊活动接入 3 分钟 TTL 冻结与调度；责任：Memory idle scheduler 与 session 消息适配；验收：窗口到期任务覆盖最后成功水位至冻结高水位，期间并发新消息留待下一批。
- [ ] `MEM4-005` 完成 TTL 提示词区间约束和任务结果落库；责任：Memory reflection prompt/writer；验收：范围准确、旧历史只用于上下文、失败区间保留、日志不含正文。

### Phase 3：压缩协同与缓存前缀保护

- [ ] `MEM4-006` 在压缩请求尾部加入“最后成功 TTL 之后”的冻结范围说明，并让单次压缩调用产出摘要与 Memory 候选；责任：Context compaction 请求组装；验收：原 `stable_system`、`history_messages`、`tools` 完全不变，范围 payload 与冻结区间一致，只有一次同范围 provider 调用。
- [ ] `MEM4-007` 实现摘要与 Memory 候选独立校验、提交和重试；责任：Context baseline writer 与 Memory writer；验收：四种成功/失败组合符合第 3.3 节语义，baseline 与反思水位不会互相伪推进。
- [ ] `MEM4-008` 覆盖分块压缩消息来源映射；责任：Context chunk/source mapping；验收：消息只归属一个反思区间，旧滚动摘要不被当作新增反思来源。

### Phase 4：阈值清理与群行为保护

- [ ] `MEM4-009` 移除网页/私聊轮数阈值运行路径及其配置/API/Admin 暴露；责任：Agent 配置 API、Admin UI 与 Memory 调度；验收：配置 schema、类型、UI 和执行代码无网页/私聊阈值触发，用户运行配置未被脚本改写。
- [ ] `MEM4-010` 保留并回归群 50 条阈值及群闲置收束；责任：IM reflection jobs；验收：第 49 条不触发、第 50 条按既有语义触发，群级/群友批量/群内 Owner 边界不变。

### Phase 5：全量验收与上线

- [ ] `MEM4-011` 完成区间、竞态、压缩、失败恢复、阈值清理和群回归测试；责任：Backend/Admin 自动化测试；验收：相关自动化测试通过，用户运行配置保护测试通过。
- [ ] `MEM4-012` 在目标环境完成连续 TTL 与压缩协同验收；责任：Runtime 运维验收；验收：记录脱敏区间/水位证据、baseline 对齐、pending 恢复和 cache-read/cache-write 对照，未发现漏记或重复后方可扩大上线范围。

## 7. 关联文档

- [`【已完成】PRD-IM-11-群成员长期记忆.md`](./【已完成】PRD-IM-11-群成员长期记忆.md)：群消息 50 条阈值和 IM 游标任务。
- [`PRD-LLM-27-会话分支增量反思与缓存复用.md`](./PRD-LLM-27-会话分支增量反思与缓存复用.md)：追加式分支、快照和缓存前缀约束。
- [`【已完成】PRD-AGENT-5-ContextBranch反思与压缩统一架构.md`](./【已完成】PRD-AGENT-5-ContextBranch反思与压缩统一架构.md)：分支与领域 writer 职责边界。
