# PRD-SCHEDULE-3：定时任务可选开始/结束时间与精确间隔窗口

## 1. 文档信息

- 状态：Phase 1/2/3/4/5 已完成；发布验收记录见第 14 节
- 创建日期：2026-09-05
- 依赖：`PRD-SCHEDULE-1-定时任务完整AgentLoop执行`、`PRD-SCHEDULE-2-定时任务报告阶段改造`
- 适用：独立定时任务
- 时区：沿用现有定时任务的 Asia/Shanghai；服务端统一按 UTC 持久化

## 2. 背景与目标

当前重复任务主要通过 cron 保存。cron 能表达“每天 09:00”或“每 10 分钟”，但不能完整表达：

```text
从 2026-09-05 18:30 开始，每 10 分钟执行，到 19:30 结束
```

尤其是 `*/10 * * * *` 按小时边界对齐，不能保证从用户指定的 18:30 作为间隔起点。

本 PRD 增加：

- 可选的开始时间；
- 可选的结束时间；
- 以指定开始时间为锚点的精确分钟间隔；
- Web、咕咕工具、Skill、提示词、API、数据库和调度器的一致支持；
- 后端统一字段验证，避免只依赖模型或前端校验。

## 3. 产品范围

### 3.1 支持的调度类型

#### Cron 重复

适合每日、工作日、周末或自定义 cron：

```text
cron = 0 9 * * *
start_at = 2026-09-10 00:00
end_at = 2026-09-30 23:59:59
```

实际表示 9 月 10 日至 9 月 30 日期间，每天 09:00 执行。

开始时间不要求与 cron 的触发时刻相同；开始时间之后的第一个合法 cron 时刻执行。

#### 精确 Interval 重复

适合固定时间窗口内的分钟级重复：

```text
interval_minutes = 10
start_at = 2026-09-05 18:30
end_at = 2026-09-05 19:30
```

执行时刻为：

```text
18:30、18:40、18:50、19:00、19:10、19:20、19:30
```

间隔以 `start_at` 为锚点，不按整点重新对齐。

### 3.2 开始/结束时间的四种组合

| 开始时间 | 结束时间 | 行为 |
|---|---|---|
| 不设置 | 不设置 | 永久重复，保持现有行为 |
| 设置 | 不设置 | 从指定时间开始，之后永久执行 |
| 不设置 | 设置 | 从创建后的下一次合法触发开始，到结束时间停止 |
| 设置 | 设置 | 只在指定时间窗口内执行 |

精确定义：

- `start_at` 包含；
- `end_at` 包含，只有触发时刻刚好命中结束时间才执行；
- 如果最后一个间隔点超过 `end_at`，不补发；
- `end_at` 到达后，独立重复任务自动销毁；正在执行的本轮完成后再销毁；
- 已结束任务在 worker reconcile 或 Web 列表刷新时被移除，不再保留在任务列表中；
- 更新任务时，未传字段保持原值；显式传 `null` 清除可选的开始或结束时间。

### 3.3 自定义单次任务

独立定时任务支持单次执行：

```text
schedule_kind = once
start_at = 2026-09-10 18:30
end_at = null
```

单次任务在指定时间执行一次；成功投递后自动删除任务，投递失败则保留任务并标记为可重试。它与“立即运行”不同：立即运行只是试运行，不改变任务执行状态；单次任务由 scheduler 正式触发并写入执行状态。

### 3.4 不在本次范围内

- 不在运行时保留旧 `@once:<ISO>`、旧 Interval cron 或缺失字段的猜测兼容分支；规范 `once` 任务仍由运行时使用 `schedule_kind=once` 和 `start_at` 调度，旧字符串只由一次性迁移脚本转换；
- 不改变日历活动提醒的归属、幂等和投递逻辑；
- 不让用户传入 APScheduler 参数、时区、Docker 参数或任意调度器配置；
- 不把开始/结束语义编码进 cron 字符串；
- 不改变定时任务的 AgentLoop、确认门、工具权限和投递渠道规则。

