# PRD-MERMAID-1：统一 Mermaid 图表体验与跨端 PNG 输出

> 状态：🔲 待评估
> 创建：2026-10-12
> 最近更新：2026-10-12
> 所属层：前端内容展示、Agent 输出、IM Gateway
> 关联模块：`frontend/src/components/common/content/MarkdownView.vue`、`frontend/src/components/common/viewers/TextViewer.vue`、`frontend/src/components/common/gugu-chat/markdown.ts`、`frontend/src/utils/markdown.ts`、`frontend/src/utils/mermaidTheme.ts`、`frontend/src/utils/mermaidInteraction.ts`、`backend/agent/prompts/persona.md`、`backend/agent/im/loop.py`、`backend/agent/im/replies.py`、`backend/agent/gateway/qq.py`、`backend/agent/gateway/feishu.py`、`backend/agent/gateway/telegram.py`、`backend/agent/gateway/wechat.py`
> 关联文档：[[PRD-UI-4-统一弹层与模态交互架构]]、[[PRD-UI-6-前端国际化与文案归拢方案]]、[[PRD-IM-12-QQ消息格式兼容策略]]、[[PRD-IM-13-QQ私聊流式回复]]、[[PRD-IM-14-飞书工具调用摘要卡片]]

---

## 1. 背景与目标

### 1.1 背景

Gugu 已依赖 Mermaid npm 包在浏览器中渲染 Markdown 图表。通用 Markdown 展示和文件 Markdown 预览都能识别 Mermaid 代码块，并将其渲染成 SVG；当前图表区域已有缩放、拖动等交互。

目前 Mermaid 能力分散在多个组件中：`MarkdownView.vue` 与 `TextViewer.vue` 各自处理代码块识别、主题配置、SVG 渲染和交互生命周期；GuguChat 使用独立的 `marked` 高亮渲染器，现将代码块统一按普通代码处理。现有图表没有独立的大图预览入口，也没有一致的 PNG 导出能力。IM 出站已有 QQ、飞书、Telegram、微信的图片/文件 Gateway，但模型回复中的 Mermaid 尚未转换为可发送的图片。

用户希望 GuguChat 与文件中的 Mermaid 图可独立放大预览并下载；IM 中也能直接看到兼容性好的图像。跨端的用户可见导出和 IM 图片统一采用 PNG，不发送 `.mmd` 文件。讨论架构、模块关系、调用链、数据流、状态流或部署拓扑时，咕咕应在确实有助于理解的情况下优先用 Mermaid 表达。

### 1.2 目标

- 建立单一 Mermaid 前端渲染与呈现模块，复用图表识别、安全处理、主题配置、交互及导出行为，消除聊天与文件预览中的重复实现。
- GuguChat 和文件 Markdown 预览均能正确呈现 Mermaid，提供独立的大图预览弹层和 PNG 下载。
- IM 完整回复中的 Mermaid 图能够转换为 PNG，并作为平台原生图片消息发送；不要求 QQ、飞书、Telegram 或微信解析 Mermaid 源码。
- 通过系统提示词引导咕咕在适合的架构类回答中优先输出 Mermaid，同时避免简单问题强制配图。
- 渲染失败、平台发送失败或能力不可用时，不影响普通文本回复、Agent Run 完成和现有 IM 媒体发送。
- 所有导出/发送图像使用 PNG；首期不提供 JPG 和 `.mmd` 文件下载。

### 1.3 非目标

- 不开发通用绘图编辑器、Mermaid 在线编辑器或可视化拖拽建图功能。
- 不改变 Mermaid 语法本身，不承诺支持 Mermaid 上游的全部实验特性；支持范围以项目锁定版本和安全配置为准。
- 不把 Mermaid 图转换成文件库中的长期用户文件；只有显式发送时才产生短生命周期的发送载荷。
- 不改造所有模型输出风格，不要求每个架构问题、普通问答或闲聊都包含图表。
- 不在 IM 客户端实现自定义弹层、画布交互或图内编辑；放大由平台原生图片查看器完成。
- 不添加数据库表、用户配置开关或常驻独立渲染服务，除非 Phase 0 验证证明现有部署运行时无法满足服务端渲染，并经方案复审。
- 不发送 `.mmd` 附件，不把 SVG 作为跨平台发送格式。

## 2. 现状分析

### 2.1 当前实现

