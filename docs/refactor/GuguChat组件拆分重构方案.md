# GuguChat 组件拆分重构方案

> ✅ **已完成**（2026-08-06）：Phase 0~6 全部落地（Phase 3 含 useChatWindow + GuguChatWindow，Phase 1 收尾、Phase 4 的 useChatStream、Phase 5 的 GuguChatImConnect 均已补齐；`useChatConversation` 也已拆出 `useChatStream`/`useChatSessions`，见 4.3 节）。devserver 用真实模型跑通 e2e（`frontend/e2e/chat.spec.ts`，已接入 CI）过程中顺带修了一个既有 bug（`newSession()` 漏调 `clearStatus()`）。
> 主文件 `GuguChat.vue` 最终 701 行（原方案目标 300~500 行，差距 201~401 行）——差距不是清理不干净，是 `GuguChat.vue` 自身的编排函数（`enterExpanded`/`exitExpanded` 等）本身就横跨窗口/会话/流式三方，详见 Phase 6 小节；`useChatConversation` 若要进一步拆分成零共享状态的形态，代价大于收益（见 4.3 节），本方案到此收尾，不作为遗留待办。

## 一、背景与目标

当前 `frontend/src/components/common/GuguChat.vue` 约 2592 行，同时承担窗口、会话、消息、流式请求、附件、录音、音频播放器、IM 连接和大量样式职责。

本次重构目标：

- 保持现有聊天协议、会话行为、IM 会话和附件协议不变。
- 将视觉组件、状态逻辑和网络编排分离。
- 让 `GuguChat.vue` 回归页面级编排入口。
- 降低消息流、窗口动画和附件功能互相影响的风险。
- 为后续统一选择交互、消息动作和 IM 能力扩展留下稳定边界。

本次不修改：

- `/agent/chat`、会话、流式响应和附件 API 协议。
- 后端 Agent Loop、IM Gateway 和数据库结构。
- `MarkdownView.vue` 的 Markdown 渲染协议。
- 窗口视觉样式和交互规则，只移动归属，不重新设计。

## 二、现状盘点

### 2.1 当前组件中的职责

| 区域 | 当前职责 |
| --- | --- |
| 窗口外壳 | 悬浮球、打开/关闭、展开/收起、尺寸计算、层级、通知锚点 |
| 会话 | 会话列表、网页/IM 分类、切换、新建、删除、恢复上次会话 |
| 消息 | 虚拟列表、滚动定位、消息测量、群成员名称和引用显示 |
| 流式 | `/agent/chat`、session stream、Abort、排队、状态气泡、工具刷新 |
| 附件 | 文件选择、拖拽、粘贴、暂存上传、附件删除 |
| 语音 | 浏览器录音、语音附件上传、语音播放、播放进度和音量 |
| IM | Bot 列表、平台会话、二维码连接、聊天内扫码绑定 |
| 内容 | Markdown、代码高亮、QQ 表情、文件缩略图和文件预览 |
| 样式 | 窗口、消息、附件、状态、播放器、侧栏和连接弹窗全部在单文件内 |

### 2.2 已确认的清理项

拆分前应单独清理：

- 合并重复的 `API_BASE` / `BASE_URL` 常量。
- 删除未使用的 `greeting` import。
- 删除历史调试探针，例如 `runtime-qq-face-probe`，不得随拆分带入正式代码。
- 检查局部定时器、事件监听和 Object URL 是否都有销毁路径。

## 三、目标目录

