# Node Agent 总览工具的共享查询缺口

`get_upcoming`、`get_dashboard_stats`仍依赖阻塞。Python基准为`backend/agent/tools/overview.py`和`backend/app/services/overview.py`。本记录是查询消费契约，不新增工具、SQL或成功响应替身。

## Python可观察行为

- `get_upcoming.days`为整数1–366，默认7。当前日期来自可信用户时间上下文；范围从today到today+days，包含两端。
- 未删除、未归档、非done且deadline非空的owner项目按范围筛选。日历只过滤owner、未删除和日期范围；不附加项目状态、事件类型或归档规则。
- 项目投影`kind=project_deadline/date/title/project_id/status`，事件投影`kind=原type/date/title/event_id/project_id`。先项目后事件合并，再按date稳定排序；同日期不擅自添加ID/标题排序。返回`from/to/count/items`，不截成上下文的10项。
- `get_dashboard_stats`按owner计数：未删除且未归档项目分别按pending/active/done计数，total是三者之和。
- upcoming_events是所有未删除且date>=today的事件数量，没有7天或10项限制。
- files是该owner全部未删除文件，不能只统计personal；clients是该owner全部联系人。

## 当前Node实现不能替代这些查询

定位到的`apps/web-host/src/modules/agent-sessions/context/agent-overview-postgres.ts`属于尚未生产装配的上下文原型：`createAgentOverviewSources`被`createAgentContextAssembly`组合，但后者尚无生产调用；`formatAgentProjects`只有测试引用。不能因这些导出或PG测试通过认定总览工具已接入。

其项目查询是上下文分组优先级/限额投影；日历仅返回date/title的未来10项；文件概览限定personal；笔记是近7天20项。这些范围与工具契约不同。即使将格式函数移入Core，也不会补齐工具所需业务。

## 交给共享领域服务的边界

可信Host验证用户/会话身份和时区，提供同一时刻的today/until；模型不能注入owner、凭据或数据库选择。公共服务应提供下列完整结果，Tools只做参数校验和结果投影：

```ts
upcoming(identity, { today, until }, signal)
  // owner内完整的项目截止与日历事件最小记录；无隐式限额
counts(identity, { today }, signal)
  // pending/active/done/upcoming_events/files/clients 非负整数
```

查询owner与软删除过滤在共享仓储执行，不在Tools用全库读取后过滤。PG和SQLite各自复用既有领域持久化，不能为了这两个工具再写旁路SQL。取消等待资源清理，缺服务时不注册工具，错误不泄露数据库或凭据。跨查询是否使用一致读事务须由公共领域服务明确，不能把几次HTTP列表采样当作同一统计结果。

验收应经过实际注册器/Harness调用和隔离双库，覆盖跨owner、归档/软删、日期端点与时区跨日、同日稳定顺序、超过10项、全部文件空间及没有7天上限的事件计数。当前缺这些共享入口和真实消费链；没有新增mock-only工具来代替验收。


## 2026-11-15 近期待办工具组合

`get_upcoming` 已在 `agent/tools/overview.ts` 组合现有完整项目列表与 CalendarEventReadPort，不复用限额上下文概览，也不新增SQL。可信时区与时间由Host注入，固定默认7天、日期含首尾、过滤完成/归档/软删与owner隔离，经真实SQLite和实际注册器/Agent续轮验证。Host工厂要求events和time两项能力同时具备；仍待生产装配。总览统计的全文件计数仍缺完整共享能力，不以文件库根层统计或上下文限额冒充 `get_dashboard_stats` 完成。证据见工具行为迁移清单。


## 2026-11-15 本批共享用例与工具验收

新增共享 `createKyselyDashboardCounter`，一次SQL计算owner项目分状态、无上界未来活动、全部存活文件和联系人；Host可信时区产生today。get_dashboard_stats已通过实际注册器、SQLite与Host runtime/隔离PG续轮，现为已实现待接入；上文缺共享统计的结论已由本批替代。 完整测试、替身和限制见 [工具行为清单](node-agent-tools-parity.md#四组七工具及共享用例闭合2026-11-15)。