| 区域 | 当前代码 | 已有能力 | 缺口 |
|---|---|---|---|
| 通用 Markdown | `frontend/src/utils/markdown.ts`、`frontend/src/components/common/content/MarkdownView.vue` | 识别 `mermaid` fenced block；动态加载 `mermaid`；strict 安全级别、关闭 HTML labels；SVG 经消毒后显示；主题切换时重绘；已有缩放/拖动交互 | 没有独立大图预览和 PNG 下载；渲染/交互逻辑仍在展示组件内 |
| 文件 Markdown | `frontend/src/components/common/viewers/TextViewer.vue` | 独立识别 Mermaid；使用相同 Mermaid 依赖、主题颜色与 SVG 消毒策略；已有缩放/拖动 | 再次实现渲染、主题观察、交互清理和错误处理；没有大图预览和 PNG 下载 |
| GuguChat | `frontend/src/components/common/gugu-chat/markdown.ts` 及聊天 Markdown 展示链路 | 独立 `marked` renderer、代码高亮、复制按钮和聊天安全消毒 | 自定义 `renderer.code` 将 Mermaid 按普通代码块高亮，未接入通用 Mermaid 源码占位/渲染路径 |
| Mermaid 主题与交互 | `frontend/src/utils/mermaidTheme.ts`、`frontend/src/utils/mermaidInteraction.ts` | 主题颜色派生；缩放、平移、双击复位等交互 | 没有统一导出画布、下载状态、弹层呈现和完整 i18n 控件契约 |
| IM 出站 | `backend/agent/im/replies.py` 与四个平台 Gateway | 已有统一附件分发及图片识别/发送能力；平台可用发送接口接收图片字节 | Agent 回复中的 Mermaid 代码没有提取、PNG 渲染、图片消息发送和顺序控制 |
| 提示词 | `backend/agent/context/session_system.py` 从 `backend/agent/prompts/persona.md` 等文件组装稳定提示词 | 系统提示词会统一注入 Web 与 IM 对话 | 尚无针对架构类回答按需使用 Mermaid 的输出引导 |

### 2.2 问题

1. Mermaid 渲染状态和生命周期重复，两个前端渲染入口容易发生主题、安全和交互行为漂移。
2. GuguChat 使用自定义代码块渲染器，与 `MarkdownView` 的 Mermaid 源码占位协议没有接通，无法保证聊天中的 Mermaid 图被当作图表呈现。
3. 在窄聊天气泡或文件预览区域中，缩放控件无法替代独立的大图浏览器；用户需要在图表本体上操作，体验不清楚。
4. 用户无法将渲染结果方便地下载；IM 用户只能收到文本形式的 Mermaid 代码或不可读的普通代码块。
5. 仅在前端增加渲染无法覆盖 IM：IM 消息从后端 Gateway 发出，需要独立的服务端 PNG 输出路径。
6. 默认输出意愿没有被明确表达，咕咕可能给架构解释但漏掉直观的组件/数据流图，也可能在不适合时过度画图。

## 3. 用户与使用场景

### 3.1 用户场景

- 用户在 GuguChat 收到系统结构、模块关系或数据流说明，直接看到可缩放 Mermaid 图，并能打开大图弹层或下载 PNG。
- 用户在文件库预览包含 Mermaid fenced block 的 Markdown 文档，获得与 GuguChat 相同的图表操作和 PNG 导出体验。
- 用户在 QQ、飞书、Telegram 或微信提出架构问题，咕咕回复文字并发送 PNG 图；用户用平台原生图片查看器查看和放大。
- Mermaid 语法错误或渲染环境不可用时，用户仍能收到正常回答和可理解的失败提示，不会让整轮对话失败。

### 3.2 核心原则

- **一个图表契约，多种呈现适配器**：网页可交互 SVG 与独立弹层，IM 使用静态 PNG；输入语法、主题基线、错误语义和导出规则保持一致。
- **PNG 是用户可下载/跨平台发送的统一图像格式**：不以 `.mmd` 或 SVG 作为下载/IM 附件；JPG 不作为首期格式。
- **提示词是引导，不是强制模板**：只有能明显降低理解成本时才要求架构图。
- **渲染失败与对话成功解耦**：不能因图表无效、超限或平台媒体发送失败而丢弃文字回答。
- **安全默认**：禁止 Mermaid 内嵌 HTML；生成 SVG 和 PNG 均不得加载外部资源或执行不可信内容。

## 4. 功能需求

### FR-MERMAID-1：统一识别和渲染

