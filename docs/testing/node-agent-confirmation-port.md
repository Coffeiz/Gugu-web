# Node Agent 危险操作确认端口契约

日期：2026-11-14，后续状态增量记录于文末。本文为实现与验收契约，不是功能完成记录。Core confirmation gate 负责核验可信意图和 resolution；Host 仅在 per-lease 确认端口齐备时注册危险工具。真实 PG/Redis 单次 claim 与跨进程恢复未验收，因此这些工具目前只是部分实现。

2026-11-18 当前状态：七项日历/画布工具已进入 Core ToolPort 与 Web per-lease 装配路径；危险项仅在可信密钥和各自 confirmation gate 可用时注册。Host 已接入既有交互激活、投影、响应与恢复队列，不新增 HTTP route。工具仍标为部分实现：真实 PostgreSQL/Redis claim、跨进程恢复、Provider Run 与发布/提醒消费者未验收。后文早期“仍关闭/未接线”描述保留为历史记录，以本段和 [node-agent-tools-parity.md](node-agent-tools-parity.md) 当前状态为准。

## 已存在的边界，必须复用

| 已有入口 | 已实现职责 | 不能据此推断已完成的职责 |
| --- | --- | --- |
| `backend/agent/interactions/confirmations.py` | Python 确认载荷、ACTION/AUTHORIZATION 区分、目标身份、短码兑换、Redis TTL、可选原子单次授权消费、服务不可用时关闭 | 旧 grant 主要绑定 owner/摘要/目标身份，并不自动包含 Node 的 run/call/版本；不能直接作为完整新授权 |
| `apps/web-host/src/modules/agent-sessions/tools/confirmation-identity.ts` | `targetConfirmationIdentity` 兼容 Python 确定性编码：操作、资源类型、上下文、完整目标集合；目标顺序无关，数字与字符串身份不同，重复 ID 拒绝 | 这是身份编码，不是签名/授权凭据；不自行绑定 owner/session/run/call、记录版本、时效或持久消费 |
| `.../persistence/agent-trusted-intent-postgres.ts` | `createPostgresTrustedIntentStore` 加密保存可信意图，按 owner/session/run/interaction/call 读写；校验完整 binding、目标/版本 digest、收据与有效期，并在事务 claim 时回调当前权限复核 | 合成 Pool 回归不证明真实 PG 并发、Redis 确认兑换与领域收据故障恢复已验收 |
| `.../persistence/agent-trusted-prompt-descriptions.ts` | 从可信 store 读取 confirmation intent，以已有 target identity 和创建确认码端口构造固定确认/取消按钮；凭据交互另有 owner-scoped 查询 | `createConfirmation` 是注入端口；确认码成功创建不证明授权检查、危险业务执行或版本验证已接通 |
| `.../persistence/agent-interaction-activate-postgres.ts` | 同事务绑定 prompt/action 与 Run，确认交互禁止自定义文本；重复激活校验旧绑定；按队列轮到前台后激活 | 交互 prompt 不是领域资源锁；不能在用户等待期间一直持有业务事务或将原模型参数当可信意图 |
| Core `agent/interactions/consume-action.ts`、Web Host `persistence/agent-interaction-consume-postgres.ts` | Core 处理过期、取消、一次性消费与重放；Host 提供 owner/prompt 限定、action 行锁及确认码兑换。现有命令动作只支持工作区删除与文件系统授权 | 通用危险 Agent 工具不能塞入现有 `command_action` 分支绕过 Tools；PG 与注入的 Redis 兑换不天然属于同一原子事务 |
| `packages/core/src/agent/interactions/coordinator.ts` | 可信 resolution 绑定 pending interaction、校验类型、原子 checkpoint 消费 receipt；确认成功直接继续原调用，取消/过期收尾不再调用业务；秘密值不进 Canonical | Harness 只验证交互编排，Tools 仍须核验意图、授权和实际资源；`status=confirmed` 本身不是可执行授权 |
| `.../persistence/agent-interaction-resume-postgres.ts` | 持久恢复队列和 Run interaction receipt 查询 | 这是交互回答消费收据，不是危险业务已经提交的凭证 |

上表 `...` 均为 `apps/web-host/src/modules/agent-sessions/`，禁止重复创建第二套确认 UI、token store、交互 worker 或 Agent 调度框架。

## 必须绑定的可信执行意图

工具先通过标准参数验证和最新权限检查，再用共享领域服务在 owner 范围内解析真实资源。模型给的是业务选择条件；实际目标 ID、资源类型、级联范围和版本必须由可信 handler 生成。不得让模型提交 `targets`、`confirmed`、`confirm=true`、授权根、版本断言或 receipt 来建立授权。