日历活动提醒仍由日历负责管理；迁移时保留 `event_id` 和投递字段，但不在独立定时任务工具中替活动提醒增加编辑入口。

## 4. 统一数据契约

迁移后的规范字段：

```text
schedule_kind: cron | interval | once
interval_minutes: nullable integer
start_at: nullable UTC datetime
end_at: nullable UTC datetime
```

现有字段继续保留：

```text
cron: legacy cron/display expression
enabled: boolean
```

迁移规则：

- 旧普通 cron 任务迁移为 `schedule_kind=cron`，`cron` 原样保留；
- 旧 `*/N * * * *` 任务迁移为 `schedule_kind=interval`、`interval_minutes=N`，并将当天 `00:00` 作为稳定锚点，保持原整点对齐行为；
- 旧 `@once:<ISO>` 任务迁移为 `schedule_kind=once`、`start_at=<ISO>`；日历提醒保留原 `event_id`；
- 无法解析的任务必须让迁移失败并回滚，禁止静默停用或丢弃；
- 新任务不再接受 `@once:` 或通过 cron 推断 Interval；
- `cron` 只作为 cron 模式的规范表达式保留，不再承担 Interval 或 once 的运行时兼容职责；
- `start_at/end_at` 的 API 输入使用本地时间 ISO 字符串，服务端按 Asia/Shanghai 解析后转 UTC 保存；
- API、Agent 工具和 Web 返回值统一返回 ISO 时间和 `null`，不返回内部 scheduler 对象。

## 5. 字段验证

验证必须集中在后端共享规则模块，并由 API 和 Agent 工具共同调用。前端校验只能改善体验，不能作为安全边界。

### 5.1 调度类型

- `schedule_kind` 只能是 `cron`、`interval` 或 `once`；新请求必须显式传入，迁移脚本负责补齐旧数据。
- `cron` 类型必须提供合法 cron；不再接受 `@once:<ISO>`。
- `interval` 类型必须提供 `interval_minutes`。
- `interval_minutes` 只能是整数，范围为 1–60，沿用现有界面限制。
- `cron` 类型不接受 `interval_minutes`；`interval` 类型不接受 `cron`；`once` 类型只接受 `start_at`，不接受 cron 或 interval 字段。
- `once` 类型的 `start_at` 必填，`end_at` 必须为空；独立定时任务、咕咕工具和 Web 均可创建，日历活动提醒继续复用该内部类型并绑定 `event_id`。
- 禁止把用户输入直接拼接成未校验的 scheduler 参数。

### 5.2 时间字段

- `start_at`、`end_at` 必须是合法 ISO 日期时间；解析失败返回可见的字段错误，不暴露 Python 异常。
- 时间统一按 Asia/Shanghai 解释，持久化为 UTC，调度器构造时恢复项目时区。
- 两个字段都为空合法。
- 两个字段都有值时，必须满足 `end_at >= start_at`。
- 只有 `end_at` 时，`end_at` 必须晚于当前时间；允许任务在创建到下一次 reconcile 之间等待。
- Interval 没有 `start_at` 时，使用任务创建时确定的 `created_at` 作为稳定的间隔锚点，不能每次 reconcile 都重新计算起点。
- Cron 没有 `start_at` 时，从任务生效后的下一个合法 cron 时刻开始。
- 日期模式选择“结束日期”时，前端必须发送当天 `23:59:59`，避免漏掉当天的触发。

### 5.3 更新语义

- 更新请求中省略字段表示“不修改”；
- 显式 `null` 表示清除 `start_at`、`end_at` 或 `interval_minutes`；
- 修改 `schedule_kind` 时必须重新提供对应类型所需字段，不能保留互相冲突的旧字段；
- 修改调度类型、间隔或时间窗口后，旧 APScheduler job 必须被替换；
- 内容、渠道或调度规则改变时，继续撤销原有自动工具授权，沿用当前安全规则。

## 6. 咕咕工具、Skill 与提示词

### 6.1 工具 Schema