1. GuguChat、通用 Markdown 和文件 Markdown 预览都必须识别语言标签大小写不敏感的完整 `mermaid` fenced block。
2. 前端抽取 Mermaid 源码并交给统一渲染组件/模块；其他代码块继续沿用各自的 Markdown 和代码高亮行为。
3. 对流式内容，仅在 Mermaid fence 已闭合时显示图表；未闭合时保留安全、稳定的加载/代码态，不因每个 token 重绘完整图表。
4. 更新正文、切换主题、切换文件或卸载预览时，不得把旧异步渲染结果写回新内容，也不得遗留事件监听器、弹层或 Blob URL。
5. 现有严格 Mermaid 安全配置和 HTML 消毒要求必须保留或加强；生成 HTML 仍经可信净化流程后方可进入 DOM。
6. Mermaid 懒加载应继续按需触发，不得因为普通页面启动而把 Mermaid 大包静态放入主入口初始下载。

### FR-MERMAID-2：统一图表组件与主题

1. 建立共享 Mermaid 呈现组件及必要的纯逻辑模块，负责状态、生成 SVG、渲染错误、交互初始化/清理和导出入口。
2. GuguChat 的内联预览和文件 Markdown 预览复用共享组件/协议；页面容器只提供布局上下文与图表源，不再各自复制 Mermaid 初始化和交互生命周期。
3. 内联图保持现有缩放、拖动、复位能力；图表工具栏提供明确的“放大预览”和“下载 PNG”操作。
4. Mermaid 颜色继续从现有应用主题 token 派生；前景、线条、文字和背景必须有足够对比度，不能在组件中硬编码只适用于单一主题的配色。
5. 所有新增可见文案、按钮名称、无障碍标签、加载和失败状态进入现有 i18n；不得只实现默认语言。
6. 使用统一弹层契约（`BaseModal` 或 UI-4 认可的公共弹层入口），支持关闭按钮、Esc、焦点管理和移动端尺寸；弹层图表可独立缩放/平移，关闭后恢复页面焦点。

### FR-MERMAID-3：PNG 导出

1. GuguChat 和文件预览器均提供“下载 PNG”，生成 `.png` 文件；首期不提供 JPG、SVG 或 `.mmd` 下载。
2. PNG 由当前渲染出的 Mermaid SVG 转换生成，保持图表标签、连线和主题颜色；不重新解析出另一套不同的图表布局。
3. 导出图片使用不透明、对比度足够的背景，避免透明图在深色查看器或 IM 客户端上不可读。浏览器导出应匹配当前图表主题；服务端 IM 导出使用固定、可读的中性主题背景。
4. 导出尺寸按 SVG 的固有比例计算，保证文本清楚；输出宽/高和字节数均有上限。超限时不得无限分配 Canvas 内存，应返回可理解的失败反馈。
5. 文件名使用安全、可读且跨系统兼容的名称（如 `mermaid-diagram-日期时间.png`）；不得把用户输入直接拼成未经清理的路径。
6. 下载过程处理浏览器不支持 Canvas、SVG 转换失败、Blob 创建失败等错误；错误仅影响本次下载，不破坏图表预览。

### FR-MERMAID-4：GuguChat 与文件预览行为

1. GuguChat 的自定义 Markdown code renderer 必须将 Mermaid block 接入共享图表契约，普通 fenced code 仍有原有语法高亮和复制操作。
2. 聊天流式期间不重复下载/渲染不完整图表；完整 fence 到达后显示图表。正文更新后必须避免重复绑定控制器或累积 SVG 节点。
3. 文件 Markdown 预览复用共享组件，保留现有文件编辑、任务清单、相对链接、frontmatter 和滚动位置行为。
4. 在狭窄聊天气泡及文件预览器有限区域中，内联图不得撑破布局；大图操作不再要求用户在内联区域反复缩放才能阅读。
5. 无 Mermaid block 的消息/文件不加载 Mermaid runtime，也不显示空工具栏或占位空白。

### FR-MERMAID-5：IM Mermaid PNG 消息