待确认记录需要以下字段。下表定义设计约束；当前 Core/Host 已保存并校验其中的可信绑定与摘要，真实 PG/Redis 并发与故障恢复仍待验收：

| 字段 | 来源与约束 |
| --- | --- |
| ownerId/sessionId/runId/roundId/toolCallId | Host 已认证 Run 与 Harness dispatch scope；与模型参数完全分离 |
| interactionId、intentId、operationId | 可信执行层生成、持久保存并建立唯一约束；同一调用重复准备重用相同意图，不产生多个可消费授权 |
| toolName、action、purpose | 注册定义/handler 生成；ACTION 是业务操作同意，AUTHORIZATION 是能力授予，二者不可互换 |
| normalizedInputDigest | 对本次实际规范化执行输入的稳定摘要；输入原文只在现有受限加密意图中保存，不进公开事件/日志 |
| targets、context | 复用 `targetConfirmationIdentity`；包括每种资源的精确 ID 集合和父级上下文；空集合、重复目标、未授权项均在展示前拒绝 |
| expectedVersions、targetsDigest | 领域读取产生；单项/批量每个可变化资源的 version/CAS token；级联目录等还需领域定义的成员水位/集合摘要，避免确认后新添内容被扩大删除 |
| summary、expiresAt、authorizationEpoch | 可信影响摘要、明确有效期和可重新验证的授权版本；摘要用于展示而非作为唯一授权身份 |
| state | pending → answered/approved → executing → committed/denied/expired/cancelled/unknown；精确状态及 CAS 由复用存储的实现定义，不添加独立 Agent 状态机 |

`TrustedPromptIntent.context` 仅允许标量；当前实现将规范化摘要保存在 context，并把完整目标 ID/版本 digest 与确认操作快照保存在加密 intent 内。旧 grant 不绑定完整 Run scope 和执行输入摘要，不能复用为 Node 工具授权。

## 沿现有 ToolPort 的三段流程

1. **准备**：registry 校验名称/参数/能力/权限 → handler 通过共享服务解析目标及版本 → 无副作用地形成意图 → 可靠保存意图 → 返回 `ToolResult.kind='waiting'` 与现有 `PendingInteraction`。`plan()` 在需要时使用现有 Harness 交互隔离语义；Tools 不自行激活其他调用的弹窗。存储失败明确拒绝，不能执行后补确认。准备不持有跨用户等待的数据库事务。
2. **用户回答与恢复**：既有 activator 从可信 intent 构造固定按钮，既有 consume/worker 生成并消费服务端 receipt，Harness 继续原 tool call。取消、过期、Run 中止和任一身份不匹配均不进入领域 mutation。前端或模型提供的 `resolution.value` 不得作为授权目标。
3. **执行**：Tools 根据真实 scope 和 resolution 在受限服务端存储取出原意图；核验原 call/输入摘要/操作/精确目标/版本/时效以及最新权限。只执行保存的精确目标，不重新按名称、通配符、目录当前内容扩大范围。无法维持原意图则返回冲突，要求重新准备和展示影响范围，旧授权失效。

目标在等待期间被改名不必天然失效，但必须按领域契约判断影响是否变化；不得因旧名字现在匹配到另一条记录而执行新资源。目标被删除、迁移归属、增添级联成员、版本改变或授权撤销时均应拒绝或重新确认，不能静默放宽。

## 原子性与未知结果

必须区分三种现有/待实现收据：UI action 已消费、Harness interaction receipt 已消费、领域 operation 已提交。前两项只证明用户回答和运行恢复，不能证明业务完成。Harness 当前先提交 interaction receipt 再 replay 原调用，因此不能要求把这一步跨层塞进同一个领域事务。

对同库业务，领域服务应将“核验/占有操作授权、目标版本 CAS、精确 mutation、领域 operation receipt、安全结果与必要 outbox”放在同一个短事务中；复用该域已有事务/幂等入口，不在 Tools 手写新业务 SQL。operationId 必须与可信意图和调用绑定，两个并发 resume 只能有一个执行者。

Redis 短码兑换与 PostgreSQL 消费失败之间存在跨存储边界。不能因为 Redis 已兑换就认定 PG 已提交，也不能在 PG 回滚后把同一授权给任意其他 Run 使用。应复用已有恢复队列和持久意图/operation 唯一键实现幂等恢复，并以一次性服务端授权 claim 保证危险业务不能重复。具体实现与故障注入验收未完成前不开放。

