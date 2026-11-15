# Node 日历公共查询与 Agent 端口缺口

`list_events` 当前依赖阻塞；现有 Web 日历列表已接线不等于 Agent 查询完成。

## 已公共化的现有Web列表与详情（2026-11-14）

`@gugu/core/calendar::createCalendarEventReader(port)`复用既有calendarEventResponse投影；`createKyselyCalendarReadPort(db,backend)`提供实际PG/SQLite查询。owner必须规范化并限定、软删项不可见、列表按date升序。year/month沿Python与原Host兼容规则：只有两者都非零时才按文本年月前缀过滤，缺少一项或0不筛选，不擅自把负数/13月改成新校验错误。详情不存在、他人或软删项返回null，HTTP仍映射404。保留client/endTime/projectId、空字段和version的历史回退，不修改存储记录。

Host `main.ts`直接组合公共用例和Kysely端口，原Host重复读取SQL及工厂已删除；事务内`findOwnedActiveEvent`仍由旧写入适配器使用，不把写事务拆成跨连接读取。Kysely端口参数化SQL，按后端编码owner，Host持有连接；不建表、不读凭据、不创建另一套领域数据。可选signal在等待前和真实查询/结果处理完成后检查；驱动拒绝与取消同时出现时优先传播原取消原因。没有race提前返回或强制终止服务器SQL，现有HTTP也尚未接入断连signal。

- 正式schema初始化的临时SQLite文件8/8：经真实Kysely保护两owner、软删、排序、完整DTO/关联项目、筛选兼容、非法参数零SQL、真实缺表不假空，以及成功/失败结果处理等待中的取消。SQLite结果plugin门只证明SQL执行后API尚未settle，不误称连接此时仍占用。
- 独立临时PG随机schema3/3：Core读取经真实Fastify认证、路由和数据库及生产Host装配，验证完整结果及401/404/422、真实SQL失败的固定安全500；另一项通过pg_locks观察目标表真实服务端等待，再取消，确认锁释放前不settle、释放后按原reason拒绝，单连接后续list/get成功。认证用户查询与JWT为合成依赖，不连接真实账号或外部服务。实例和schema已清理。
- 现有Host路由6/6原断言不变；这里使用领域函数替身，与上述真实SQL链分别记录。Core工具/技能和相关查询选集25文件430通过，0失败/跳过；Core源码/测试与Host类型检查、diff通过。
- Python新增`tests/scheduling/calendar/test_calendar_api_reads.py`3/3，直接调用真实管理handler和隔离SQLite；保护完整驼峰DTO、owner/软删/日期排序、year/month真值规则、详情404及version0回退不写回。原Agent列表聚合和跨owner读基准各1项也通过，本组共5/5、0失败/跳过，2条弃用提示。新增管理基准不冒称此前已存在的pytest，也不以邻近测试替代提醒业务验收。

全仓测试元数据检查仍失败：大量并行/既有Host和前端测试缺登记；本轮三份新增测试元数据已登记，不批量补写他人测试。Core整树quality_delta仍有15项其他门禁，新读取小查询有克隆/未调用提示；calendar新目录无独立HEAD基线，不能宣称该范围质量全绿或无兼容风险。旧Host工厂签名edit-check为unchanged，实际消费链由上述回归验证。

本轮已更新main装配，未修改共享schema、运行配置或workspace依赖。管理读取已公共化，但不升级Agent list_events状态，仍需下列共享提醒查询、工具边界和生产Run接线。

## Agent查询仍需补齐

Python 基准为 `backend/agent/tools/calendar.py::_list_events`、`app/services/calendar.py::list_events_with_reminders`。

- 公开参数 `from`、`to` 匹配 `^\d{4}-\d{2}-\d{2}$`；`type` 为 `event|deadline`，空字符串按省略。handler 读取未公开的 `limit`，默认 50。
- owner 和未删除过滤；日期范围含端点；按 date 排序后 limit。
- 返回仅 `id/title/date/time/end_time/type/project_id/description/reminders`。
- 提醒再次限定 owner、已选事件，按任务 id 排序；没有提醒返回 `[]`。
- 提醒只投影 `lead_minutes/channels/enabled`；QQ 另附 `delivery_mode`（群目标为 `current_group`，其他为 `owner_private`），不公开原始目标和凭据。
- 提前量优先保存字段，旧 once 记录以 Asia/Shanghai 本地开始时间推导；全天事件为 09:00。非 once 无提前量为 null；空 channels 为 []，不能复用写流程的 web 默认值。

拟由可信 Host 提供共享领域查询：

```ts
listEvents(
  identity: RunIdentity,
  query: { from?: string; to?: string; type?: 'event' | 'deadline'; limit: number },
  signal: AbortSignal,
): Promise<readonly CalendarEventWithReminders[]>
```

Host 保证上述 owner、过滤、排序及提醒聚合，Core 负责参数验证和 ToolPort 结果/错误边界。取消需等待查询资源清理，不把原始数据库异常传入可见结果；缺失端口时不注册工具。

现有 `main.ts` 直接装配 Core 管理读取并由 `routes/events.ts` 使用，但它仍仅支持 owner/year/month，不支持日期范围、类型、limit 和提醒聚合。写流程中的私有提醒转换也不是完整读服务。不得复制另一套 SQL 或返回空提醒冒充完成。

回归基准：

- `backend/tests/scheduling/calendar/test_calendar_tools.py::test_list_events_groups_reminders_and_includes_empty`
- 同文件 `test_reminder_brief_is_an_event_field_value`
- `backend/tests/agent/test_parallel_tool_policy.py::test_phase2_project_and_calendar_reads_preserve_user_scope`

上半部分Web管理查询已有双库与真实HTTP调用验收；本节Agent提醒查询仍为依赖盘点，未新增mock-only工具实现，不能将管理查询的真实PG证据扩大为Agent工具已完成。


## 2026-11-15 本批共享用例与工具验收

已补齐Agent专用日期范围/type/limit与提醒聚合共享用例 `createAgentCalendarReader` 和真实SQL端口 `createKyselyCalendarAgentReadPort`；管理查询既有语义不变。calendar工具组已通过注册器、SQLite及真实Host runtime/隔离PG续轮，现为已实现待接入；上文“仍阻塞”是历史盘点，不再代表当前状态。 完整测试、替身和限制见 [工具行为清单](node-agent-tools-parity.md#四组七工具及共享用例闭合2026-11-15)。
