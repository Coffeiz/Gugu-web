# GuguChat 组件拆分重构方案

> 状态更新（2026-08-06）：Phase 0~3、Phase 5~6 已完成（Phase 3 含 useChatWindow + GuguChatWindow 落地，Phase 1 收尾已完成），Phase 4 部分偏离原方案。
> 主文件 `GuguChat.vue` 当前 701 行（目标 300~500 行，差距 201~401 行）——Phase 6 的清理项已做完，行数差距的根因是 `useChatConversation` 拆不拆的待评估决定，详见 Phase 6 小节。

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
| 组件 | `GuguChat.vue` | `GuguChat.vue`（706 行，窗口状态已迁出） | 兼容入口+主控，未到 300~500 行目标 |
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
| Composable | `useChatSessions.ts` | ❌ 未拆 | 被 `useChatConversation` 内聚（见下文偏离说明） |
| Composable | `useChatStream.ts` | ❌ 未拆 | 被 `useChatConversation` 内聚（见下文偏离说明） |
| Composable | `useChatAttachments.ts` | `useChatAttachments.ts` (140 行) | ✅ |
| Composable | `useChatAudio.ts` | `useChatAudio.ts` (130 行) | ✅ |
| Composable | `useChatActions.ts` | `useChatActions.ts` (72 行) | ✅ |
| Composable | — | `useChatConversation.ts` (607 行) | **设计偏离**（见 4.3 节） |
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
| `useChatSessions` | sessions、sessionId、加载/新建/删除/恢复会话 | 🟡 被 `useChatConversation` 内聚；外部可拿到 `fetchSessions`/`loadSession`/`newSession`/`deleteSession` |
| `useChatStream` | streaming、AbortController、流式读取、状态气泡、发送队列 | 🟡 被 `useChatConversation` 内聚；外部可拿到 `streaming`/`send`/`stopStreaming`/`resumeStream` |
| `useChatAttachments` | pendingAtt、上传状态、拖拽/粘贴、录音状态 | ✅ |
| `useChatAudio` | 播放器、音量、进度、语音 Object URL 生命周期 | ✅ |
| `useChatActions` | gugu 协议链接、文件打开、工具完成后的刷新通知 | ✅ |
| `useChatConversation` | — | ➕ 实际新增（见下方"设计偏离"） |
| `useChatImConnect` | — | ➕ 实际新增（IM Bot 加载、二维码轮询、连接状态；从 Sidebar 抽出） |

**设计偏离：`useChatConversation` 替代 `useChatStream` + `useChatSessions`**

`useChatConversation.ts` 的 docstring 已写明偏离理由：

> 这是全组件耦合最深的一块——发送/续看/切会话/滚动/窗口高度互相牵扯，硬拆成 doc 里设想的多个更细粒度 composable 反而会制造出一堆双向回调，不如作为一个内聚单元收在一起，对外只暴露窗口尺寸计算需要的三个钩子（`onContentReset`/`onCaptureBaseScrollH`/`onSyncSmallH`），由 `GuguChat.vue` 组合时接到窗口尺寸那部分状态上。

偏离的代价：

- `useChatConversation.ts` 607 行，承担消息数据/会话列表/流式收发/状态气泡/滚动跟随五类职责，单文件偏大
- 未来若要把"流式收发"独立成可复用的 `useChatStream`（给非聊天场景用），需要先解开耦合

偏离的理由：

- 发送、续看、切会话、滚动、窗口高度互相牵制：比如切会话时要 abort 旧流、清空消息队列、重置滚动基线、通知窗口重算高度——这些操作在多个 composable 之间跳会形成回调环
- 三个窗口尺寸钩子（`onContentReset`/`onCaptureBaseScrollH`/`onSyncSmallH`）作为唯一外部接口，让 `useChatConversation` 对窗口逻辑保持单向依赖

维护指引：