对外部不可回滚操作和原生执行，沿现有 Executor/领域端口使用 operationId 与后端收据，记录“已开始”后严格区分已提交/明确未执行/无法确定。启动后异常、连接中断或 COMMIT 响应丢失均不能笼统映射成普通可重试错误；`ToolResult.kind='unknown'` 并保留待核对操作。

`ToolPort.reconcile(call, identity+roundId)` 只查询与该调用完整绑定的受限 operation receipt：有可信提交收据则返回原安全结果；有明确未执行证明才返回对应失败；缺收据或不确定始终 `unknown`。禁止在 reconcile 中再次执行 mutation、重新兑换授权或用假成功结束 Run。Harness checkpoint 未写入但领域已提交时，恢复查询原收据而不是重放业务。

取消须检查到真正提交边界：未开始取消不执行；取消到达时 mutation 已提交则保留真实成功结果和收据，不能因最后一次 signal 检查把成功伪装为未执行。并发安全不能只靠进程内布尔值或 UI 按钮禁用。

## 错误与展示契约

- 参数、权限、范围、确认服务不可用、过期、目标变化和重复消费均返回既有安全业务错误；未执行的明确拒绝标 `executed=false`，`successful=false`、`mutated=false`。
- 等待确认只返回安全 PendingInteraction，完整意图/版本/凭据/确认码不得放入普通 Canonical、SSE 或公开日志；使用现有私有 prompt 投影渠道交付用户按钮。现有加密 intent store 与 receipt 查询继续复用。
- 可信摘要可展示必要的用户资源影响，但不得含内部绝对路径、凭据或原始异常；审计只保留操作类别、结果与指纹。
- 已提交成功按实际领域副作用设置 `mutated`；幂等 replay 不二次 mutation。未知提交返回 `unknown`，不制造可诱发自动重试的假失败。
- Python 自动模式只允许可信策略跳过 ACTION，绝不跳过 AUTHORIZATION；Node 尚无经过验收的相同策略时维持显式确认，不凭模型文本启用自动模式。此差异须明确记录。

## 最低行为验收矩阵

测试必须经过 registry → 真实 handler → 共享领域服务；纯身份编码单测只验证编码契约。持久化/并发/重启使用隔离数据库和显式服务，禁止真实用户配置与数据。

| 场景 | 必须观测的结果与副作用 |
| --- | --- |
| 未确认调用、模型伪造 confirm/targets/receipt | 只生成可信精确意图或明确拒绝，领域数据完全不变 |
| 正确确认 | 原 call 自动续接一次；完整目标按保存意图操作，结果/Undo/outbox 与共享业务服务一致 |
| owner/session/run/round/call/action/input 任一变化 | 不能复用授权或读取私有意图；领域无变化 |
| 数字/字符串 ID、不同资源类别、不同父容器、乱序/重复批量目标 | 编码跨语言一致；仅顺序变化可等价，重复目标拒绝；增删目标须重新确认 |
| 名称重匹配、目录新增成员、版本变化、归属变化、目标已删 | 不扩大目标；CAS/版本冲突不覆盖并发写入，重新确认前不执行 |
| 取消/过期/撤权/Run durable cancel | mutation 次数为零；不再启动 Provider 或其他危险调用；先前已完成结果保留 |
| 伪造 resolution.status='confirmed'、普通问题/凭据 receipt 混用 | 服务端意图和 receipt 核验失败；未授权执行次数零 |
| 两个进程同时恢复/重复 UI 回调 | operation 只提交一次；重复投递仅返回对应原收据，不二次业务执行 |
| intent/prompt/checkpoint 任一步崩溃 | 恢复读取相同身份；没有意图不激活，没有绑定不执行，不能产生孤立可用 grant |
| Redis 兑换成功后 PG 回滚/断线、授权存储不可用 | fail-closed；不把旧授权扩散；恢复行为可证明且业务无重复 |
| 领域 COMMIT 成功但响应丢失、checkpoint 失败 | unknown → reconcile 得原提交结果；mutation 一次；无收据继续 unknown |
| 外部调用已发出后取消或断线 | 明确未知而非假失败；等待已启动资源清理；禁止自动重发 |
| 已提交后才取消 | 真实成功与收据保留，不能返回未执行或再次执行 |
| 可见错误/事件/Canonical/日志 | 无凭据、原始异常、原始参数、确认码和私有意图内容 |