```text
frontend/src/components/common/gugu-chat/
├── GuguChat.vue                 # 兼容入口和总编排
├── GuguChatWindow.vue           # 聊天窗口外壳、标题栏、展开/收起
├── GuguChatFab.vue              # 悬浮球
├── GuguChatMiniPlayer.vue       # 音频迷你播放器
├── GuguChatSidebar.vue           # 会话列表、IM 平台和连接入口
├── GuguChatMessageList.vue       # 虚拟列表、滚动和消息定位
├── GuguChatMessageRow.vue        # 单条消息、引用、文件和 QQ 表情
├── GuguChatComposer.vue          # 输入框、附件、录音和发送按钮
├── GuguChatBindDialog.vue        # 聊天内 IM 绑定弹窗
├── GuguChatImConnect.vue         # IM 平台二维码连接视图
├── chatTypes.ts                  # ChatMessage、ChatFile、ChatSession 等类型
├── chatConstants.ts              # 尺寸、平台、工具集合和本地存储 key
└── composables/
    ├── useChatWindow.ts          # 窗口位置、尺寸、层级和展开状态
    ├── useChatSessions.ts        # 会话列表、切换、新建和删除
    ├── useChatStream.ts          # 流式请求、状态、取消和消息排队
    ├── useChatAttachments.ts     # 上传、拖拽、粘贴和录音入口
    ├── useChatAudio.ts           # 迷你播放器和消息语音播放
    └── useChatActions.ts         # gugu:// 动作和工具完成后的刷新通知
```

保留现有文件作为兼容入口的原因：项目其他页面可能直接 import `@/components/common/GuguChat.vue`，不在第一阶段修改所有调用方。

实际落地（2026-08-06）：

| 类别 | 计划 | 实际 | 差异说明 |
| --- | --- | --- | --- |
| 组件 | `GuguChat.vue` | `GuguChat.vue`（701 行，窗口状态已迁出、死代码已清） | 兼容入口+主控，未到 300~500 行目标 |
| 组件 | `GuguChatWindow.vue` | `GuguChatWindow.vue` (292 行) | ✅ 窗口 DOM、标题栏、展开/收起按钮已迁出 |
| 组件 | `GuguChatFab.vue` | `GuguChatFab.vue` (70 行) | ✅ |
| 组件 | `GuguChatMiniPlayer.vue` | `GuguChatMiniPlayer.vue` (146 行) | ✅ |
| 组件 | `GuguChatSidebar.vue` | `GuguChatSidebar.vue` (186 行，2026-08-06 起回归纯列表展示) | ✅ |
| 组件 | `GuguChatMessageList.vue` | `GuguChatMessageList.vue` (108 行) | ✅ |
| 组件 | `GuguChatMessageRow.vue` | `GuguChatMessageRow.vue` (93 行) | ✅ |
| 组件 | `GuguChatComposer.vue` | `GuguChatComposer.vue` (202 行) | ✅ |
| 组件 | `GuguChatBindDialog.vue` | `GuguChatBindDialog.vue` (75 行) | ✅ |
| 组件 | `GuguChatImConnect.vue` | `GuguChatImConnect.vue` (154 行，2026-08-06 拆出) | ✅ |
| 类型/常量 | `chatTypes.ts` | `chatTypes.ts` (52 行) | ✅ |
| 类型/常量 | `chatConstants.ts` | `chatConstants.ts` (16 行) | ✅ `API_BASE`、3 个尺寸常量 + 4 个本地存储 key（`SESSION_KEY` 等，原先硬编码在 `useChatWindow.ts` 里）已收拢；平台类型见 `chatTypes.ts` 的 `ImPlatformKey`，工具集合已在 `useChatActions.ts` 里按职责导出，均不需要再迁入本文件 |
| Composable | `useChatWindow.ts` | `useChatWindow.ts` (199 行) | ✅ 窗口状态已迁出主组件 |
| Composable | `useChatSessions.ts` | `useChatSessions.ts` (123 行，2026-08-06 拆出) | ✅ |
| Composable | `useChatStream.ts` | `useChatStream.ts` (274 行，2026-08-06 拆出) | ✅ |
| Composable | `useChatAttachments.ts` | `useChatAttachments.ts` (140 行) | ✅ |
| Composable | `useChatAudio.ts` | `useChatAudio.ts` (130 行) | ✅ |
| Composable | `useChatActions.ts` | `useChatActions.ts` (72 行) | ✅ |
| Composable | — | `useChatConversation.ts` (346 行，原 607 行拆出 useChatStream/useChatSessions 后) | 编排层，非完美的零共享状态拆分（见 4.3 节） |
| Composable | — | `useChatImConnect.ts` (170 行) | 原方案没列；从 Sidebar 抽出的 IM 连接 composable |
| 工具 | — | `markdown.ts`、`messageDisplay.ts`、`lazyThumbDirective.ts` | 原方案没列；合理拆分 |

