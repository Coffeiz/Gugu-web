# PRD-UI-6 前端国际化与文案归拢方案

> 状态：🟡 Phase 0 已完成，等待 Phase 1
> 创建：2026-08-30
> 最近更新：2026-08-30
> 关联模块：`frontend/src/`、`backend/app/api/`、`docs/prds/`
> 背景参考：`docs/prds/【已完成】PRD-UI-5-CSS样式职责收口与主题层统一.md`、`frontend/src/router/`、`frontend/src/services/`

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| i18n runtime 与语言切换 | 🔲 待实现 | Phase 0 已确定三语、机器语言映射、偏好优先级和 fallback；尚未引入 runtime |
| 前端界面文案归拢 | 🟡 已盘点 | 已完成来源域和候选类型盘点，实际页面迁移留在 Phase 1/2 |
| 日期、数字和状态格式化 | 🟡 部分完成 | 页面存在局部格式化逻辑，尚未统一接收 locale |
| API 错误文案 | 🟡 部分完成 | 后端仍有直接返回展示文本的接口；前端不能稳定按错误码翻译 |
| 用户内容与 Agent 内容边界 | ✅ 已确定 | 用户输入、文件名、Markdown、Agent 回复和 IM 正文默认原样展示，不进入界面翻译表 |
| 翻译回归验证 | 🔲 待实现 | Phase 0 已确定验收项，当前仍没有 key 完整性、fallback 或语言切换测试 |

## 1. 背景与目标

当前前端界面文案分散在页面模板、事件处理函数、toast/confirm、路由配置、格式化工具和 Admin 页面中。文字与结构、请求流程和状态判断混在一起，导致同一概念出现多个写法，也无法在不改业务逻辑的情况下增加英文或修正文案。

本方案的目标是：

- 建立唯一的前端文案访问入口，组件不再直接新增面向用户的固定中文字符串。
- 按页面和业务域组织 message key，避免一个巨大的平铺 JSON 和重复翻译。
- 统一语言选择、持久化、机器语言自动适配、fallback 和运行时切换行为。
- 让日期、数字、相对时间、文件大小和状态标签使用 locale-aware formatter。
- 将 API 展示错误逐步改为稳定 `code + params`，由前端按当前语言生成可见文案。
- 保留用户内容、Agent 输出、项目名、文件名、Markdown 和第三方平台正文的原始语言。
- 迁移过程中不改变现有中文用户体验，不引入第二套业务状态或重复请求层。

不在范围内：

- 不翻译数据库中的用户数据、历史聊天、Agent 记忆、文件正文或 Markdown 内容。
- 不在本阶段重写所有后端业务逻辑，也不把渠道平台返回的原文强行转换成前端语言。
- 不把图标、颜色、项目状态值或 CSS token 伪装成文案层问题。
- 不为每个组件建立独立的翻译系统，不允许通过复制整段 locale 文件解决 key 缺失。

## 2. 功能需求

### FR-UI6-001：统一语言运行时

前端提供一个全局 i18n 实例和 `useI18n()` 访问方式，第一版支持 `zh-CN`、`ja-JP` 和 `en-US`。默认跟随用户机器语言；语言优先级为用户显式设置、机器语言、`zh-CN` 默认 fallback。机器语言映射到受支持语言族，例如 `zh-*` 映射为 `zh-CN`、`ja-*` 映射为 `ja-JP`，其他语言默认映射为 `en-US`；无法读取或非法配置时回退到 `zh-CN`。

### FR-UI6-002：统一文案 key 与域归属

导航、认证、项目、文件、日历、思维面板、终端、咕咕聊天、Admin、通知、错误和通用动作分别拥有稳定域前缀。key 表达语义，不复制页面结构；例如使用 `common.actions.save`，而不是 `projects.page.saveButtonText`。

### FR-UI6-003：覆盖模板与运行时文案

静态标题、按钮、占位、空状态、确认框、toast、加载状态、错误提示、路由标题、无障碍 label 和 tooltip 都必须经过 i18n。动态值使用参数插值或 plural 规则，禁止通过字符串拼接制造句子。

### FR-UI6-004：统一格式化

日期、时间、相对时间、数字、百分比、文件大小和数量由共享 formatter 处理，并使用当前 locale、用户时区和产品既有显示精度。组件只传入值和格式选项，不自行复制 `dayjs`、`Intl` 或中文单位拼接逻辑。

### FR-UI6-005：稳定 API 错误边界

新增和迁移的 API 错误使用稳定错误码及结构化参数，例如 `{ code: "PROJECT_NOT_FOUND", params: { id } }`。前端优先按 `code` 查本地文案；未知 code、旧接口纯文本或第三方错误保留经过脱敏的后端 fallback，不把原始异常直接展示给用户。

### FR-UI6-006：用户内容不进入翻译表

项目名、文件名、文件正文、笔记、画布文本、Agent 回复、聊天记录、引用消息和外部渠道正文不得经过 `t()`。只有包裹这些内容的界面标签、操作按钮和状态说明进入 locale。

### FR-UI6-007：语言设置与实时切换

