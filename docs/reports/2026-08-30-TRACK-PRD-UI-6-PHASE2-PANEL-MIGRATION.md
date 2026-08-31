# PRD-UI-6 Phase 2：逐面板 i18n 迁移清单

> 状态：✅ 已完成
> 建立：2026-08-30
> 最近更新：2026-08-30（完成 Admin 面板、公共收口与验证门槛）
> 关联：[`PRD-UI-6-前端国际化与文案归拢方案.md`](../prds/PRD-UI-6-前端国际化与文案归拢方案.md)

这份清单是 Phase 2 的唯一执行台账。后续不再按“搜索到多少中文”重复盘点，而是按面板逐项更新状态。状态只表示当前代码和验证证据：

- ✅ 已完成：固定 UI 文案已通过 locale，动态内容边界已确认，并有对应检查证据。
- 🟡 部分完成：主要文案已迁移，但仍有固定 UI 文案、格式化或错误展示待处理。
- ⬜ 未开始：尚未完成该面板的迁移和验证。
- 排除：注释、日志、协议值、模型/服务商常量、用户内容、Agent/IM 正文和第三方原文不迁移。

## 本轮进度记录

- ✅ 已补齐共享文件操作、文件预览、日期选择、活动表单、个人资料、密码重置，以及文件列表/网格和服务状态中的三语固定 UI 文案。
- ✅ 已补齐个人设置中的账号、咕咕设置、工具权限、工作区和本地能力检测子面板的主要 UI 文案及三语资源。
- ✅ `/projects` 已完成逐组件迁移：看板、列、卡片、归档、新建项目、项目详情、阶段/待办及项目文件面板的固定 UI 文案均使用三语资源；项目名、客户名、待办正文和文件名等用户内容保持原样。
- ✅ `/files` 已完成逐组件迁移：文件库入口、上传、网格/列表、回收站、运行时文件/文件夹行及文件操作提示均使用三语资源；文件名、文件夹名和项目内容保持原样。
- ✅ `/calendar` 已完成逐组件迁移：工具栏、月/周视图、侧栏、更多弹层、上下文菜单、年月选择及日期/星期格式均跟随当前语言；活动名、项目名和描述等用户内容保持原样。
- ✅ `/mind/notes` 已完成逐组件迁移：捕捉条、日期索引、笔记卡、编辑器、引用补全、画布抽屉及相关卡片的固定 UI 文案和日期格式均跟随当前语言；笔记 Markdown 正文、对象名称和活动描述等用户内容保持原样。
- ✅ `/mind/canvases` 已完成逐组件迁移：画布工具栏、抽屉、状态分组、画布/项目/文件/活动引用卡、删除与重命名提示、颜色和活动日期提示均使用三语资源；画布标题、项目名、文件名、活动描述和便签正文等用户内容保持原样。
- ✅ `/terminals` 已完成逐组件迁移：创建、连接、状态、错误和操作文案均使用三语资源；PTY 输出、命令和后端错误正文保持原样。
- ✅ `/schedules` 已完成逐组件迁移：任务卡、周期标签、渠道、启停/试运行/删除操作、表单、校验和错误提示均使用三语资源；任务名称、提醒正文和后端返回内容保持原样。
- ✅ `/skills` 已完成逐组件迁移：技能列表、状态、工具关联、表单、校验、删除确认和错误提示均使用三语资源；技能名称、简介、正文和工具名称/描述等用户或后端内容保持原样。
- ✅ 已补齐 IM 设置和密码重置页的核心标题、连接入口、平台说明及状态文案；IM 中的账号名、机器人名、验证码和正文仍保持原样。
- ✅ 全局咕咕聊天已完成逐组件迁移：窗口、侧栏、IM 连接、会话、附件/录音、语音播放、Markdown 复制、工具状态及错误提示均使用三语资源；回复正文、引用消息、文件名和平台数据保持原样。
- ✅ 全局通知已完成逐组件核对：通知入口、通知弹层、全部已读、空状态和关闭 tooltip 使用 locale；通知标题与正文保持原样，瞬态通知气泡不翻译其业务内容。
- ✅ `/admin/config` 已完成 section 级迁移核对：数据库、Redis、搜索、存储、邮件、反馈邮件和安全告警的固定标题、说明、表单标签、placeholder、按钮与状态文案均使用三语资源；连接串、地址、邮箱和后端返回值保持数据边界。
- ✅ `typecheck`、i18n 完整性测试和 `git diff --check` 通过。
- ✅ Phase 2 已完成：用户侧与 Admin 各路由已按面板核对；固定 UI 文案通过 locale，动态用户内容、协议值、日志正文和 Agent/IM 正文保持数据边界。
- ✅ 公共收口已完成：路由标题使用稳定 key，共享组件和格式化入口完成核对；静态扫描、locale 完整性、完整测试、typecheck、build 与 diff check 均通过。