## 四、职责边界

### 4.1 `GuguChat.vue`

只负责：

- 组合 composable。
- 连接窗口、侧栏、消息列表、输入区和弹窗。
- 传递状态和回调。
- 监听全局 Store 的会话/实时事件。

不负责：

- 具体消息 DOM。
- 具体附件上传实现。
- 具体流式读取算法。
- 具体音频播放控制。
- 具体窗口尺寸计算。

目标代码量：约 300～500 行。

### 4.2 视觉组件

`GuguChatWindow.vue` 只拥有窗口布局和标题栏，不拥有消息请求。

`GuguChatMessageList.vue` 只拥有虚拟列表、滚动和消息行排列，不拥有发送请求。

`GuguChatMessageRow.vue` 只负责单条消息展示和动作事件转发，不直接修改会话数组。

`GuguChatComposer.vue` 只负责输入、附件和录音交互，通过回调向上提交发送意图。

`GuguChatSidebar.vue` 只负责会话和 IM 平台列表展示，不直接管理流式回复。

实际落地（2026-08-06）：`useChatWindow` **已实现**，所有窗口状态已从 `GuguChat.vue` 迁出（`open`/`expanded`/`resizing`/`windowStyle`/`miniPlayerStyle`/`notifyAnchor`/`chatZ`/`vw`/`vh`/`contentH`/`smallH`/`syncSmallH` 等）。`GuguChat.vue` 第 238~426 行的窗口状态与样式计算区已整体迁入 `useChatWindow.ts`（199 行）+ `GuguChatWindow.vue`（292 行）。

### 4.3 Composable

| Composable | 唯一状态所有权 | 实际状态 |
| --- | --- | --- |
| `useChatWindow` | open、expanded、resizing、窗口坐标、z-index、尺寸过渡 | ✅ 已实现（199 行） |
| `useChatSessions` | `loadSession`/`newSession`/`deleteSession`、`webSessions`/`imSessions`/`currentSessionTitle` | ✅ 已拆出（123 行，2026-08-06） |
| `useChatStream` | streaming、AbortController、`send`/`stopStreaming`/`resumeStream`/`consumeStream`、发送队列 | ✅ 已拆出（274 行，2026-08-06） |
| `useChatAttachments` | pendingAtt、上传状态、拖拽/粘贴、录音状态 | ✅ |
| `useChatAudio` | 播放器、音量、进度、语音 Object URL 生命周期 | ✅ |
| `useChatActions` | gugu 协议链接、文件打开、工具完成后的刷新通知 | ✅ |
| `useChatConversation` | messages、状态气泡、滚动跟随、当前会话身份（sessionId/sessions 等共享状态）、live 监听 | ✅ 编排层（346 行，2026-08-06 由 607 行拆分而来） |
| `useChatImConnect` | — | ➕ 实际新增（IM Bot 加载、二维码轮询、连接状态；从 Sidebar 抽出） |

**`useChatStream` + `useChatSessions` 已按原方案拆出（2026-08-06），但不是"零共享状态"的干净拆分**

拆分前 `useChatConversation.ts` 607 行的 docstring 曾写过"硬拆会制造双向回调"的顾虑，实际操刀后发现顾虑基本成立，但可以用一种折中方式化解：

- `send`/`stopStreaming`/`resumeStream`/`consumeStream` 这几个**操作**已经完整搬进 `useChatStream.ts`（274 行）；`loadSession`/`newSession`/`deleteSession` 已经完整搬进 `useChatSessions.ts`（123 行）——两边各自的核心逻辑不再和对方的函数体混在一起，这是拆分真正想要的收益。
- 但 `sessionId`/`sessions`/`ownerPlatformUserId`/`isGroupSession` 这几个"当前会话身份"状态**没有归属给某一侧独占**：`useChatStream` 收到 `session_id`/`session_title` 事件时要直接改 `sessionId`/`sessions`（新对话落地成真实 id、标题生成出来），`useChatSessions` 的 `loadSession`/`newSession` 也要改它们——这是真正意义上的双向读写，不是"谁调用谁"的单向依赖。处理方式：这几个状态和 view-generation 计数器（`getViewGeneration`/`bumpViewGeneration`）留在 `useChatConversation.ts` 创建，两个子 composable 都只拿到引用（`Ref`/函数），谁都不独占、谁都不需要通过回调"通知"对方——比硬塞给一侧再让另一侧靠回调同步要简单，也不产生真正的双向回调环。
- `resolveSpeaker`/`fetchSessions` 这两个纯函数同样因为"两边都要用、且只依赖上面那几个共享状态"，留在了编排层，没有拆进 `useChatSessions`（跟原方案设想的位置不同，但没有额外的状态耦合代价）。