1. 支持现有 IM 平台 QQ、飞书、Telegram 和微信的 Mermaid 图像输出；输出格式统一为 PNG 图片消息，不发送 SVG/JPG/`.mmd` 附件。
2. 在 Agent 最终回复完成后识别完整 Mermaid fenced block，并由受限的服务端渲染路径生成 PNG。服务端应复用与前端相同的 Mermaid 版本和主题变量基线，避免安装两套独立版本造成语法漂移。
3. 发送 PNG 应复用现有平台 Gateway 媒体能力和校验，不创建永久文件库记录、不增加数据库迁移。若公共出口目前只能基于存储键发送，应采用有 TTL 的临时载荷或增加接收字节/MIME 的统一内部出口；不可把临时图片永久存入用户文件列表。
4. 同一回复中的普通文本与图像按原回复顺序发送；移除待渲染的 Mermaid 源码 fence，避免在 IM 里重复输出大段不可执行代码。平台 API 无法逐段交错时，应采用稳定的“文本说明 + PNG 图片”顺序并加简短上下文。
5. 流式平台在 Mermaid fence 未闭合时不得把部分源码作为最终普通代码消息提前发送；图表渲染/发送应挂接到现有最终回复收尾，不能重复执行 Agent Run 或重复发送普通文本。
6. 单轮图表数量、单图源码长度、渲染耗时、像素尺寸、图片字节数均有上限。超限图表不触发无限重试或进程级资源耗尽。
7. 单图渲染失败时，普通文字仍送达；IM 给出简短说明并提供可读的文本/代码回退（不得创建 `.mmd` 附件）。单张图片发送失败不得吞掉同轮其他正常文本或其余可发送图片。
8. 所有平台分别遵守现有图片上传上限、速率限制、被动回复窗口和群/私聊路由规则；不得以 Mermaid 支持为由绕过平台发送策略。

### FR-MERMAID-6：服务端渲染运行时约束

1. Phase 0 必须验证项目所有受支持的部署形态（集成镜像与非集成部署）能否使用同一锁定的 Mermaid 版本生成 PNG。前端浏览器组件不得直接作为后端渲染实现。
2. 首选复用仓库已有 Node/TypeScript 运行时，通过按需、受限的 worker/subprocess 调用；worker 不监听公网端口，不创建新常驻服务，不访问网络。
3. 若现有运行时无法安全支持渲染，必须先在 PRD 复审中比较依赖体积、启动开销、CPU/内存上限和所有部署模式的交付方式，再决定是否引入 Headless Chromium 或新的服务依赖；未经复审不得把渲染器静默塞进后端主进程。
4. 渲染请求必须设置墙钟超时、输入大小限制、输出像素/字节上限和并发上限；超时必须终止当前渲染任务，不能留下后台子进程。
5. 渲染容器/worker 禁止网络访问，禁用外部字体/图片/URL 加载；临时目录和临时文件应在成功、失败、取消后清理。
6. 服务端不得把 Mermaid 正文、用户对话、图像字节或凭据写入普通日志；诊断仅记录渲染状态、字节数、耗时和脱敏错误类型。

### FR-MERMAID-7：提示词引导

1. 在稳定系统提示词中加入有条件的可视化建议：讨论软件架构、系统组成、模块关系、调用链、数据流、状态流或部署拓扑时，若图示能降低理解成本，优先用 Mermaid 说明，并用简短文字解释关键边界。
2. 明确不强制简单问题、单一事实、纯文本改写或用户明确要求不画图的回复使用 Mermaid。
3. 要求输出合法、可直接渲染的 Mermaid fenced block；优先选择结构最贴合内容的图类型，控制节点和连线数量，避免一图塞入过多实现细节。
4. 提示词不得声称图已经生成/发送成功；是否完成渲染和发送由产品链路决定。
5. 同一提示词行为对 Web 与 IM 生效；IM 图片失败不应引导模型反复重写/重试整轮对话。

### FR-MERMAID-8：失败隔离与可观测性

1. Mermaid 解析、SVG 净化、PNG 转换、IM 图片上传分别有明确失败状态；任一阶段失败只降级相应图表，不让 Agent Run 因呈现失败变成模型错误。
2. Web 中渲染失败保留原始 Mermaid 内容或可读错误信息，不能静默吞图；IM 采用简短错误说明和有界文本回退。
3. 日志不含原始 Mermaid 源、消息正文、文件名或生成图片；可记录平台、图数量、source/output 字节数、耗时、结果类别和脱敏错误类型。
4. 同一消息重放、流式更新或 Gateway 重试不得造成重复 PNG 消息；发送幂等策略沿用现有消息/回复生命周期，不新增跨运行持久化状态。

## 5. 技术方案

### 5.1 前端结构