Python 重点基准包括 `backend/tests/agent/test_confirm_gate.py`、`test_interaction_protocol.py`、`test_interaction_phase5_7.py`、`test_interaction_retention.py`，以及项目、日历、联系人和回收站删除测试。Node 回归入口包括 Core `tests/agent/interactions/` 下的 `coordinator.test.ts`、`consume-action.test.ts`、`prompt-description.test.ts`、`recovery-worker.test.ts`，以及 Host `tests/agent/` 下的 `agent-confirmation-identity.test.ts`、`agent-interaction-consume-postgres.test.ts`。

## 允许开放首个危险工具前的缺口

- 可信 intent 必需绑定 round、执行输入摘要、每目标版本与级联集合；明确迁移/兼容现有加密 envelope。
- Tools 的 pending/resolution 分支、持久授权 claim 与领域 operation receipt 需要实现；当前 registry 的一律拒绝不能提前删除。
- 首个危险工具必须选已经有共享领域事务/幂等/Undo 的业务切片；不要用原生 Shell 验收代替数据库工具，也不要反向扩大 Linux MXC 能力声明。
- 同库原子 mutation/receipt、跨 PG/Redis 故障、跨进程双 resume、提交未知 reconcile 均须真实隔离依赖验收。仅 mock store 或 UI 确认按钮测试通过不能开放。

## Core 核验边界实现（2026-11-14 状态）

`packages/core/src/agent/tools/confirmation.ts` 新增 `createConfirmationGate`。该实现仅准备/核验可信持久意图，返回受限的 intentId/operationId 引用，不消费授权 claim、不执行 mutation，也不会使注册器开放危险工具。

Host须提供可信时钟、最新授权epoch、prepare/load/inspect端口。意图与收据要求schemaVersion=2，包含完整owner/session/run/round/call/tool与规范化输入摘要绑定、purpose/action、目标/版本摘要、有效期。prepare必须先通过共享领域服务解析目标，再可靠保存；load须通过现有服务核验receipt，不信任resolution.value。inspect按原意图的固定目标复查当前归属、版本和级联集合。输入摘要必须由可信规范化层生成，不能直接读取模型的digest/confirm/targets字段作为授权。

旧 Host intent 缺少 operation/schema 绑定时明确拒绝或按旧兼容描述处理，不能自动补空值升级。当前 Host 已实现加密意图 schema、确认 receipt 查询及领域事务内 claim；真实 PostgreSQL/Redis 并发与恢复尚待隔离服务验收，不能将端口测试视作生产通过。

本轮运行：Core核验边界23/23，工具/技能整合105/105；Python确认基准41/41，均无失败/跳过。存储、授权epoch与目标版本复查使用明确端口替身，不证明单次领域claim或真实PG/Redis已完成。测试源码类型检查当时受并行Harness测试TS2722影响，已协调，未据此宣称全仓通过。

2026-11-17 Core Runtime 边界增量：dispatch lease 可携带 Host 已持久验证的 `InteractionResolution`，Core dispatch worker 在恢复模式下将其交由 Harness，再由 Core 校验 receipt 与 pending interaction 绑定；新启动租约带 resolution 时会被拒绝。行为回归 **9/9 通过**。Host PG `claim()` 仍拒绝 `waiting` checkpoint，interaction resume queue 尚未与 dispatch fencing lease 原子组合；因此此契约暂未被生产确认流程调用，不开放危险工具，也不代表持久确认验收完成。

2026-11-18 接线增量：Core `AgentChatService<I>` 是 HTTP-independent 的跨端 Chat 合约，提供 owner/session wake；Web route 复用 Core 类型。可信 Host 意图加密保存在 `agent_interaction_intents`，绑定 owner/session/run/round/call/tool/input digest/target+version digests/权限 epoch；当前 fence/token 在工具准备和领域事务中各自复核。确认恢复会获得新 fence，故权限 epoch 不再包含一次性 fence；授权 epoch 由账号安全版本及 Provider access version 组成，仍需有效当前 lease。`main.ts` 仅当当前主密钥可读取时注入 `delete_event`、`canvas_delete`、`canvas_delete_note`、`canvas_disconnect`、`canvas_batch` 确认端口，五种 action 使用不同 gate。devserver Core build 通过；Host 确认/画布/registry/Chat wake/交互响应与消费 **56 通过、2 个 PostgreSQL 用例跳过、0 失败**；Python 日历/提醒/画布/撤销/幂等回归 **66/66 通过**。Web Host production typecheck 因并行终端 `ws` 类型声明问题失败，本轮修改文件无诊断。真实 PG/Redis、Provider、提醒消费者和重启恢复尚未验收，危险工具尚未达到“已完成并接入”。