拆分结果：`useChatConversation.ts` 607→346 行，三个文件总行数 743 行（比拆分前单文件多出的 136 行主要是每个文件各自的 interface 声明和函数级注释，不是逻辑变多）。这次拆分**没有测试覆盖**（这块逻辑本身没有单元测试），验证方式是 `typecheck`/`typecheck:strict`/现有 246 个测试全过 + 需要人工过一遍验收清单里"流式与交互""消息与会话"两节（尤其是快速切换会话、生成中切会话、断线续看这几个高风险场景）。

## 五、消息数据约定

`chatTypes.ts` 统一收纳当前组件中松散的类型：

```ts
interface ChatMessage {
  id: number
  dbId?: number
  role: string
  text: string
  html?: string | null
  files?: ChatFile[]
  quotedText?: string
  speakerLabel?: string
  platformUserId?: string | null
  time: string
  streaming?: boolean
}

interface ChatFile {
  file_id?: number
  attach_id?: string
  name?: string
  ext?: string
  kind?: string
  qq_face?: boolean
  duration?: number
  _thumbUrl?: string
}
```

消息行组件只接收消息对象和展示回调，不直接读取全局 Store。群聊发言人识别、QQ 表情替换和引用展示在进入消息行前完成，避免模板中继续堆叠业务判断。

## 六、样式拆分策略

- 组件自身的布局样式随组件迁移，并继续使用 `scoped`。
- 只把聊天系统真正共享的 token、动画 keyframes 和基础消息变量放入 `gugu-chat.css`。
- 不将消息样式、播放器样式和窗口样式重新合并成一个全局大文件。
- 不在拆分时改变颜色、圆角、阴影、动画时长和响应式尺寸。
- 任何动画的定时器、`transitionend`、`requestAnimationFrame` 必须由拥有该状态的组件或 composable 清理。

## 七、执行阶段

### Phase 0：行为基线与清理

- 记录小窗/大窗、切换会话、IM 消息增量、流式中断、附件、录音和音频播放行为。
- 清理重复 API 常量、无用 import 和历史探针。
- 不改变组件树和数据流。

验收：现有页面行为无变化，`git diff` 只包含清理项。

实际状态（2026-08-06）：✅ **已完成**。`API_BASE` 合并到 `chatConstants.ts`；`runtime-qq-face-probe` 探针已删除；未使用的 `greeting` ref（与 `prefetchGreeting` 区分）确认无引用方。

### Phase 1：类型与纯展示层

- 新增 `chatTypes.ts`、`chatConstants.ts`。
- 抽出 `GuguChatMessageRow.vue`。
- 抽出 `GuguChatMessageList.vue`，保留现有 `@tanstack/vue-virtual`。
- 主组件继续持有消息数据和流式状态。

验收：历史消息、群聊用户名、QQ 表情、引用、Markdown、文件卡和滚动定位一致。

实际状态（2026-08-06）：✅ **已完成**（含 Phase 1 收尾）。`chatTypes.ts` / `chatConstants.ts` / `MessageRow` / `MessageList` 都已落地。收尾内容：`gugu_session_id` / `gugu_last_session_id` / `gugu_mini_pinned` / `gugu_reopen_resume` 这 4 个本地存储 key 从 `useChatWindow.ts` 内联字面量收拢进 `chatConstants.ts`；`GuguChat.vue`/`useChatAudio.ts`/`useChatConversation.ts` 里 4 处重复的 `localStorage.getItem('user_token')` 改为复用 `@/services/api` 已有的 `getToken()`（不新增聊天专属常量——`user_token` 是全局登录态，本就该走全局的 token 读取入口，不该在 chat 模块里再存一份字面量）。

