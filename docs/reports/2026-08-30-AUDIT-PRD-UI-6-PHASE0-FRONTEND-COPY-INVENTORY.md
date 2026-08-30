# PRD-UI-6 Phase 0：前端文案盘点与边界

> 状态：✅ 已完成
> 日期：2026-08-30
> 关联：`docs/prds/PRD-UI-6-前端国际化与文案归拢方案.md`

## 1. 盘点结论

当前前端尚未接入国际化 runtime。未发现 `vue-i18n`、统一 locale 注册表、语言偏好初始化或错误码到 message key 的适配层；因此本阶段不改动页面行为，也不引入半成品翻译 runtime。

对 `frontend/src/` 中 Vue/TypeScript 源码进行固定中文候选扫描，共得到 **5963 条匹配行**。匹配行包含注释、日志、协议字段说明和用户内容相关代码，不能直接等同于待翻译文案；后续迁移必须按下表边界逐条判定。

| 来源域 | 匹配行 | 归属结论 | Phase 1 迁移责任 |
|---|---:|---|---|
| `views/` | 3616 | 页面 UI 文案与页面内业务/用户内容混合，逐组件区分 | 各页面域 locale；用户内容留在原数据流 |
| `components/` | 1697 | 共享 UI、文件预览、聊天和弹层文案混合 | `common` 或对应业务域 locale |
| `utils/` | 249 | 格式化输出、协议常量和少量 UI 文案混合 | formatter 或业务域 locale；协议值不迁移 |
| `stores/` | 203 | 状态值、请求错误和提示文案混合 | 保留状态判断，提示交给 locale/API error adapter |
| `layouts/` | 93 | 导航、布局操作、全局空状态和错误提示 | `navigation`、`common`、`errors` |
| `services/` | 59 | 请求错误、服务状态和 API 返回字段混合 | 新增 `services/apiError.ts`；协议字段不翻译 |
| `router/` | 46 | route meta 标题与路由控制逻辑混合 | meta 改为稳定 message key |

扫描命令（只读，可用于复核后续新增匹配）：

```sh
rg -n --glob '*.vue' --glob '*.ts' '[一-龥]' \
  frontend/src/views frontend/src/components frontend/src/layouts \
  frontend/src/router frontend/src/services frontend/src/utils frontend/src/stores
```

## 2. 候选文字归属规则

| 候选内容 | 处理结论 | 典型例子 |
|---|---|---|
| 标题、按钮、标签、placeholder、tooltip、无障碍 label | **UI message**，迁移到 locale | “保存”“重试”“暂无项目” |
| toast、confirm、加载状态、空状态、表单校验和可见错误 | **UI message**；参数使用插值 | “确认删除「{name}」？” |
| 日期、时间、相对时间、数量、百分比、文件大小 | **格式化输出**，交给共享 formatter | “3 个文件”“刚刚” |
| 路由 `meta.title`、导航项、Admin 菜单 | **导航 message key** | `navigation.projects` |
| 后端返回的状态值、枚举、字段名、请求参数和协议标识 | **协议值**，不进入翻译表 | `status: 'running'`、API 字段名 |
| 项目名、文件名、笔记、画布文本、Markdown 正文 | **用户 content**，原样展示 | 用户创建的项目名称 |
| Agent 回复、聊天记录、引用消息、QQ/飞书正文 | **外部/Agent content**，原样展示 | 渠道正文与模型输出 |
| 第三方错误原文 | **fallback content**；先脱敏，再由错误适配层承接 | 上游服务返回的可见错误 |
| `console`/诊断日志中的开发说明 | **日志**，不迁移到 UI locale；仍遵守脱敏规则 | 调试信息、内部异常 |
| 注释、PRD、测试描述和设计令牌说明 | **开发文档**，不迁移 | 源码注释、测试断言说明 |

判定原则：只有用户能在界面中看到、且属于产品自身交互的文本才是 UI message。不能因为字符串位于组件或响应对象中就调用 `t()`；尤其禁止翻译用户数据、Agent/IM 正文和协议值。

## 3. 唯一命名与目录决策

### 3.1 支持语言与优先级

- 支持语言固定为 `zh-CN`、`ja-JP`、`en-US`。
- 语言优先级固定为：用户显式偏好 `locale` → `navigator.languages` → `navigator.language` → `zh-CN`。
- `zh-*` 映射 `zh-CN`，`ja-*` 映射 `ja-JP`，其他可读取语言映射 `en-US`；读取失败、空值或非法显式值统一回退 `zh-CN`。
- 用户显式选择后覆盖机器语言；服务端偏好读取失败不阻塞页面启动，也不撤销当前会话语言。
- Phase 1 采用 `vue-i18n` 作为 Vue 生态 runtime，项目封装唯一入口；具体兼容版本在引入时锁定并执行许可检查。本阶段不提前修改依赖。

### 3.2 message key 规则

- key 使用稳定语义，不使用可见中文，不绑定按钮/组件层级。
- 一级域固定为：`common`、`navigation`、`auth`、`projects`、`files`、`calendar`、`mind`、`terminals`、`chat`、`admin`、`notifications`、`errors`。
- 跨页面动作只放一份，例如 `common.actions.save`、`common.actions.cancel`；业务特有表达放业务域。
- 动态值使用参数插值或 plural 规则，禁止在组件中拼接完整句子。
- `zh-CN` 作为迁移基准消息集；`ja-JP`、`en-US` 必须保持相同 key 集合，缺失由检查失败暴露。

### 3.3 目标 ownership

| 责任 | 唯一归属 |
|---|---|
| runtime、语言切换、fallback、注册 | `frontend/src/i18n/` |
| 翻译消息 | `frontend/src/i18n/locales/<locale>/` |
| 日期、数量、文件大小、相对时间 | `frontend/src/utils/formatters.ts` |
| API 错误码到 message key 的适配 | `frontend/src/services/apiError.ts` |
| 页面业务判断、请求和状态 | 原页面/ composable / service，不能承载翻译表 |
| 用户偏好持久化 | 复用现有 preferences 能力，字段名固定为 `locale` |
| 后端错误语义 | 后端稳定 `code + params`；后端不选择展示语言 |

## 4. 已识别的迁移批次

1. **共享基础批次**：`layouts/`、`router/`、认证页、通用弹层、toast 和基础 formatter。
2. **用户工作台批次**：项目、文件、日历、思维、终端、技能、定时任务和通知。
3. **交互内容批次**：咕咕聊天、引用、附件、IM 渠道包装文案；正文保持原文。
4. **Admin 批次**：Admin 导航、配置、用量、感知、日志、权限和运维页面。
5. **错误与验收批次**：API error adapter、静态扫描、key 完整性、formatter 和浏览器双语回归。

每个批次都必须先完成“UI message / content / 协议值 / fallback / 日志”的逐条归属，再迁移代码；不得用页面级 fallback 或复制整份 locale 文件掩盖缺失 key。

## 5. Phase 0 验收

- [x] 已确认当前不存在统一 i18n runtime、locale 注册表和语言偏好字段实现。
- [x] 已完成 `frontend/src/` 固定中文候选的来源域盘点，并为候选类型给出迁移或排除结论。
- [x] 已确定三种语言、机器语言映射、显式偏好优先级和 fallback 规则。
- [x] 已确定 key 命名、locale 目录、formatter、API error adapter 与各模块的 ownership。
- [x] 已明确用户内容、Agent/IM 正文、协议值、第三方原文和日志不进入翻译表。

下一阶段从 `common`、`navigation`、认证和 runtime 骨架开始；本报告不代表已经完成任何页面翻译。