- 新增共享 Mermaid 渲染/呈现组件，建议职责包含源码输入、懒加载 Mermaid、配置主题、SVG 净化、加载/错误态、图表交互、展开弹层和 PNG 导出。
- `MarkdownView.vue` 和 `TextViewer.vue` 提供 Mermaid 源码占位节点并复用同一组件，不再各自保留 Mermaid 初始化、主题观察和交互销毁实现。
- GuguChat 的 `marked` renderer 为 Mermaid 代码块生成共享可识别的占位结构；代码高亮、复制按钮仍用于非 Mermaid fenced block。
- 如 `v-html` 无法直接挂载 Vue 子组件，使用受控占位 DOM + 生命周期协调器或抽取统一 composable；不得未经净化拼接 HTML，也不得在组件里复制另一套渲染器。
- PNG 下载从共享渲染结果转换而来。SVG 和 PNG 不依赖外部 URL、外部 CSS 或跨域资源。

### 5.2 IM 结构

```text
Agent 最终回复
    └─ Mermaid 回复解析器：识别并替换完整 Mermaid fences
         ├─ 普通文本片段 → 现有 IM 文本/流式出口
         └─ Mermaid 源码 → 受限 PNG renderer → PNG bytes
                                   └─ 统一媒体出口 → QQ / 飞书 / Telegram / 微信 Gateway
```

- 回复解析器只处理最终可发送文本，不修改 Agent 生成历史或用户可见的 Web 正文。
- 服务端 renderer 与前端共用锁定的 Mermaid 依赖版本及图表主题契约；若运行时评估不通过，先阻塞 IM 子功能并复审架构，不用图片截图服务或临时公网服务兜底。
- 统一媒体出口接收 PNG bytes、MIME 和安全文件名，按 `platform` 分发到现有 Gateway。若为兼容既有存储键接口而暂存，必须使用有期限的临时存储并可在发送后清理。
- 普通文本与图片顺序以原始回复为准。已有流式平台需提供“暂存 Mermaid fence、只发送已确认普通文本、最终将图片插入相邻回复”的适配，不得把源码先发出再重复替换。

### 5.3 Mermaid 输出规范

- 用户可见图像：PNG。
- Web 预览：消毒后的 SVG，允许内联缩放/平移和独立弹层。
- Web 下载：PNG，按图表比例导出，背景不透明、文字清楚。
- IM 消息：PNG，采用中性、高对比度的固定背景，平台以原生图片消息展示。
- 首期不提供 JPG、SVG 下载或 `.mmd` 文件附件。
- 渲染依赖版本由 lockfile 固定；升级 Mermaid 版本需要通过渲染样例验证语法、主题和导出兼容性。

## 6. 影响范围

### 6.1 预期文件

```text
frontend/
├── src/components/common/content/              【新增】共享 Mermaid 呈现组件/弹层（命名由实现复用现有目录约定）
├── src/components/common/content/MarkdownView.vue 【修改】使用共享 Mermaid 呈现能力
├── src/components/common/viewers/TextViewer.vue  【修改】移除重复 Mermaid 渲染流程，复用共享组件
├── src/components/common/gugu-chat/markdown.ts   【修改】识别 Mermaid fenced block 并交接共享渲染入口
├── src/utils/mermaidTheme.ts                     【修改】在不重复主题逻辑前提下支持统一渲染契约
├── src/utils/mermaidInteraction.ts               【修改】保留/抽取交互绑定与清理，增加弹层所需能力
├── src/i18n/locales/{zh-CN,en-US,ja-JP}.ts        【修改】图表操作、错误与无障碍文案
└── tests/                                         【新增/修改】渲染、弹层、下载、i18n 与安全行为测试

backend/
├── agent/prompts/persona.md                       【修改】按需优先使用 Mermaid 的行为提示
├── agent/im/loop.py                               【修改】把图表解析/渲染接入最终 IM 回复，不重复消费 Run
├── agent/im/replies.py                            【修改】提供图片字节/临时载荷的统一内部出站入口
├── agent/im/mermaid.py                            【新增】有界回复解析、渲染协调与错误隔离
├── agent/gateway/{qq,feishu,telegram,wechat}.py   【必要时修改】复用现有图片消息接口和平台约束
├── ts/ 或部署配置                                 【按 Phase 0 决策】提供同版本、有界、无网络的服务端渲染 runtime
└── tests/                                         【新增/修改】parser、资源边界、媒体路由和失败隔离行为测试
```

实际实施时以复用现有模块为先；不得为了匹配此文件清单机械拆文件。若 Phase 0 发现需要新增长期服务、持久化模型或改动部署基线，先更新本 PRD 的技术方案和风险表。

### 6.2 数据与兼容性