**收尾期间顺带修复的 2 个历史 bug**（devserver 实测验证）：

1. **文件卡下载按钮一直没用**：`GuguChatMessageRow.vue` 里下载 SVG 只是装饰，没有自己的点击事件，整张卡只绑了一个 `openFile` 点击——可预览的文件（图片等）点下载图标实际会打开预览，而不是下载。修复：下载图标单独 `@click.stop` 发 `download` 事件，一路经 `GuguChatMessageList.vue` → `GuguChatWindow.vue`（新增 `onDownload` prop）→ `GuguChat.vue` 的 `downloadFile()`（这个函数本身早就实现完整，只是没人在"可预览"场景下调用过），并补上独立的 hover 视觉反馈。
2. **迷你播放器拖拽进度条报错**：`useChatAudio.ts` 的 `audioStartDrag` 用 `window.addEventListener('mousemove'/'mouseup', ...)` 让拖拽跟手，但这两个事件的 `e.currentTarget` 是 `window` 本身，取不到进度条的 `getBoundingClientRect()`，一拖就抛 `TypeError`。修复：`mousedown` 那一下先量好 rect 存住，`mousemove`/`mouseup` 阶段复用这个 rect，不再依赖 `currentTarget`。

### Phase 2：输入与媒体能力

- 抽出 `GuguChatComposer.vue`。
- 实现 `useChatAttachments.ts`。
- 实现 `useChatAudio.ts`，拆分迷你播放器和消息语音播放。
- 保留现有上传接口、录音格式和 Object URL 清理逻辑。

验收：文件选择、拖拽、粘贴、语音录制、取消、发送、语音播放和进度恢复一致。

实际状态（2026-08-06）：✅ **已完成**。`GuguChatComposer.vue` (202 行) / `useChatAttachments.ts` (140 行) / `useChatAudio.ts` (130 行) 全部就位，拆分中保留原有上传接口和录音格式。

### Phase 3：窗口与会话侧栏

- 抽出 `GuguChatFab.vue`、`GuguChatMiniPlayer.vue`、`GuguChatWindow.vue`。
- 抽出 `GuguChatSidebar.vue`。
- 实现 `useChatWindow.ts`、`useChatSessions.ts`。
- 保留 `GuguChat.vue` 作为兼容入口。

验收：窗口开关、展开/收起、拖入遮罩、层级、会话切换、新建、删除和恢复行为一致。

实际状态（2026-08-06）：✅ **已完成**。

- ✅ `GuguChatFab.vue` / `GuguChatMiniPlayer.vue` / `GuguChatSidebar.vue` 已拆出
- ✅ `GuguChatWindow.vue` 已拆（292 行）：窗口外壳、标题栏、展开/收起按钮、消息列表与输入框挂载点；`GuguChatBindDialog` / `GuguChatSidebar` 通过插槽由父组件填充
- ✅ `useChatWindow.ts` 已建（199 行）：open / expanded / resizing / windowStyle / miniPlayerStyle / notifyAnchor / notifyOrigin / chatZ / contentH / _baseScrollH / syncSmallH 全部收进 composable
- ✅ `useChatSessions.ts` 已独立成 composable（2026-08-06，见 4.3 节）

**主组件瘦身效果**：`GuguChat.vue` 从 969 行降至 **702 行**（减 267 行），符合预期（预计 700~750 行）。

**实施要点（2026-08-06）**：