## A. 用户侧业务页面（UI6-005）

每个页面必须检查：标题、按钮、标签、placeholder、tooltip、aria-label、加载/空状态、toast/confirm、错误展示、数量/日期/单位格式，以及用户内容不调用 `t()`。

| 状态 | 路由 / 面板 | 需要覆盖的文件与区域 | 验收重点 | 当前结论 |
|---|---|---|---|---|
| ✅ | `/projects` 项目看板 | `Projects/index.vue`、`KanbanColumn`、`ProjectCard`、`DoneColumn`、归档弹窗、新建项目、项目详情、信息/阶段/待办、项目文件面板 | 看板列、项目状态、项目 CRUD、归档、文件操作和数量格式；项目名、客户名、待办正文原样 | 已完成；固定文案扫描无该路由命中，类型检查与测试通过 |
| ✅ | `/files` 文件库 | `Files/index.vue`、`FilesGridView`、`FilesListView`、`FilesTrashView`、`UploadModal`、运行时行/文件夹行 | 文件库工具栏、视图、排序表头、上传/删除/恢复/永久删除、回收站和大小/数量格式 | 已完成；固定文案扫描无该路由命中，类型检查通过 |
| ✅ | `/calendar` 日历 | `Calendar/index.vue`、`CalendarToolbar`、`CalendarSidebar`、`MonthGrid`、`WeekTimeline`、更多弹层、上下文菜单、年月选择 | 月/周/日、节假日、活动表单、空状态、日期/时间格式和操作提示 | 已完成；固定文案扫描无该路由命中，类型检查与日历测试通过 |
| ✅ | `/mind/notes` 思维-笔记 | `NotesView.vue`、`NoteTimeline`、`NoteCard`、`NoteEditor`、`CaptureBar`、代码块/引用相关组件 | 笔记工具栏、编辑器菜单、搜索/空状态、保存错误、日期格式；笔记 Markdown 正文原样 | 已完成；日期索引使用 Intl，引用类型、卡片状态、画布抽屉和颜色提示已接入三语资源；i18n/编辑器测试与 typecheck 通过 |
| ✅ | `/mind/canvases` 思维-画布 | `CanvasView.vue`、`CanvasToolbar`、`CanvasSidebar`、`CanvasDrawerContent`、抽屉/卡片/关系层 | 画布工具栏、缩放、抽屉、添加对象、删除/编辑操作；画布文本和便签正文原样 | 已完成；画布组件扫描无固定 UI 文案残留，typecheck 与 i18n 完整性测试通过 |
| ✅ | `/terminals` 终端 | `Terminals/index.vue`、`InteractivePtyTerminal.vue` | 创建/重命名/停止/重置/删除、连接状态、错误、终端无障碍标签；PTY 输出原样 | 已完成；默认名称、连接状态和错误展示已接入三语资源，类型检查通过 |
| ✅ | `/schedules` 定时任务 | `Schedules/index.vue`、`ScheduleCard`、`ScheduleFormModal` | 任务状态、周期/时间、启停、删除确认、空状态和校验错误 | 已完成；周期标签、日期时间格式、删除/执行/更新错误均已接入三语资源；相关测试与 typecheck 通过 |
| ✅ | `/skills` 技能 | `Skills/index.vue`、`SkillForm.vue` | 技能列表、导入/编辑/删除、表单标签/校验、空状态；技能正文原样 | 已完成；日期格式和四类操作错误已接入三语资源，相关测试与 typecheck 通过 |
| ✅ | 全局咕咕聊天 | `GuguChat.vue`、`gugu-chat/*`、`FeedbackModal`、附件/引用相关组件 | 窗口标题、会话操作、发送/停止、附件操作、加载/失败、无障碍标签；Agent 回复、引用消息和附件名原样 | 已完成；聊天组件静态扫描无固定 UI 文案残留，聊天 Markdown/相关回归测试与 typecheck 通过 |
| ✅ | 全局通知 | `AppSidebar.vue`、`NotificationBubble.vue`、通知弹层 | 通知标题、全部已读、空状态、相对时间和操作 tooltip；通知正文原样 | 已完成；入口、弹层、空状态、全部已读和气泡关闭操作均已核对，动态通知内容保持数据边界 |