- 不新增数据库字段、Alembic migration、用户偏好或 API schema。
- 不改变模型请求协议、对话历史格式、历史消息存储和现有文件库内容。
- 普通代码块、用户提供的 Mermaid fenced block、现有 Markdown 编辑/保存、Chat 引用链接、平台文本回复均保持兼容。
- Mermaid PNG 不作为永久文件库项目；默认只下载到用户本地或直接发往当前 IM 会话。
- 新增系统提示词通过既有每轮提示词读取机制生效，不要求用户迁移数据或重启数据库。

## 7. 实施计划

### Phase 0：实现路径与资源边界验证

- 时间：实施前技术验证。
- 范围：检查集成镜像和非集成部署的 Node/浏览器运行时；非集成部署以 devserver 的独立前后端服务为准，不以 Compose 作为前提。用锁定 Mermaid 版本生成静态 PNG；确认 worker/subprocess 可设定超时、并发、像素与字节上限，并能禁止网络访问。
- 交付物：短验证记录，给出依赖体积、启动耗时、内存/CPU上限、部署可用性及是否需改部署文件，见 [`docs/devlog/2026-10-13-PRD-MERMAID-1-Phase0运行时验证.md`](../devlog/2026-10-13-PRD-MERMAID-1-Phase0运行时验证.md)。
- 验收：两种受支持部署都能执行或明确指出阻塞项；不新增常驻服务。若不满足则停止 IM renderer 实施并复审本 PRD。

#### Phase 0 验证结论（2026-10-13）

- devserver 的前后端为独立部署，后端及相关 worker/gateway 由 systemd 管理；不是 Compose 部署。集成镜像内置 Node，无需新增常驻服务或部署文件。
- 两端 Node 运行时版本不同（宿主 Node 22、集成镜像 Node 20），但 Mermaid 11.17.2 在两端均能生成 PNG。服务端应复用前端锁定版本，不依赖浏览器或 Headless Chromium。
- 临时依赖探针总量约 197 MiB；含 Mermaid、DOM 实现与 Resvg，不含浏览器。`isomorphic-mermaid` 虽可运行，但声明 Node >=22，不作为 Node 20 集成镜像的运行时依赖；Phase 3 使用项目自有的最小 Node 启动层，并在锁文件中统一 Mermaid 版本。
- 默认容器 bridge 网络下，seccomp 拒绝渲染子进程的网络系统调用（返回 `EPERM`），渲染仍成功。宿主与集成镜像均验证了超时后子进程终止。探针使用 1 CPU、512 MiB 内存上限；代表性 flow/sequence/class 三图批次约 1.5 秒，峰值 RSS 约 162 MiB。
- 并发、像素和 PNG 字节限制属于 Phase 3 worker 必须落实的硬边界：并发 semaphore、渲染前尺寸/像素上限、编码后字节上限；本阶段验证其可在短生命周期 worker 中实施，不代表产品限制已经落地。
- 结论：采用后端短生命周期 Node 子进程生成 PNG，Python 调用方负责超时、并发和进程回收，Node 侧负责 Mermaid→SVG→PNG、尺寸与字节校验；用 seccomp 禁止网络。Phase 3 实现前锁定依赖和资源预算，不引入 Chromium 或新常驻服务。

### Phase 1：共享前端渲染与图表交互

- 时间：Phase 0 通过后。
- 范围：抽取共享 Mermaid 呈现能力；接通通用 Markdown、GuguChat 和文件 Markdown；统一主题、安全与生命周期；增加独立放大弹层和 PNG 下载。
- 交付物：GuguChat、文件预览一致的图表、弹层、PNG 下载和多语言文案。
- 验收：四类页面/内容均渲染同一 Mermaid 样例；普通代码渲染不回归；图表开关不改变；主题切换和卸载不残留旧图或监听器；PNG 能在常见图片查看器打开。

### Phase 2：架构回答提示词

- 时间：Phase 1 前端契约确认后，可与 Phase 1 并行。
- 范围：更新 `backend/agent/prompts/persona.md` 的架构类可视化建议，限制使用条件和图表复杂度。
- 交付物：适用于 Web 和 IM 的统一行为提示。
- 验收：架构/数据流请求倾向输出可渲染 Mermaid；简单事实、闲聊和用户明确拒绝图表时不强制输出；通过少量代表性行为场景复核，不编写锁定精确措辞的脆弱提示词测试。

### Phase 3：IM PNG 渲染与平台发送

- 时间：Phase 0 与 Phase 1 完成后。
- 范围：最终回复解析、服务端 PNG 生成、有界临时载荷、文本/图片顺序发送、四平台适配和失败隔离。
- 交付物：QQ、飞书、Telegram、微信的 PNG 图表回复。
- 验收：每个平台收到可打开的 PNG 图片消息；普通文本顺序正确；不发送 Mermaid 源码附件；错误图表和图片发送失败不影响正常文本和 Run 成功收尾。

