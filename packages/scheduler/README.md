# @gugu/scheduler

Gugu 的独立 TypeScript 调度包。SaaS、Web Host 和桌面端可以复用相同的排程规则。包无运行时依赖，通过端口接入任务仓储、租约、触发收据和业务执行。通用 SQL 适配由 `@gugu/database/scheduled-tasks` 提供。Core 负责绑定可信身份、Agent、工作区权限和 RAG，渠道投递由宿主装配。

## 目录职责

```text
packages/scheduler/
├── src/
│   ├── index.ts               公开 API
│   ├── cron.ts                Cron 校验、匹配和触发时间
│   ├── interval.ts            间隔触发窗口
│   ├── next-fire.ts           周期任务的下一次触发
│   ├── normalize-schedule.ts  任务输入校验及日期序列化
│   ├── date-time.ts           日历日期键和时区零点
│   ├── timer.ts               定时器、任务协调及生命周期
│   ├── runner.ts              一次性任务租约、执行和恢复
│   ├── repeating-dispatch.ts  周期触发去重与执行
│   └── tasks/
│       ├── index.ts           任务用例 API
│       ├── task-write.ts      创建、更新与输入校验
│       ├── task-delete.ts     归属内删除与提交后事件
│       ├── run-now.ts         手动运行、失败重试与等待窗口
│       └── test-notify.ts     试投递编排
├── package.json               导出、构建入口与依赖
├── tsconfig.json              TypeScript 编译配置
└── dist/                      构建生成的 JavaScript 和类型声明
```

## 公开 API

从 `@gugu/scheduler` 导入以下能力。

| API | 契约 |
|---|---|
| `normalizeSchedule(input, validateCron, now?)` | 校验并规范化一次性、Cron、间隔任务。失败抛出 `ScheduleValidationError`。`scheduleTimestamp`、`scheduleMicroseconds`、`shanghaiWallMilliseconds` 支持现有时间编码。 |
| `validateTaskCron`、`matchesCronMinute`、`nextCronFire` | 按兼容 APScheduler 的现有规则校验、匹配和计算触发。Cron 使用上海时区。可用 `crontabWeekdayToApscheduler` 转换传统 crontab 的星期字段。 |
| `nextIntervalFire(input)` | 以开始时间为锚点，返回大于等于 `after` 的下一次触发。 |
| `nextRepeatingFire(schedule, after)` | 返回严格晚于 `after` 且在计划窗口内的下一次触发。无匹配时返回 `null`。 |
| `createScheduledTaskTimer(options)` | 注入任务读取、触发回调、时钟、定时器和诊断处理。返回 `start()`、`refresh()`、`stop()`。默认每 30 秒对账，`stop()` 等待协调和在途触发结束。 |
| `ScheduledTaskRunner` | 使用 `OnceTaskRepository`、`ScheduledTaskLease` 和执行回调运行一次性任务。提供 `runDue`、`recoverAbandoned`、`collectExpiredOnce`。 |
| `dispatchRepeatingFire(options)` | 获取任务租约后复核计划，通过 `ScheduledFireReceipts` 原子认领触发。返回 `busy`、`stale`、`duplicate`、`completed` 或 `unknown`。 |

`@gugu/scheduler/date-time` 导出 `dateKeyInTimeZone` 和 `startOfDateKeyInTimeZone`。调度 API 的数字时间为 Unix 毫秒。

租约端口必须用持有者令牌做条件续租和释放。触发收据必须原子保证同一任务、同一触发时刻只有一次认领。执行器应在模型调用和投递等副作用边界调用 `assertLease()`。已认领或结果未知的周期触发不会被自动重发。外部投递成功后、回执提交前的进程中断仍可能留下未知结果，投递端需要自己的幂等契约。

## 任务用例与数据库适配

| API | 契约 |
|---|---|
| `@gugu/scheduler/tasks` 的 `createScheduledTask`、`updateScheduledTask` | 校验计划、渠道和工具字段，通过调用方端口解析资源并持久化。 |
| `createScheduledTaskDeleter` | 通过可信归属端口解析 owner，删除事务提交后发布事件。 |
| `createScheduledTaskRunNow` | 先读取 owner 下的任务，再进入试运行或失败一次性任务的重试。等待窗口到期时返回运行中，后台操作继续。 |
| `createScheduledTaskTestNotifier` | 解析并执行测试投递，通过端口接入实际渠道。 |
| `@gugu/database/scheduled-tasks` | 一次性和周期任务仓储、触发收据、SQLite 租约、列表及删除 SQL。调用方注入时间和身份编码，以及事务内的删除、停用钩子。 |

Core 的 `tasks/` 装配已验证的身份、查询投影与事务副作用。定时任务 Agent 位于 `agent/scenes/task/`，桌面适配位于 `runtime/desktop-schedules/`，工作区授权和 RAG 分别由 `workspaces/`、`agent/rag/` 管理。

## Gugu 独立 Worker

Gugu 的宿主适配器通过 TypeScript API 启动 Worker。调用方可以在自己的服务进程中装配和关闭它。

```ts
import { startScheduledTaskWorker } from '@gugu/webui/scheduler-worker'

const worker = await startScheduledTaskWorker(environment)
// 在服务关闭钩子中等待在途执行结束。
await worker.close()
```

`environment` 使用 Web Host 的现有运行配置契约。Worker 不绑定 HTTP 端口。其他 SaaS 运行时也可以直接导入 `@gugu/scheduler`，注入其自身的任务仓储、租约和执行端口。

同一个部署中的 API 进程使用 `GUGU_WEBUI_SCHEDULER_MODE=external`，关闭 API 进程内的到期调度。未设置该值时维持原来的内嵌模式和开关默认值。独立进程默认启用一次性和周期任务，可用 `GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED` 和 `GUGU_WEBUI_REPEATING_TASK_WORKER_ENABLED` 关闭单类任务。采用独立模式时，两类进程的任务开关应保持一致。

Worker 与 API 使用同一部署的 PostgreSQL、Redis、现有迁移和执行所需配置。SaaS 通过用户鉴权的 `/api/v1/scheduled-tasks` 查询及创建任务，通过 `PATCH /api/v1/scheduled-tasks/:id` 改期，通过 `POST /api/v1/scheduled-tasks/:id/run` 手动运行。API 提交变更后通过 Redis 发送无正文唤醒信号，Worker 周期性重读数据库，也会在重连后重新协调。唤醒信号不持久化，断线期间仍适用现有误点窗口，已错过窗口的触发按原规则处理。存储保留原任务 ID、租约键和触发收据。切换时关闭该数据集的旧调度循环，再启动独立 Worker。

## 开发验证

```sh
corepack pnpm --filter @gugu/scheduler build
corepack pnpm --filter @gugu/core build
corepack pnpm --filter @gugu/webui exec node --import tsx --test "tests/scheduled-tasks/schedule/*.test.ts" "tests/scheduled-tasks/run/*.test.ts"
```

Web Host 的调度用例验证通过真实调用入口消费包 API。PostgreSQL/Redis 集成用例需要独立测试服务。

使用专用 PostgreSQL 和 Redis 测试服务时，将连接通过 `GUGU_WEBUI_TEST_DATABASE_URL` 和 `GUGU_WEBUI_TEST_REDIS_URL` 注入，然后运行 `corepack pnpm --filter @gugu/webui exec node --import tsx --test tests/host/main/scheduler-worker.integration.test.ts`。用例通过启动 API 创建两个 Worker 实例，验证 API 改期唤醒、重复竞争去重和退出清理。