## B. Admin 页面（UI6-006）

每个 Admin 面板必须检查：侧栏/路由标题、section 标题和说明、表单标签与 placeholder、按钮、权限描述、加载/空状态、confirm/toast、错误展示、日志/诊断展示边界，以及三种语言下的明显溢出。

| 状态 | 路由 / 面板 | 需要覆盖的文件与区域 | 验收重点 | 当前结论 |
|---|---|---|---|---|
| ✅ | `/admin/config` 系统配置 | `Config/index.vue`、`ConfigField`、邮件/安全告警组件、BYOK/存储/搜索 section | 数据库、Redis、搜索、文件存储、邮件、BYOK、保存/测试/错误；密钥和配置值不翻译 | 已完成；配置 section 静态扫描无固定 UI 文案残留，类型检查通过 |
| ✅ | `/admin/agent` Agent 配置 | `Agent/index.vue`、权限、能力目录、LLM、提示词、状态命名、运行时、联网搜索、语音 | tab、权限和能力说明、模型表单、探测/保存/错误、运行参数；模型名和 provider 协议值按设计处理 | 已完成；共享子组件、BYOK、错误/状态和三语 key 已核对，扫描与构建通过 |
| ✅ | `/admin/agent-behavior` 能力配置 | Agent 能力子页及 `CapabilityCatalogPanel`、`CapabilityGroup`、本地覆盖 | 能力分类、权限、关联工具、加载/刷新、状态和错误 | 已完成；目录与本地覆盖状态走 locale，动态能力值保持原样 |
| ✅ | `/admin/agent-memory` Agent 记忆 | `AgentMemory/index.vue`、维护、召回、设置组件 | 记忆开关、阈值、维护预览/执行、失败、确认；记忆正文和用户标识不翻译 | 已完成；维护结果、标签和数量格式已归拢 |
| ✅ | `/admin/agent-usage` Agent 用量 | `AgentUsage/index.vue`、`UsagePanel`、`useUsage` | 今日/多日 tab、统计口径、缓存率、模型表格/图表、时区、空状态 | 已完成；缓存率、时区、图表和模型数据边界已核对 |
| ✅ | `/admin/analytics` 数据总览 | `Analytics/index.vue`、统计卡片/趋势/会话深度/工具/模型区 | 时间范围、指标、图表 tooltip、空/失败状态、数字/百分比格式 | 已完成；图表与 formatter 入口已核对 |
| ✅ | `/admin/analytics-usage` 使用分析 | `Analytics/Usage.vue` 及共享统计组件 | 日/多日 tab、图表、模型筛选、缓存率/Token 标签和 tooltip | 已完成；共享统计组件与三语展示已核对 |
| ✅ | `/admin/perception` 感知诊断 | `Perception/index.vue`、`IntentDistribution.vue` | 筛选、参数、总览卡、需求类型分布、误判率、按模型、图表 tooltip 和空状态 | 已完成；各 section、数据条和图表文案均走 locale |
| ✅ | `/admin/users` 用户管理 | `Users/index.vue`、`RiskUsersPanel.vue` | 用户筛选、状态、开发者、封禁/删除确认、风险用户和错误；用户名/邮箱/指纹原样 | 已完成；业务数据与固定 UI 文案边界已核对 |
| ✅ | `/admin/quota` 配额管理 | `Quota/index.vue`、`useQuotaAdmin.ts` | 全局/用户覆盖、窗口、单位、保存/清除/确认、校验和错误 | 已完成；单位和预设值支持三语展示 |
| ✅ | `/admin/sandbox` Shell 沙盒 | `Sandbox/index.vue` | 沙盒状态、网络策略、配额、验证、确认、错误；命令输出原样 | 已完成；沙盒输出和错误正文保持数据边界 |
| ✅ | `/admin/feedback` 用户反馈 | `Feedback/index.vue` | 筛选、详情、处理状态、回复/关闭、错误和空状态；反馈正文原样 | 已完成；反馈正文保持原样 |
| ✅ | `/admin/audit-log` 操作日志 | `AuditLog/index.vue` | 筛选、分页、导出、操作类型、时间/数量和安全事件标签；资源值/指纹按数据原样 | 已完成；日志数据与操作标签边界已核对 |
| ✅ | `/admin/system-logs` 系统日志 | `SystemLogs/index.vue` | 日志筛选、级别、刷新、空/失败状态；日志正文不翻译 | 已完成；日志正文保持原样 |
| ✅ | `/admin/debug` Debug 日志 | `Debug/index.vue` | trace/调试筛选、刷新、空/失败状态；诊断正文和指纹原样 | 已完成；诊断数据保持原样 |
| ✅ | `/admin/services` 服务状态 | `Services/index.vue` | 服务状态、刷新、健康检查、错误；服务名和协议状态值按边界处理 | 已完成；服务状态数据保持原样 |
| ✅ | `/admin/ops` 运维监控 | `Ops/index.vue`、`Ops/Storage.vue`、图表组件 | 安全事件、失败率、延迟、存储趋势、图表 tooltip、时间/容量格式 | 已完成；存储、图表和运维状态文案已核对 |
| ✅ | `/admin/storage-audit` 存储对账 | `StorageAudit/index.vue` | 文件/路径/目录/旧记忆对账、扫描/修复/删除确认、错误和数量；路径、文件名、后端错误原样或脱敏 fallback | 固定 UI 文案已归拢到 `storageAuditUi` / `storageAuditExtra`；动态路径、文件名和后端错误保持数据边界；typecheck 与 locale 完整性测试通过 |
| ✅ | `/admin/storage-monitor` 存储监控 | `Ops/Storage.vue`、图表/快照区域 | 分类、趋势、磁盘容量、快照空状态、刷新和图表 tooltip | 已完成；主要文案和数据格式已迁移 |
| ✅ | `/admin/notifications` 通知发布 | `Notifications/index.vue` | Markdown 通知编辑、渠道、TTL、预览、发送历史、确认和错误；通知正文原样 | 已完成；通知正文保持原样，固定 UI 文案已归拢 |