### Phase 4：整体回归与发布准备

- 时间：全部功能完成后。
- 范围：执行分层自动化验证、浏览器检查、各 IM 测试账号验证和部署体积/资源复核；整理用户可见变更说明。
- 交付物：验收记录、剩余风险和回滚说明。
- 验收：第 9 节的 P0/P1 用例全部通过；服务端 renderer 的资源限制与日志脱敏通过；没有引入数据库迁移或用户配置迁移。

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 服务端 Mermaid 渲染依赖 Headless Chromium 或额外运行时 | 镜像体积、冷启动、内存或部署形态复杂度上升 | Phase 0 先测现有运行时；优先短生命周期 worker；必须新增重型依赖时先复审镜像和资源成本，不静默增加常驻服务。 |
| Mermaid 源码可触发高 CPU/内存消耗 | 单个图表影响 Worker 或 IM 回复 | 源长度、并发、超时、输出像素及字节硬限制；超时终止进程；渲染器无网络权限。 |
| SVG 到 PNG 转换在不同浏览器/后端主题不一致 | 下载或 IM 图片颜色/布局偏差 | 锁定 Mermaid 版本和 themeVariables；使用规范渲染样例验证浅/深主题、长标签和宽图。 |
| 聊天流式 renderer 在 fence 闭合前发出源码 | 用户同时看到源码和图片、顺序错乱 | 流式适配器缓存未闭合 Mermaid block，最终阶段只发送图片和普通文本；用交错 token 行为测试覆盖。 |
| 任一 IM 平台图片上限或格式行为不同 | 图片失败、重复发文或被作为文件下载 | 统一使用 PNG MIME 与正确扩展名；沿用平台 Gateway 限制；小图超限时安全失败并保留文本。 |
| 提示词导致不必要的图表增多 | 回答冗长、渲染和消息负担上升 | 明确条件性触发；简单问答不强制图表；以代表性场景复核图表适用性。 |
| 前端弹层与已有 Markdown DOM 清理耦合 | 关闭弹层后事件/DOM 残留 | 共享组件持有明确生命周期；复用 BaseModal/公共弹层；覆盖主题切换、正文替换和卸载场景。 |

## 9. 验收与测试

### 9.1 前端行为验收

1. GuguChat 中有效 Mermaid block 渲染为图，普通 fenced code 保留原高亮和复制按钮。
2. Markdown 文件中的多个图表均可单独展开、缩放、关闭和下载；编辑/保存内容后新图正确重绘。
3. 弹层在桌面和窄屏可用，键盘 Esc 可关闭，关闭后焦点回到触发按钮；图表长宽比和布局稳定。
4. 浅色/深色主题切换后文字与连线保持可读；PNG 背景不透明，下载图像与预览一致且可在通用图片查看器打开。
5. 无效 Mermaid、超长源码、下载失败或快速切换消息时，页面不崩溃、不留下旧图/监听器/Blob URL，其他正文仍可读。
6. 普通 Markdown、代码块、Frontmatter、相对链接、任务清单和文件编辑能力回归通过。

### 9.2 IM 行为验收

1. QQ、飞书、Telegram、微信的代表性私聊均能收到 PNG 图片消息，文件类型为 PNG，客户端可直接预览/缩放。
2. 群聊遵循各平台当前允许的媒体发送能力和群策略；没有权限或平台拒绝图片时保留正常文本回复。
3. 一段文字前后各有图表时，消息顺序可辨认；多个 Mermaid block 不会互相覆盖，也不产生重复图。
4. 无 Mermaid 回复保持现有消息数量、文本和流式行为；Mermaid 解析/渲染/发送失败不导致重新调用模型或重复发送全文。
5. 超时、并发达到上限、图片过大、平台超限、Gateway 暂时失败均有界结束，普通回复完整送达。
6. 日志和诊断不包含 Mermaid 源码、用户消息正文、文件名或图片内容。

### 9.3 自动化验证原则