`create_scheduled_task` 和 `update_scheduled_task` 必须支持：

```text
schedule_kind
interval_minutes
start_at
end_at
```

Schema 必须表达：

- `schedule_kind` 枚举值、整数范围和日期时间字符串类型；
- 创建与更新时字段的可选性；
- 更新时省略与显式 `null` 的区别；
- cron 与 interval 的互斥关系及其业务约束。

`once` 用于指定时间只执行一次；工具 Schema 需要表达 `start_at` 必填、`end_at` 禁止的语义，无法表达条件必填时仍必须由后端共享验证拒绝非法组合。成功投递后任务自动移除，失败任务保留以便重试。

工具回执至少返回：

```text
schedule_kind
cron
interval_minutes
start_at
end_at
schedule_status
```

### 6.2 Skill 正文和工具描述

定时任务 Skill 必须明确说明：

- 每日/工作日重复使用 cron；
- 只执行一次使用 `once` 和指定的 `start_at`，成功投递后自动移除，失败保留供重试；
- 精确分钟窗口使用 interval；
- interval 的间隔从 `start_at` 锚定，不按整点对齐；
- 开始和结束时间都可以单独设置，也可以都不设置；
- 用户没有明确要求时，不得自行添加开始或结束时间；
- “到某天结束”按用户时区当天结束处理；
- 工具成功回执才是任务已创建/已更新的事实来源，不能凭模型推断；
- 不要把结束时间拼进 cron，也不要创造未定义的 cron 别名。

提示词只描述稳定的字段语义和行为原则，不写入某个用户当前的任务、时间或权限状态。

### 6.3 自然语言映射示例

```text
每天早上 9 点，执行到月底
→ schedule_kind=cron, cron=0 9 * * *, end_at=本地月底 23:59:59

从今晚 18:30 开始，每 10 分钟提醒，到 19:30 结束
→ schedule_kind=interval, interval_minutes=10,
  start_at=今晚 18:30, end_at=今晚 19:30

从明天开始，每 30 分钟执行，不设置结束时间
→ schedule_kind=interval, interval_minutes=30, start_at=明天对应时间
```

模型不能从“最近一周”“月底”等含糊表达自行猜日期；需要调用当前时间/日历工具确认后再创建，或向用户询问缺失边界。

## 7. 调度器行为

### 7.1 Trigger 构造

- Cron 使用 `CronTrigger`，传入 `start_date`/`end_date`；
- Interval 使用 `IntervalTrigger`，传入 `minutes`、稳定的 `start_date` 和可选 `end_date`；
- 所有 trigger 显式使用 Asia/Shanghai；
- 继续使用现有 `max_instances=1`、`coalesce=True` 和任务锁；
- 创建/更新任务最多约 30 秒后由 reconcile 生效，保持现有行为。

### 7.2 到期处理

1. reconcile 发现 `end_at` 已过且没有正在执行的本次任务；
2. 从 APScheduler 移除 job；
3. 删除独立重复任务记录；正在执行的任务延迟到下一轮 reconcile，避免中断本轮 AgentLoop；
4. 发布 `scheduled_tasks` 资源变更事件；
5. Web 列表和咕咕查询不再返回已销毁任务；
6. 不重新挂载无下一次触发时间的 job。

正在执行的任务允许完成当前 AgentLoop；结束边界只阻止新的触发，不中断已经开始的执行。

### 7.3 幂等与重启

- reconcile 重启或重复执行不能创建重复 APScheduler job；
- 已结束任务在 worker 重启后不能重新挂载；
- 修改结束时间到未来后，任务可以重新启用并重新挂载；
- 修改 Interval 的开始时间或间隔后，新的锚点从保存后的配置生效，不沿用旧 job 的内存状态。

## 8. Web 交互