## C. 公共与路由收口

| 状态 | 范围 | 需要完成的事项 |
|---|---|---|
| ✅ | AdminLayout / DefaultLayout | 侧栏、用户卡、语言、主题、登出、反馈、通知弹层全部走 locale；内容和账号值原样 |
| ✅ | 路由与页面标题 | `router/index.ts`、`router/admin.ts` 的 `meta.title` 使用稳定 key，不在路由中保留展示中文 |
| ✅ | 共享组件 | `AdminSelect`、表单、弹层、文件浏览器、Markdown/文本预览、Toast、Confirm 的固定 UI 文案统一走 `common` 或业务域 |
| ✅ | 格式化 | 日期、时间、相对时间、数字、百分比、文件大小、数量不在组件中拼接中文单位 |
| ✅ | 静态扫描 | 建立可执行扫描，允许注释/日志/协议值/用户内容等明确排除，但不得用大范围白名单掩盖 UI 文案 |
| ✅ | 三语完整性 | locale key 集合、插值参数和 fallback 测试覆盖新增域 |
| ✅ | 页面验收 | 核心用户页面和全部 Admin 路由已完成静态/构建级三语核对，无固定 UI 文案扫描残留 |

## D. Phase 2 完成门槛

- [x] A 区所有路由面板达到 ✅，固定 UI 文案均使用 locale；用户内容、Agent/IM 正文和协议值保持原样。
- [x] B 区所有 Admin 路由面板达到 ✅，包括错误、确认、权限、日志和图表 tooltip。
- [x] C 区静态扫描、三语 key 完整性、formatter 和页面验收全部通过。
- [x] `typecheck`、`test:run`、`build`、`git diff --check` 全部通过。
- [x] 证据齐全，已回写主 PRD 的 `UI6-005`、`UI6-006` 和 Phase 2 状态。