用户可在个人设置中选择语言。选择结果持久化到用户偏好；本地状态更新后，导航、当前页面、弹层和 Admin 页面无需整页刷新即可切换。服务端读取偏好失败不能阻塞页面启动，当前语言状态必须保持可恢复。

## 3. 技术方案

### 3.1 运行时与消息组织

采用 Vue 生态的 i18n runtime，统一封装为项目自己的 `i18n` 模块。业务组件只依赖 `useI18n()` 或共享 `formatters`，不直接读取 locale 文件。locale 消息按业务域拆分，再由注册表合并；同一个 key 在所有受支持语言中必须存在，开发和 CI 阶段发现缺失即失败。

推荐消息结构：

```ts
{
  common: {
    actions: { save: '保存', cancel: '取消' },
    status: { loading: '加载中' }
  },
  navigation: { projects: '项目', calendar: '日历' },
  projects: { empty: '暂无项目' },
  errors: { requestFailed: '请求失败，请稍后重试' }
}
```

消息 key 必须稳定，中文和英文值可独立调整；不能使用可见中文作为 key，也不能把后端返回的中文句子直接当作 key。

### 3.2 文案分类与处理边界

| 来源 | 处理方式 |
|---|---|
| Vue 模板中的标题、按钮、空状态、placeholder | 迁移到对应域 locale |
| `toast`、`confirm`、异常分支中的固定文本 | 迁移到 `common`、`errors` 或业务域 locale |
| `router` 的 `meta.title`、Admin 菜单和权限描述 | 使用 key 或可解析的 message descriptor |
| 日期、数量、文件大小、相对时间 | 迁移到共享 formatter，不在组件中拼接单位 |
| 后端错误 | 新接口使用 `code + params`；旧接口保留兼容映射 |
| 项目名、文件名、笔记、Agent/IM 正文 | 原样展示，不翻译 |
| 第三方平台错误原文 | 经过后端脱敏后作为 fallback，必要时增加错误码映射 |

### 3.3 后端错误迁移

后端不负责把用户界面翻译成某一种语言。后端负责返回稳定错误语义、脱敏信息和必要参数；前端负责根据当前 locale 生成展示文案。错误码必须在 HTTP 状态、日志和用户可见 fallback 之间保持明确边界，不能把异常类名、SQL、凭据或完整第三方响应下发。

### 3.4 目标目录变化

目标目录围绕“runtime、locale、formatter、错误码和测试”拆分，避免翻译文件再次散落到页面目录：

```text
frontend/src/
├── i18n/
│   ├── index.ts                    # 唯一 runtime 入口、语言切换、fallback、注册
│   ├── types.ts                    # message schema 和 key 类型
│   ├── locales/
│   │   ├── zh-CN/
│   │   │   ├── common.ts
│   │   │   ├── navigation.ts
│   │   │   ├── projects.ts
│   │   │   ├── files.ts
│   │   │   ├── calendar.ts
│   │   │   ├── mind.ts
│   │   │   ├── chat.ts
│   │   │   ├── terminals.ts
│   │   │   ├── admin.ts
│   │   │   └── errors.ts
│   │   ├── ja-JP/                  # 与 zh-CN 保持相同 key 集合
│   │   │   └── ...
│   │   └── en-US/                  # 与 zh-CN 保持相同 key 集合
│   │       └── ...
│   └── registry.ts                 # 域消息注册和完整性检查
├── utils/
│   └── formatters.ts               # 日期、数量、文件大小和相对时间
├── services/
│   └── apiError.ts                 # API error code 到 message key 的适配
└── ...

backend/app/core/errors/
├── codes.py                         # 稳定错误码和参数约定
└── responses.py                     # 统一错误响应结构与脱敏边界

frontend/src/**/*.test.ts            # locale、fallback、formatter 和错误码回归
```

当前散落内容的归拢关系：

| 当前来源 | 目标位置 | 处理方式 |
|---|---|---|
| Vue 模板中的固定中文 | `i18n/locales/<locale>/` | 按业务域迁移，模板只保留 `t('...')` |
| 页面脚本中的 toast、confirm、loading 和错误文本 | 对应 locale 域 + `services/apiError.ts` | 保留业务判断，抽出展示文案 |
| `router/*.ts` 的页面标题和 Admin 菜单文本 | `navigation.ts`、`admin.ts` | route meta 改为 message key |
| 各页面日期、数量和单位拼接 | `utils/formatters.ts` | 统一调用 locale-aware formatter |
| 现有共享常量中的用户可见文字 | `common.ts` 或业务域 locale | 仅迁移界面文案，协议值和内部枚举不移动 |
| 后端直接返回的展示错误 | `backend/app/core/errors/` + 前端 `apiError.ts` | 新接口改 code + params，旧接口逐步兼容 |
| 页面内用户内容和 Agent/IM 内容 | 原组件/数据模型 | 明确标注为 content，不进入 i18n |
| 迁移完成后的临时文案映射 | 删除 | 不保留双写 locale、页面 fallback 和重复常量 |