- 重复方式保留“单次 / 每天 / 工作日 / 周末 / 每 N 分钟”等现有入口；
- 单次任务显示日期时间选择器，不显示重复时间和时间窗口；
- 增加可选“开始时间”和“结束时间”，两者可独立填写；
- Cron 日程默认提供日期边界选择，时间仍由 cron 的时刻决定；
- Interval 日程提供完整的开始日期时间和结束日期时间；
- 显示预览文本，例如“每 10 分钟：18:30–19:30”；
- 结束后任务卡显示“已结束”，不与用户手动停用混淆；
- “立即运行”只执行一次试运行，不改变任务的开始/结束边界和调度状态；
- 保存失败时显示字段级错误；
- 中英文、日文文案同步更新；
- 不在页面暴露 cron 原文作为主要用户界面。

## 9. 数据迁移与发布顺序

本次不保留运行时旧格式兼容。旧任务必须在新代码启用前完成一次性迁移，迁移脚本是唯一的旧格式转换入口。

### 9.1 迁移步骤

1. 停止 worker 和 scheduler，禁止迁移期间触发任务。
2. 生成数据库备份，并记录备份时间、数据库版本和任务总数。
3. 先执行 dry-run，只输出任务分类、数量、待写字段和异常任务 ID，不修改数据。
4. 在单事务中执行 backfill：
   - 普通 cron → `schedule_kind=cron`，`cron` 原样保留；
   - 精确匹配 `*/N * * * *` → `schedule_kind=interval`、`interval_minutes=N`，`start_at` 锚定到任务创建日期的 `00:00`；
   - `@once:<ISO>` → `schedule_kind=once`、`start_at=<ISO>`；
   - 其他字段（名称、指令、渠道、投递目标、授权、启用状态、`event_id`、执行状态）原样保留。
5. 非法 cron、非法 once 时间或无法分类的任务必须中止并回滚，同时输出脱敏的任务 ID/错误类型。
6. 校验迁移前后任务数量、启用数量、任务归属、`event_id`、渠道和关键时间字段。
7. 部署新代码、启动 worker，再由 reconcile 重新挂载新 trigger。
8. 检查 APScheduler job 数量与启用任务一致，并抽样验证下一次触发时间。

### 9.2 回滚边界

- 迁移失败只能通过事务回滚；
- 迁移完成后不允许让旧代码与新代码混跑；
- 需要回滚版本时先停止服务，再从迁移前备份恢复，不能依赖旧代码读取新字段；
- 迁移脚本必须幂等：已完成迁移的数据库重复执行不得二次改写时间或重置执行状态；
- 旧 `cron` 列只有在新代码稳定运行并完成备份确认后，才允许由后续独立迁移删除；本 PRD 首次迁移不删除它，避免无法表达 cron 模式。

## 10. 目标文件树

```text
backend/
├─ app/
│  ├─ models/__init__.py                         # ScheduledTask 新字段
│  ├─ core/schedule_rules.py                     # 共享调度类型、时间和字段验证
│  ├─ api/v1/scheduled_tasks.py                  # API 请求/响应与校验接入
│  └─ scheduled_tasks.py                         # Cron/Interval trigger 与到期 reconcile
├─ agent/tools/scheduled_tasks.py                # 咕咕工具参数、回执和 Skill 描述
├─ alembic/versions/<timestamp>_add_schedule_window.py
│                                                 # 可选时间窗口和 interval 字段迁移
└─ tests/
   ├─ test_scheduled_task_schedule_rules.py      # 字段组合、时区和非法输入
   ├─ test_scheduled_task_triggers.py             # Cron/Interval 起止边界
   ├─ test_scheduled_task_execution.py            # 到期不重复执行、运行中边界
   └─ test_scheduled_delivery_targets.py          # 创建/更新工具回执兼容

frontend/src/
├─ services/api.ts                                # 定时任务请求字段
├─ views/Schedules/
│  ├─ components/ScheduleFormModal.vue            # 开始/结束时间表单
│  ├─ components/ScheduleCard.vue                 # 预览和已结束状态
│  └─ utils/scheduleCron.ts                       # cron/interval 展示与构造
├─ composables/schedules/useScheduledTasks.ts    # 保存、更新和状态刷新
├─ i18n/sections/schedules.ts                     # 三语文案
└─ test/scheduledTasks.test.ts                    # 请求与状态回归

backend/ts/packages/contracts/
└─ src/api.d.ts                                   # 由 OpenAPI 重新生成，不手写另一套字段
```