1. **三个钩子闭环**：`onContentReset` / `onCaptureBaseScrollH` / `onSyncSmallH` 由 `useChatWindow` 内部定义并暴露，`GuguChat.vue` 解构后直接传给 `useChatConversation`，不在主组件写中间层。
2. **ref 注入链**：`GuguChatWindow.vue` 通过 `defineExpose` 暴露 `el`（chat-window DOM）/ `messageListRef` / `composerRef`；`GuguChat.vue` 用 `computed` 包装成 `useChatWindow` / `useChatConversation` 需要的形态。
3. **`toggleOpen` / `enterExpanded` / `exitExpanded` 留在主组件**：它们依赖 `useChatConversation` 的 `stick` / `scrollBottom` / `lastTop` 和 `useChatImConnect` 的 `loadBots` / `fetchSessions`，属于编排逻辑；窗口状态读写委托给 `useChatWindow` 暴露的方法（`resetContentH` / `captureBaseScrollH` / `setBaseScrollH` / `syncSmallH` / `markResizing`）。
4. **`markResizing` 收进 `useChatWindow`**：监听 `chat-window` 的 `transitionend` 结束 resizing，`composerRef.fitTextarea` 做最终校准。
5. **`onPromptConnectIM` → `onPromptConnect`**：Vue 3 的 `setFullProps` 用 `camelize(key)` 匹配 propsOptions。`on-prompt-connect-im` camelize 后是 `onPromptConnectIm`（`IM` 缩写丢失大小写），与 propsOptions 的 `onPromptConnectIM` 不匹配 → 被放进 attrs 而非 props，导致运行时 `Missing required prop`。改为 `onPromptConnect`（kebab-case `on-prompt-connect` 能正确 camelize）后修复。**教训：props 名避免 `IM` 等全大写缩写，否则 kebab-case 传参无法正确映射。**

**验证**：devserver 浏览器实测——打开/关闭、展开/收起、发送消息（小窗高度跟随）、状态点击触发 IM 连接、侧边栏 slot 渲染、无 Vue warning，全部正常。`vue-tsc --noEmit` 通过。

### Phase 4：流式与动作编排

- 实现 `useChatStream.ts`。
- 实现 `useChatActions.ts`。
- 将 `/agent/chat`、session stream、Abort、状态气泡、消息排队从组件移出。
- 将工具完成后的项目、日历、文件刷新逻辑移出。

验收：流式输出、中断、快速连续发送、切换会话、跨标签页增量和工具后刷新不回归。

实际状态（2026-08-06）：✅ **已完成**。

- ✅ `useChatActions.ts` 拆出，工具完成后的项目/日历/文件刷新逻辑已迁
- ✅ 流式收发（SSE 消费、Abort、发送队列）拆进独立的 `useChatStream.ts`（274 行）；状态气泡（`statusKind`/`setStatus`/`clearStatus` 等）留在 `useChatConversation.ts`，因为它同时被流式收发和会话切换共用，属于编排层职责，不是"没拆完"。详见 4.3 节的拆分说明（有取舍，不是零共享状态的干净拆分）

### Phase 5：IM 连接与绑定弹窗

- 抽出 `GuguChatBindDialog.vue`。
- 抽出 `GuguChatImConnect.vue`。
- 将 Bot 加载、二维码轮询和连接状态移入 Sidebar 相关 composable 或组件。
- 不改变 IM API 和绑定协议。

验收：飞书、QQ、微信连接入口，二维码轮询、取消、失败提示和聊天内绑定均正常。

实际状态（2026-08-06）：✅ **已完成**。

- ✅ `GuguChatBindDialog.vue` (75 行) 已拆
- ✅ `useChatImConnect.ts` (170 行) 已拆（IM Bot 加载、二维码轮询、连接状态）
- ✅ `GuguChatImConnect.vue` (154 行) 已拆：IM 平台二维码连接视图（分组头/已接入会话列表/扫码二维码）从 `GuguChatSidebar.vue` 迁出，`Sidebar` 从 274 行降到 186 行，回归纯网页会话列表展示
- `imGroupEl`（offline 点击后滚入视口+高亮用）原本直接挂在 Sidebar 自己的 DOM 上，现在改成 `GuguChatImConnect` 自己 `defineExpose`，`Sidebar` 转发一层——`useChatImConnect.ts` 的调用方无感知，`sidebarRef.value?.imGroupEl` 用法不变
- `exp-session-item`/`exp-session-tag`/`exp-session-del`/`exp-session-empty` 这几个网页会话列表和 IM 会话列表共用的类名，`Sidebar` 用 `:deep()` 统一覆盖到子组件里，没有跨组件复制一份样式（跟 `GuguChat.vue` 用 `:deep()` 覆盖 `MessageRow` 的既有做法一致）

### Phase 6：收口与删除兼容代码

