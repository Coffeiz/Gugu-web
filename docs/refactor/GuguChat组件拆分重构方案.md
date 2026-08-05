# GuguChat 组件拆分重构方案

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

### 4.3 Composable

| Composable | 唯一状态所有权 |
| --- | --- |
| `useChatWindow` | open、expanded、resizing、窗口坐标、z-index、尺寸过渡 |
| `useChatSessions` | sessions、sessionId、加载/新建/删除/恢复会话 |
| `useChatStream` | streaming、AbortController、流式读取、状态气泡、发送队列 |
| `useChatAttachments` | pendingAtt、上传状态、拖拽/粘贴、录音状态 |
| `useChatAudio` | 播放器、音量、进度、语音 Object URL 生命周期 |
| `useChatActions` | gugu 协议链接、文件打开、工具完成后的刷新通知 |

Composable 之间不互相 import。由 `GuguChat.vue` 组合后，通过参数和回调连接，避免形成新的循环依赖。

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

### Phase 1：类型与纯展示层

- 新增 `chatTypes.ts`、`chatConstants.ts`。
- 抽出 `GuguChatMessageRow.vue`。
- 抽出 `GuguChatMessageList.vue`，保留现有 `@tanstack/vue-virtual`。
- 主组件继续持有消息数据和流式状态。

验收：历史消息、群聊用户名、QQ 表情、引用、Markdown、文件卡和滚动定位一致。

### Phase 2：输入与媒体能力

- 抽出 `GuguChatComposer.vue`。
- 实现 `useChatAttachments.ts`。
- 实现 `useChatAudio.ts`，拆分迷你播放器和消息语音播放。
- 保留现有上传接口、录音格式和 Object URL 清理逻辑。

验收：文件选择、拖拽、粘贴、语音录制、取消、发送、语音播放和进度恢复一致。

### Phase 3：窗口与会话侧栏

- 抽出 `GuguChatFab.vue`、`GuguChatMiniPlayer.vue`、`GuguChatWindow.vue`。
- 抽出 `GuguChatSidebar.vue`。
- 实现 `useChatWindow.ts`、`useChatSessions.ts`。
- 保留 `GuguChat.vue` 作为兼容入口。

验收：窗口开关、展开/收起、拖入遮罩、层级、会话切换、新建、删除和恢复行为一致。

### Phase 4：流式与动作编排

- 实现 `useChatStream.ts`。
- 实现 `useChatActions.ts`。
- 将 `/agent/chat`、session stream、Abort、状态气泡、消息排队从组件移出。
- 将工具完成后的项目、日历、文件刷新逻辑移出。

验收：流式输出、中断、快速连续发送、切换会话、跨标签页增量和工具后刷新不回归。

### Phase 5：IM 连接与绑定弹窗

- 抽出 `GuguChatBindDialog.vue`。
- 抽出 `GuguChatImConnect.vue`。
- 将 Bot 加载、二维码轮询和连接状态移入 Sidebar 相关 composable 或组件。
- 不改变 IM API 和绑定协议。

验收：飞书、QQ、微信连接入口，二维码轮询、取消、失败提示和聊天内绑定均正常。

### Phase 6：收口与删除兼容代码

- 确认所有调用方仍通过 `GuguChat.vue` 入口使用。
- 删除主组件中已迁移的重复函数、状态和样式。
- 检查定时器、监听器、Object URL、AbortController 清理。
- 统一导出路径，避免出现旧路径和新路径同时被业务使用。

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