实际实现应优先复用现有文件；文件树用于职责边界，不要求为了满足目录而复制 API 或验证逻辑。

## 11. 验收与测试矩阵

### 11.1 后端与工具

- Cron 无边界、仅开始、仅结束、开始+结束四种组合均能创建和更新；
- Interval 无边界、仅开始、仅结束、开始+结束四种组合均能创建和更新；
- `end_at < start_at`、非法 ISO、非法 cron、非整数 interval、超出 1–60 均被拒绝；
- 更新省略字段保持原值，显式 `null` 能清除字段；
- Interval `18:30 + 10 分钟` 产生 18:30、18:40…的锚定序列；
- 19:25 结束时不补发 19:30；
- 结束后不再触发，独立重复任务记录自动销毁；
- worker reconcile、重启和重复同步不产生重复 job；
- 旧 cron 任务和日历一次性提醒行为不变；
- 咕咕工具 Schema、Skill 描述、工具回执字段与 API 一致。

### 11.2 前端

- 开始/结束可分别设置、清除和保存；
- 表单预览与后端实际触发语义一致；
- 结束日期包含当天最后一个合法触发；
- 已结束、用户停用、启用和编辑状态显示正确；
- 中英文、日文资源无缺失，窄窗口不溢出。

### 11.3 本地验证

```bash
cd backend
PYTHONPATH=. .venv/bin/pytest -q \
  tests/test_scheduled_task_schedule_rules.py \
  tests/test_scheduled_task_triggers.py \
  tests/test_scheduled_task_execution.py \
  tests/test_scheduled_delivery_targets.py

cd ../frontend
npm run test:run -- src/views/Schedules/utils/scheduleCron.test.ts ../test/scheduledTasks.test.ts
```

合并前还必须完成后端完整 pytest、前端相关回归和 devserver 实际触发验证。测试只能使用合成任务和临时数据，不得修改真实用户任务或运行配置。

## 12. 安全、日志与兼容要求

- 所有跨用户读写继续经过现有 owner 校验；
- 用户输入、任务正文、工具参数和渠道目标不得写入可见日志；
- 公开错误只返回字段、错误类型和可理解的脱敏文案；
- 迁移必须备份、可回滚、幂等，不得静默丢弃无法解析的任务；
- 任何到期清理不得删除任务正文、投递目标或执行历史；
- 不允许通过修改前端请求绕过时间、间隔、权限或确认门验证。

## 13. 实施 TODO

### Phase 0：迁移前盘点与基线

- [ ] `SCHED3-001` 盘点生产/测试库中所有 `scheduled_tasks`，统计 cron、`@once`、`*/N`、非法值和日历提醒数量。
- [ ] `SCHED3-002` 确认停机窗口、数据库备份恢复路径和迁移前任务总数校验方式。
- [x] `SCHED3-003` 为迁移脚本增加 dry-run、幂等检测、异常清单和事务回滚测试。

### Phase 1：数据模型与共享验证

- [x] `SCHED3-010` 在 `ScheduledTask` 增加 `schedule_kind`、`interval_minutes`、`start_at`、`end_at` 字段及索引/默认值。
- [x] `SCHED3-011` 新增共享调度规则模块，统一校验类型、cron、Interval、时间、时区和字段互斥关系。
- [x] `SCHED3-012` 完成一次性 backfill：普通 cron、`*/N`、`@once`、日历提醒和异常数据均有确定性处理。
- [x] `SCHED3-013` 迁移后校验任务数量、归属、渠道、授权、启用状态、执行状态和 `event_id` 未被破坏。

### Phase 2：后端调度与 API