- 前端用组件/集成行为测试覆盖 Mermaid 识别、渲染状态、弹层开关、导出结果类型与错误清理；少量浏览器 E2E 覆盖真实 Canvas PNG 导出和移动端弹层。
- 后端覆盖完整/不完整 fence 解析、文本/图像顺序、有界渲染超时、字节级媒体路由、失败隔离与日志安全。
- 不用源码字符串匹配测试提示词内容。提示词只增加少量架构类、简单问答和明确不画图的代表性评估场景。
- 平台 Gateway 使用 mock/契约测试覆盖格式与分发；人工 IM 验收只覆盖 API/mock 难以验证的客户端预览和实际消息顺序。
- 测试数量以可观察行为为准，不重复为每个 Mermaid 语法样例建立低信号用例。

## 10. 成功指标

| 指标 | 当前值 | 目标值 |
|---|---|---|
| GuguChat Mermaid 展示 | 自定义代码渲染链路未接共享 Mermaid 图表呈现 | 有效 Mermaid block 在 GuguChat 正确显示率 100%；普通代码块行为无回归 |
| 文件 Markdown Mermaid 体验 | 有内联 SVG 和缩放/拖动，无独立放大和 PNG 下载 | 所有有效图表可独立预览并下载 PNG |
| GuguChat Mermaid 下载 | 无统一下载 | 下载文件 MIME 为 `image/png`，常见图片查看器可打开 |
| IM Mermaid 输出 | 无自动 Mermaid 转 PNG 链路 | 四个平台按能力发送 PNG；失败不阻断文本回复 |
| 渲染资源边界 | 无服务端渲染路径 | 输入、并发、耗时、像素和输出字节限制全部生效；超限任务在规定超时内终止 |
| 架构答复可视化 | 无明确提示词规则 | 代表性架构问题在适合时生成有效 Mermaid；不适合场景不被强制画图 |

## 11. 回滚与兼容

- 前端可将 Mermaid 图表回退为原有代码块显示；不影响 Markdown 文件原文或聊天历史。
- IM renderer 可按功能入口关闭；回复回退为普通文本路径，不改变 Gateway 现有图片发送能力。
- 提示词可单独回滚；不需要用户数据迁移。
- 若服务端渲染运行时升级导致资源或部署问题，可停用 IM 图表输出，保留 Web 端 Mermaid 功能。
- 本需求不增加永久用户数据，因此回滚不需要数据清理或反向 migration。

## 12. 实施 TODO

### Phase 0：运行时验证

- [x] `MERMAID-001` 核验集成镜像和非集成部署中可供后端使用的 Node/浏览器运行时；测量代表性图的渲染成功率、耗时、内存、依赖体积及超时终止行为。验收：得出明确的无新服务实现方案；若需要新常驻服务/重型浏览器依赖，先复审 PRD。

### Phase 1：共享前端呈现

- [ ] `MERMAID-002` 新增共享 Mermaid 呈现组件/逻辑，收敛 `MarkdownView.vue` 与 `TextViewer.vue` 的重复渲染和交互生命周期。验收：主题、安全、生命周期与错误处理只有一套行为契约。
- [ ] `MERMAID-003` 接通 GuguChat 自定义代码块 renderer 的 Mermaid 分支。验收：有效图表渲染，普通代码高亮/复制行为保持。
- [ ] `MERMAID-004` 增加独立放大弹层和多语言操作文案。验收：弹层键盘/焦点/窄屏行为符合 UI-4 和设计约定。
- [ ] `MERMAID-005` 增加浏览器 PNG 导出。验收：GuguChat 与文件 Markdown 均下载有效、不透明、比例正确的 PNG；超限和转换错误可恢复。

### Phase 2：提示词

- [ ] `MERMAID-006` 更新稳定提示词中的条件性 Mermaid 建议。验收：架构图适用性满足第 4.7 节；不新增脆弱的精确文案断言。

### Phase 3：IM PNG 输出

- [ ] `MERMAID-007` 新增 IM 最终回复 Mermaid 提取和服务端 PNG 渲染协调。验收：只消费完整 fence；有输入、并发、超时、像素和输出字节限制；失败与 Run 状态隔离。
- [ ] `MERMAID-008` 将 PNG bytes 接入统一媒体出站并完成四平台适配。验收：消息顺序正确、只发 PNG、没有永久文件记录、发送失败不吞普通文本。
- [ ] `MERMAID-009` 补齐安全、平台、回归测试和人工验收记录。验收：第 9 节全部通过；日志脱敏、渲染隔离和回滚路径复审完成。

### Phase 4：总体复查

- [ ] `MERMAID-010` 对照本 PRD 复查全部需求、TODO、测试和部署影响。验收：无未实现的 P0/P1 需求；所有延期项和平台限制有记录；前端及 IM 的 Mermaid 版本与输出规范一致。