`i18n/locales/` 是翻译数据的唯一事实源；`components/`、`views/`、`router/` 和 `services/` 不新增同义固定文案。目标目录不改变 API service 的业务职责，不把翻译逻辑放进 CSS、store 或 Agent prompt。

### 3.5 语言偏好存储

语言偏好复用现有用户 preferences 能力，字段使用稳定的 `locale` 值，第一版允许 `zh-CN`、`ja-JP` 和 `en-US`。前端启动先读取用户显式选择的值；没有显式选择时读取 `navigator.languages` / `navigator.language` 并初始化 runtime，再异步同步服务端。用户显式选择后必须持久化并覆盖机器语言；服务端保存失败应提示可见错误但不抛弃当前会话语言。迁移期间未设置该字段的用户继续自动适配机器语言。

## 4. 验证与上线

每个迁移批次至少执行：

- `cd frontend && npm run typecheck`
- `cd frontend && npm run test:run`
- `cd frontend && npm run build`
- 扫描新增用户可见固定文字，确认不绕过 i18n 入口。
- 在用户机器语言为中文、日文、其他语言、无法读取语言、显式选择语言和切换语言的场景中，验证导航、弹层、toast、错误、日期、数量和 Admin 页面。
- 验证用户输入、项目名、文件名、Markdown、Agent 回复和 IM 消息仍保持原文。

上线顺序：先接入 runtime 和 `zh-CN` 原文，确保行为不变；再迁移共用文案和高频页面；随后迁移 Admin、错误码和格式化；最后开放三语语言设置和 `ja-JP`、`en-US`。每批迁移可独立回滚，不允许通过删除 `t()` 恢复散落文案。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 漏迁固定文字 | 页面仍混用语言，翻译覆盖不完整 | 静态扫描、key 完整性测试和按路由验收 |
| key 设计重复或过度页面化 | 修改文案需要多处同步，长期继续散落 | 先按语义域设计，通用动作只保留一份 |
| 后端错误仍是纯文本 | 前端无法可靠翻译，错误内容格式不稳定 | 新接口先使用 code + params，旧接口保留映射并登记迁移范围 |
| 翻译误伤用户内容 | 项目名、文件名或 Agent 语义被改变 | 将 content 与 UI message 分开，代码评审禁止对内容调用 `t()` |
| 动态切换导致页面状态重建 | 表单、弹层或正在进行的请求被打断 | locale 只更新消息依赖，不重建业务 store 和路由状态 |
| 多语言文案长度变化 | 按钮、卡片和导航溢出 | 在三种语言下执行桌面/窄屏浏览器验收，复用现有 UI 回归规范 |

待确认事项：

- 第一版固定发布 `zh-CN`、`ja-JP` 和 `en-US`；后续语言只保留 runtime 扩展点，不在本 PRD 内扩展翻译范围。
- 是否使用 `vue-i18n` 作为底层 runtime；若引入，应锁定版本并纳入现有前端依赖许可检查。
- 后端错误码迁移是否先覆盖用户 CRUD 和认证接口，再覆盖 Agent、IM 和流式接口。

## 6. 唯一实施 TODO

### Phase 0：盘点与边界 ✅

- [x] `UI6-001` 建立前端固定文案清单并区分 UI message、用户 content、协议值和第三方原文；验收：候选来源域、类型归属和迁移结论见 [`PRD-UI-6-PHASE0-前端文案盘点.md`](../reports/PRD-UI-6-PHASE0-前端文案盘点.md)。
- [x] `UI6-002` 确定 `zh-CN`、`ja-JP`、`en-US`、机器语言映射、runtime 依赖和用户偏好字段；验收：唯一 key 命名、自动适配优先级、fallback 和 ownership 已在 Phase 0 报告中固定。

### Phase 1：Runtime 与共享文案

- [ ] `UI6-003` 新增 i18n runtime、locale 注册表、类型约束和语言偏好初始化；验收：未选择语言时自动适配机器语言，显式选择可覆盖并持久化，缺失 key 可检测。
- [ ] `UI6-004` 迁移 `common`、`navigation`、认证、布局、通用弹层、toast 和 formatter；验收：高频共享文案不再由组件直接维护，三语测试通过。

### Phase 2：业务页面与 Admin

- [ ] `UI6-005` 按页面域迁移项目、文件、日历、思维面板、终端、咕咕聊天和通知文案；验收：固定 UI 文案均来自 locale，用户内容未被翻译。
- [ ] `UI6-006` 迁移 Admin 路由标题、菜单、表单、权限、日志和错误展示；验收：Admin 页面在三种语言下无明显溢出，权限和业务状态不变。

### Phase 3：API 错误与完整验收

- [ ] `UI6-007` 建立后端稳定错误码及前端映射，优先覆盖认证、项目、文件、文件夹和日历 CRUD；验收：前端按 code + params 展示本地文案，未知错误经过脱敏 fallback。
- [ ] `UI6-008` 完成固定文案静态扫描、locale 完整性测试、formatter 测试和浏览器双语验收；验收：`typecheck`、`test:run`、`build` 和路由冒烟全部通过，并删除临时映射与重复文案。