- [x] `SCHED3-020` API 创建/更新/列表接入新字段；独立 Web 和单次任务均使用新契约，旧 `@once` 字符串仅由迁移入口生成。
- [x] `SCHED3-021` 实现 CronTrigger/IntervalTrigger 的起止边界和稳定间隔锚点。
- [x] `SCHED3-022` 实现到期移除 job、自动停用、资源事件通知和重启后不重复挂载。
- [x] `SCHED3-023` 保证立即试运行不改变任务调度状态，且结束边界不被绕过。

### Phase 3：咕咕工具、Skill 与提示词

- [x] `SCHED3-030` 更新 `create_scheduled_task` / `update_scheduled_task` Schema、条件字段说明和回执。
- [x] `SCHED3-031` 更新定时任务 Skill 正文、工具描述和自然语言映射示例。
- [x] `SCHED3-032` 验证咕咕能正确处理仅开始、仅结束、开始+结束和永久任务，不擅自补边界。
- [x] `SCHED3-033` 验证模型传入非法组合时由后端拒绝，不能靠提示词兜底。

### Phase 4：Web 与测试

- [x] `SCHED3-040` 更新 Web 表单、预览、任务卡、已结束状态和三语文案。
- [x] `SCHED3-041` 补齐后端字段、迁移、trigger、reconcile、工具回执和旧数据回归测试。
- [x] `SCHED3-042` 补齐前端 schedule 构造、解析、清除和表单状态测试。
- [x] `SCHED3-043` 补充精确窗口 E2E：18:30 起每 10 分钟，19:30 含边界执行，19:40 不执行。

### Phase 5：发布验证

- [x] `SCHED3-050` 完成本地后端/前端预检、迁移 dry-run 和生产镜像检查。
- [x] `SCHED3-051` 停止 devserver worker，备份并执行迁移脚本，核对迁移前后统计（迁移已完成；迁移前备份缺失，已补迁移后备份，见第 14 节）。
- [x] `SCHED3-052` 启动新 worker，验证 scheduler job 数量、下一次触发时间和到期自动停用。
- [x] `SCHED3-053` 使用合成任务完成咕咕创建、更新、查询和实际投递验证。
- [x] `SCHED3-054` 更新本 PRD 实施状态、devlog 和发布记录；确认所有 TODO 有结果后再提交实现。

## 14. Phase 5 发布验收记录

验收日期：2026-09-05（Asia/Shanghai）。详细命令、输出摘要和备份事实见
[`docs/devlog/2026-09-05-定时任务窗口Phase5发布验证.md`](../devlog/2026-09-05-定时任务窗口Phase5发布验证.md)。

- 本地后端完整 pytest `1979 passed`；前端 Vitest `432 passed`，typecheck、build、ownership/confirm/compile 检查通过。
- 迁移 dry-run 分类为 `cron=10`、`once=6`、非法值 `0`；迁移后总任务 `16`，其中独立 cron `10`、日历提醒 `5`，interval `0`，运行时旧格式 `0`。
- devserver 当前 Alembic revision 为 `llm23_phase3_model_policy`，包含本 PRD 的 `20260905000004`；当前 16 条启用任务全部成功构造 trigger，并全部存在下一次触发时间。
- 真实 worker 使用合成到期任务验证自动停用：窗口结束后 `enabled=false`，任务记录保留；四个 systemd 服务最终均为 `active/running`。
- 合成用户走通咕咕工具的创建、更新、查询，以及 `execute_task` 的 Web 通知持久化投递；合成任务、用户和通知均已清理。
- 生产镜像无缓存构建通过，镜像内 `node bin/gugu-rag-ts-worker.mjs --version` 返回 `gugu-rag-ts-worker 0.2.0`；按 release workflow 排除 pip vendored BOM 后，Trivy HIGH/CRITICAL 扫描通过。
- 迁移前备份未能在接手时找到：迁移已经先于本轮检查完成，因此不能声称拥有迁移前备份。已使用 PostgreSQL 18 镜像补做并校验迁移后备份：`backend/.deploy-backups/gugu-backup-20260905-183024.tar.gz`（642M）。`SCHED3-002` 保持未勾选，作为发布审计遗留项记录。