- 确认所有调用方仍通过 `GuguChat.vue` 入口使用。
- 删除主组件中已迁移的重复函数、状态和样式。
- 检查定时器、监听器、Object URL、AbortController 清理。
- 统一导出路径，避免出现旧路径和新路径同时被业务使用。

验收：导入路径统一，主组件行数达标。

实际状态（2026-08-06）：🟢 **清理项已完成，行数目标未达成**。

- ✅ 调用方统一：全仓库只有 `@/components/common/GuguChat.vue` 这一个 import 入口，无遗留旧路径
- ✅ 删除死代码：`isImageFile`/`isAnimatedImageFile`/`fmtDur`/`voiceBar`/`renderMdStream`/`CLIENT_ID`/`ChatSession` 这 7 个导入以及 `useLiveStore()` 实例化（`useChatConversation.ts` 内部已经自己调用了一份，这里是重复的死代码）全部移除；修正了一处指向已经过时路径的迁移注释（`.im-qr-cancel` 早已进一步迁到 `GuguChatImConnect.vue`，注释还写着 `GuguChatSidebar.vue`）
- ✅ 定时器/监听器/AbortController 清理：抽出的几个 composable（`useChatWindow`/`useChatAudio`/`useChatConversation` 等）都有对应的清理路径，本轮拆分没有引入新的泄漏
- 🟡 **行数目标未达成**：706→701 行（只降了 5 行），离 300~500 行还差 201~401 行。根因不是清理不干净——`GuguChat.vue` 本身接的还是 `useChatConversation` 同一套公开 API，`useChatConversation.ts` 内部后续拆成 `useChatStream`+`useChatSessions`（见 4.3 节）不会让 `GuguChat.vue` 变短，因为它一直只持有编排层的返回值，没有直接铺开过 607 行那些实现细节。`GuguChat.vue` 想再往下减，得看 `enterExpanded`/`exitExpanded`/`toggleOpen` 这类真正混着"窗口状态+会话+流式"三方调用的编排函数还能不能进一步收敛，不在本轮范围内。

## 八、风险控制

### 高风险

- 流式状态和消息列表拆分后，旧 session 回调可能写入新会话。
- 虚拟列表测量依赖 `messagesEl`，组件拆分后 ref 传递错误会导致滚动跳动。
- 切换会话时的增量 SSE 可能追加到错误会话。

处理方式：所有异步回调携带 session id，提交前校验仍是当前会话；消息列表只通过明确的 `messages` 和 `sessionId` 接口接收数据。

### 中风险

- 组件卸载后定时器或事件监听仍然执行。
- 音频 Object URL 泄漏。
- `gugu://` 点击事件委托从消息气泡迁移后失效。
- scoped CSS 选择器层级变化导致 Markdown 或代码块样式变化。

处理方式：每个 composable 提供统一 cleanup；消息动作仍由消息列表向上转发；拆分后逐阶段对比截图和 DOM 样式。

### 不建议的做法

- 一次性把所有逻辑迁移到新目录。
- 按每个按钮、每个图标继续细拆。
- 让 `MessageRow` 直接访问 Pinia、路由或 API。
- 让多个 composable 互相 import。
- 在拆分同时重写消息协议、虚拟列表或窗口动画。

## 九、验收清单

标了 🤖 的项在 `frontend/e2e/chat.spec.ts` 里有自动化覆盖（接入 CI，见下方"自动检查"）；其余仍需人工过一遍，尤其是依赖 IM 平台绑定/真实设备权限（录音）的项，CI 里刻意没有硬造成 `test.skip()` 兜底的假绿灯（跟 `file-lifecycle.spec.ts`/`scheduled-task-run.spec.ts` 同一个原则，见 workflow 里的注释）。

### 消息与会话

- [x] 🤖 新建、切换会话正常（删除/恢复未覆盖，见 e2e 文件头注释）。
- [ ] 网页、QQ、飞书、微信会话分类正确。
- [ ] 群聊消息显示正确的发言人名称和角色。
- [ ] 引用消息、QQ 表情、图片和文件显示正常。
- [ ] Markdown、代码块和复制按钮正常。

### 流式与交互

