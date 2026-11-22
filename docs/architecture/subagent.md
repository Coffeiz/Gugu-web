# 子 Agent 运行架构

主 Agent 将任务委派给同一用户、同一主会话下的内部子会话。子会话有自己的历史和 checkpoint。Web Host 与 Desktop 共用 Core 的委派服务和 Canonical Runner，各自负责调度、模型绑定和权限校验。目前内置角色为 Searcher。

## 身份与授权

- `childId` 是父会话内唯一的短 ID。它首次生成于子执行 UUID，之后沿用。每次启动或续聊都有自己的执行 ID，父会话通过 `agent_subagent_conversations` 找到该短 ID 对应的子会话和最新执行。
- 子 Agent 继承父 Run 的模型绑定。可使用的工具由角色预设和宿主运行时共同决定。Searcher 使用只读研究工具，文件读取依赖可验证的授权引用，Shell 可用时遵循宿主的确认规则。Web Host 的 IM 附件目前未接入 Searcher 文件引用。
- Web、Desktop 和授权的 IM 主人私聊共用委派工具和目录提示词。IM 群聊和非主人私聊没有派单权限。子任务只收到委派输入、授权引用及自己的历史。

## 派单与恢复

`agent_message({action:"start", …})` 先持久化交付记录、子会话绑定和加密执行材料，再返回已排队状态。派单以父 Run 和工具调用 ID 防重，调度器按已登记执行领取。互不依赖的任务可并行派出。

Web Host 用 Redis 唤醒调度器，并由持久扫描处理漏掉的通知和重启恢复。Desktop 使用 SQLite 准入记录扫描新任务和恢复任务。两个宿主都以原执行 ID、checkpoint 和租约接续，子任务恢复时不会重新派单。

| 操作 | 行为 |
| --- | --- |
| `agent_message(send)` | 通过短 ID 向活动执行追加消息。已完成的子会话可从新的父 Run 开始下一次执行，沿用子会话历史。 |
| `agent_wait({childId})` | 等待指定任务的结果。启用后台报告的任务可在同一会话后续 Run 按短 ID 查询已保存结果。 |
| `agent_wait({})` | 读取会话未读消息和报告，或在已有委派的 Run 中等待收件箱更新。 |
| `agent_cancel` | 请求取消当前子执行，保留子会话与历史。父 Run 的取消也可级联。 |
| `agent_inspect` | 查看子会话列表、执行状态和轮次摘要。查看摘要不会消费报告。 |

## 等待与会话收件箱

派单成功后，主 Agent 先发进度说明，再处理未委派且不依赖结果的工作。最终回复仍需要子任务结果时，主 Agent 在结束当前 Run 前调用 `agent_wait`。等待写入持久状态并释放执行槽，子任务结果到达后由调度器唤醒当前等待的 Run。多个任务并行时可以等收件箱，再继续等待本轮仍缺的结果。

子任务终态和加密报告随持久化提交。未读报告和子 Agent 发给父会话的进度消息按 owner 和会话读取，来源 Run 仍用于授权、追溯和解密。发给子 Agent 的追加指令仍绑定目标执行。父 Agent 保存已吸收结果的 checkpoint 时，同事务登记已读，已读条目自动退出未读索引，加密报告和防重记录继续保留。当前未接入按保留期物理清理。

只有用户明确要求先结束本轮、留待下次对话再汇总时，才使用 `allowBackgroundReport`。当前会话已经空闲时，结果留在收件箱供后续 Run 读取。空闲会话自动创建补充回复尚未接入。

## 消息展示和 IM 投递

应用内可查看委派工具活动和独立的子 Agent 报告。IM 投递使用主 Agent 的正文，过滤内部子 Agent 工具详情和结果。QQ 流式投递仍保留无正文的工具调用边界，用它结束上一轮正文，让用户在子任务尚未返回时就能收到进度说明。

Desktop 继续观察处于内部等待的 Run，直到终态、需要用户处理的交互或连接断开。内部等待可以由子任务交付继续推进。

## 代码入口

- Core 委派服务、交付与收件箱位于 `packages/core/src/agent/subagent/`。主 Agent 委派提示词位于 `packages/core/src/agent/context/modules/subagent-catalog.ts`。Searcher 的任务流程和报告模板位于 `packages/core/src/agent/subagent/searcher/prompt.md`。
- Web Host 在 `apps/web-host/src/startup/agent.ts` 装配子执行，在 `apps/web-host/src/modules/agent/run/` 和 IM Gateway 中处理等候恢复。Desktop 入口在 `apps/desktop/src/main/agent/runtime.ts`。
- PostgreSQL 与 SQLite 的会话未读索引分别由 `0036_subagent_session_inbox` 与 `0024_desktop_subagent_session_inbox` 建立，兼容此前保留的交付和消息。

产品范围和工具字段见 [PRD-AGENT-8](../prds/PRD-AGENT-8-可组合上下文与子Agent运行时.md#354-子-agent-通信工具-schema)。