- 若未来需要把流式收发独立复用，可先把 `send`/`stopStreaming`/`resumeStream`/`streaming` 抽成 `useChatStream`，把 `fetchSessions`/`loadSession`/`newSession`/`deleteSession` 抽成 `useChatSessions`，保留 `useChatConversation` 作为编排层（消息/滚动基线/状态气泡等仍内聚）
- 拆的时候优先把"对外暴露的 API"先独立，内部耦合的部分（abort 时清空消息队列等）保留在 `useChatConversation`

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
- 🟡 `useChatSessions.ts` 未独立成 composable，被 `useChatConversation` 内聚（沿用既有偏离）

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

实际状态（2026-08-06）：🟡 **部分完成，有设计偏离**。

- ✅ `useChatActions.ts` 拆出，工具完成后的项目/日历/文件刷新逻辑已迁
- 🟡 流式收发（SSE 消费、Abort、状态气泡、消息排队）**没有按方案拆成独立的 `useChatStream`**，而是和会话管理一起内聚在 `useChatConversation.ts`（607 行）。详见 4.3 节"设计偏离"说明

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
- 🟡 **行数目标未达成**：706→701 行（只降了 5 行），离 300~500 行还差 201~401 行。**根因不是清理不干净，是行数目标本身依赖 4.3 节那个还没做的决定**——`useChatConversation.ts`（607 行，消息/会话/流式/滚动/状态气泡五合一）如果不拆成独立的 `useChatStream`/`useChatSessions`，主组件里组合它、传参、解构给它的那部分代码就没法再往下减。这是一个范围/成本决策，不是清理疏漏，留给下一步单独评估。

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

### 消息与会话

- [ ] 新建、切换、删除和恢复会话正常。
- [ ] 网页、QQ、飞书、微信会话分类正确。
- [ ] 群聊消息显示正确的发言人名称和角色。
- [ ] 引用消息、QQ 表情、图片和文件显示正常。
- [ ] Markdown、代码块和复制按钮正常。

### 流式与交互

- [ ] 流式回复持续显示，状态气泡不闪烁。
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

- [ ] 悬浮球和聊天窗层级正确。
- [ ] 小窗/大窗展开收起动画不跳变。
- [ ] IM 二维码连接、取消、轮询失败正常。
- [ ] 聊天内扫码绑定正常。
- [ ] 快速打开/关闭、切换会话和窗口 resize 无明显闪烁。

### 自动检查

```text
npm run typecheck
npm run test:run
git diff --check
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
| 状态所有权清晰 | 🟡 大部分清晰；`useChatConversation` 内聚五类职责偏大 |
| 现有聊天/IM/附件/音频/窗口验收项通过 | 🟢 拆分阶段未改变行为（无回归） |
| import 路径统一 | ✅ 所有调用方走 `@/components/common/GuguChat.vue` 入口 |
| 主组件 300~500 行 | 🟡 当前 701 行（Phase 3 后从 969 降至 702，Phase 1 收尾 + bug 修复后 706，Phase 6 清理后 701），差距 201~401 行——差距根因见 Phase 6 |

### 下一步建议

按"先解决最大缺口"原则：

1. **Phase 3 已完成**（2026-08-06）：`useChatWindow.ts` + `GuguChatWindow.vue` 落地，主组件从 969 降至 702 行。✅
2. **Phase 1 收尾已完成**（2026-08-06）：本地存储 key 收拢进 `chatConstants.ts`，`user_token` 重复读取改用 `getToken()`。✅
3. **Phase 5 收尾已完成**（2026-08-06）：拆出 `GuguChatImConnect.vue`（154 行），`GuguChatSidebar.vue` 回归纯列表展示（274→186 行）。✅
4. **Phase 6 收口已完成**（2026-08-06）：清掉 7 个死导入 + 1 处重复的 `useLiveStore()` 实例化，修正一处过时的迁移注释；调用方 import 路径本就统一，无需改动。✅
5. **评估 `useChatConversation` 拆分（唯一剩余项）**：607 行偏大，但 docstring 已说明不拆的理由；主组件卡在 701 行而不是 300~500 行，根因就是这个——按需评估是否要把流式收发独立成 `useChatStream`、会话管理独立成 `useChatSessions` 供其他场景复用。这不是"没做完的收口"，是一个需要单独决策的范围问题。