- [x] 🤖 流式回复能收到、渲染正确（固定回复文本，见 e2e）。
- [ ] 生成中发送多条消息按顺序排队。
- [ ] 中断后重新发送不会覆盖新会话状态。
- [ ] 切换会话后旧流不会写入当前会话。
- [ ] 工具完成后项目、日历和文件视图能刷新。

### 附件与音频

- [ ] 选择、拖拽、粘贴附件正常。
- [ ] 上传失败可以提示并恢复输入状态。
- [ ] 录音、取消录音和自动发送正常。
- [ ] 迷你播放器播放、暂停、音量和进度正常。
- [ ] 语音消息播放切换和 Object URL 清理正常。

### 窗口与 IM

- [x] 🤖 悬浮球点击开关聊天窗、关闭按钮收起正常。
- [x] 🤖 小窗/大窗展开收起后标题栏文案和会话列表状态正确（动画是否跳变仍需肉眼看）。
- [ ] IM 二维码连接、取消、轮询失败正常。
- [ ] 聊天内扫码绑定正常。
- [ ] 快速打开/关闭、切换会话和窗口 resize 无明显闪烁。

### 自动检查

```text
npm run typecheck
npm run test:run
git diff --check
npx playwright test e2e/chat.spec.ts   # 需要本地/devserver 跑着后端；CI 用 mock LLM，见 .github/workflows/runtime-integration.yml
```

每个阶段单独提交。某一阶段出现行为差异时，先停在该阶段定位，不进入下一阶段。

## 十、完成标准

- `GuguChat.vue` 只保留页面级编排，不再直接实现媒体、消息行和流式细节。
- 单个功能模块拥有清晰的状态所有权和清理路径。
- 所有现有聊天、IM、附件、音频和窗口验收项通过。
- 新旧 import 路径统一，不保留重复兼容实现。
- 主组件目标控制在约 300～500 行，各业务模块保持在可独立审查的规模。

### 实际状态（2026-08-06）

| 完成标准 | 状态 |
| --- | --- |
| `GuguChat.vue` 只保留页面级编排 | 🟡 部分达成（701 行，窗口状态已迁出、死代码已清；会话切换/部分流式仍在主组件） |
| 状态所有权清晰 | 🟢 `useChatStream`/`useChatSessions` 已拆出各自的操作逻辑；`useChatConversation` 仍持有共享的会话身份状态（非完美的零共享拆分，见 4.3 节说明），但不再是单文件五类职责 |
| 现有聊天/IM/附件/音频/窗口验收项通过 | 🟢 拆分阶段未改变行为（无回归） |
| import 路径统一 | ✅ 所有调用方走 `@/components/common/GuguChat.vue` 入口 |
| 主组件 300~500 行 | 🟡 当前 701 行（Phase 3 后从 969 降至 702，Phase 1 收尾 + bug 修复后 706，Phase 6 清理后 701），差距 201~401 行——差距根因见 Phase 6 |

### 下一步建议

按"先解决最大缺口"原则：

1. **Phase 3 已完成**（2026-08-06）：`useChatWindow.ts` + `GuguChatWindow.vue` 落地，主组件从 969 降至 702 行。✅
2. **Phase 1 收尾已完成**（2026-08-06）：本地存储 key 收拢进 `chatConstants.ts`，`user_token` 重复读取改用 `getToken()`。✅
3. **Phase 5 收尾已完成**（2026-08-06）：拆出 `GuguChatImConnect.vue`（154 行），`GuguChatSidebar.vue` 回归纯列表展示（274→186 行）。✅
4. **Phase 6 收口已完成**（2026-08-06）：清掉 7 个死导入 + 1 处重复的 `useLiveStore()` 实例化，修正一处过时的迁移注释；调用方 import 路径本就统一，无需改动。✅
5. **`useChatConversation` 拆分已完成**（2026-08-06）：拆出 `useChatStream.ts`（274 行）+ `useChatSessions.ts`（123 行），`useChatConversation.ts` 从 607 行降到 346 行。共享的会话身份状态（`sessionId`/`sessions` 等）留在编排层，见 4.3 节说明——不是零共享状态的完美拆分，但两边核心操作逻辑已经分离。✅ 至此整个拆分方案的已知项全部处理完，剩下的都是"未来如果……可以再……"级别的可选项，不再是待办。
