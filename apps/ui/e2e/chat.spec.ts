import { test, expect } from '@playwright/test'

/**
 * CI 关键路径之三：GuguChat 悬浮窗——发消息收到回复、大窗会话列表、
 * 新建会话、收起/关闭。跟另外两条关键路径同一个原则：CI 里接
 * scripts/testing/mock_llm_server.py 的固定回复，不接真实模型、不受限流/网络
 * 影响。但断言只认"生成了一条新的 AI 回复气泡"，不死抠固定回复的具体
 * 文字——这样本地/devserver 用真实模型跑也一样有效（只是不如 CI 那么
 * 快，回复内容也不确定，但"发了消息、收到回复"这个核心行为一样能测）。
 *
 * 打开对话框自带一条默认问候（打字机动画的那条 AI 消息），所以不能直接
 * 断言"存在 .msg.ai"——发消息前后要用消息数量变化来确认收到的是新回复。
 *
 * 不覆盖附件/语音/IM 扫码连接——这些要么需要真实文件系统之外的设备权限
 * （录音），要么依赖 IM 平台绑定（测试账号没有），硬造出来的用例大概率
 * 靠 test.skip() 兜底、又是一条"全绿但没测什么"的假绿灯，不接入 CI。
 * 这几项仍按 docs/refactor/【已完成】GuguChat组件拆分重构方案.md 第九节的验收清单
 * 人工过一遍。
 *
 * 选择器注意：不能直接用 `.msg.ai .msg-bubble` 断言"收到 AI 回复"——生成中的
 * 思考/工具状态气泡（GuguChatMessageList.vue 里 `v-if="statusKind"` 那个
 * `class="msg ai"` 元素）也匹配这个选择器，会导致断言在真正的回复到达之前
 * 就"假绿"通过。真实的历史消息渲染在虚拟列表的 `.msg-virtual-row` 里，状态
 * 气泡是虚拟列表外的兄弟节点，用 AI_REPLY 这个更窄的选择器排除掉它。
 */

const AI_REPLY = '.msg-virtual-row .msg.ai .msg-bubble'
const remoteE2e = Boolean(process.env.PLAYWRIGHT_BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL))
const aiReplyTimeout = remoteE2e ? 300000 : 15000

test.describe('GuguChat 悬浮窗', () => {
  // devserver 使用当前配置的真实模型，慢响应时队列用例需要等待两轮回复。
  // CI 指向固定回复的 mock 服务，仍保留较短预算。
  test.describe.configure({ timeout: remoteE2e ? 360000 : 30000 })
  test('发消息收到回复，刷新页面后会话内容还在', async ({ page }) => {
    await page.goto('/')

    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator(AI_REPLY).count()
    const text = `e2e-chat-${Date.now()}`
    await chatWindow.locator('.chat-input-editor .ProseMirror').fill(text)
    await chatWindow.locator('.send-btn').click()

    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: text })).toBeVisible()
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(aiBubblesBefore + 1, { timeout: aiReplyTimeout })
    await expect(chatWindow.locator(AI_REPLY).last()).not.toBeEmpty()

    // 会话 id 存在 sessionStorage，刷新同一标签页应该接续，不是新对话——
    // 用户消息和 AI 回复都要落库持久化，不能只验证用户那一半。
    await page.reload()
    await expect(page.locator('.ai-fab')).toBeVisible()
    await page.locator('.ai-fab').click()
    await expect(page.locator('.chat-window .msg.user .msg-bubble', { hasText: text })).toBeVisible({ timeout: remoteE2e ? 30000 : 15000 })
    await expect(page.locator('.chat-window').locator(AI_REPLY).last()).not.toBeEmpty()
  })

  test('展开大窗后会话列表显示当前会话，新建会话清空消息区', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator(AI_REPLY).count()
    const text = `e2e-chat-expand-${Date.now()}`
    await chatWindow.locator('.chat-input-editor .ProseMirror').fill(text)
    await chatWindow.locator('.send-btn').click()
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(aiBubblesBefore + 1, { timeout: aiReplyTimeout })

    await chatWindow.locator('.popup-icon-btn[title="展开"]').click()
    const sidebar = page.locator('.exp-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.locator('.exp-session-item.active')).toBeVisible()

    await sidebar.locator('.exp-new-session-btn').click()
    await expect(chatWindow.locator('.msg')).toHaveCount(0)

    // 收起大窗回到小窗，标题栏文案不再是会话标题（大窗才显示会话标题）。
    await chatWindow.locator('.exp-icon-btn[title="收起"]').click()
    await expect(chatWindow.locator('.chat-title')).toHaveText('咕咕')
  })

  test('关闭按钮收起聊天窗，悬浮球恢复可点', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    await chatWindow.locator('.popup-close-btn').click()
    await expect(chatWindow).not.toBeVisible()
    await expect(page.locator('.ai-fab')).toBeVisible()
  })

  test('生成中发的消息进了排队，切到新会话后不会被发进新会话', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const textarea = chatWindow.locator('.chat-input-editor .ProseMirror')
    const sendBtn = chatWindow.locator('.send-btn')

    const firstText = `e2e-queue-first-${Date.now()}`
    await textarea.fill(firstText)
    await sendBtn.click()

    // 不等第一条回复完成，立刻发第二条——streaming 标志在 fetch 发出前就已同步置位，
    // 这条必然会走排队分支，不依赖真实模型/mock 回复有多快。注意这里必须用回车提交，
    // 不能点发送按钮：生成中 .send-btn 会切换成"停止生成"，点它会中止流式而不是排队
    // （排队入口是 GuguChatComposer.vue 的 v-enter，无论是否在生成中都调 onSend()）。
    const queuedText = `e2e-queue-should-not-leak-${Date.now()}`
    await textarea.fill(queuedText)
    // ProseMirror 的 DOM 变更经 MutationObserver 异步落成事务；不等文本落地就按
    // Enter，onSend 会读到空输入被静默吞掉（失败快照里输入框为空、气泡未出现）。
    // toHaveText 轮询等待，间接保证 PM 文档已同步。
    await expect(textarea).toHaveText(queuedText)
    await textarea.press('Enter')
    await expect(chatWindow.locator('.chat-pending-item .chat-pending-text', { hasText: queuedText })).toBeVisible()

    // 在排队消息还没被接力发送之前就切到一个全新会话。
    await chatWindow.locator('.popup-icon-btn[title="展开"]').click()
    const sidebar = page.locator('.exp-sidebar')
    await expect(sidebar).toBeVisible()
    await sidebar.locator('.exp-new-session-btn').click()
    await expect(chatWindow.locator('.msg')).toHaveCount(0)

    // 新会话里发一条消息，等它的回复落地——如果排队消息没被正确清空/核对身份，
    // 这条回复结束时会把 queuedText 接力发进这个新会话，气泡上就会看到它。
    const newSessionText = `e2e-queue-new-session-${Date.now()}`
    await textarea.fill(newSessionText)
    await sendBtn.click()
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(1, { timeout: aiReplyTimeout })

    // 等一小段时间，确认没有排队消息延迟冒出来（真出问题时会多一条 user 气泡）。
    await page.waitForTimeout(1500)
    await expect(chatWindow.locator('.msg.user .msg-bubble')).toHaveCount(1)
    await expect(chatWindow.locator('.msg.user .msg-bubble').first()).toHaveText(newSessionText)
    await expect(chatWindow.locator('.msg', { hasText: queuedText })).toHaveCount(0)
  })

  test('全新会话第一轮排队，session_id 到达后两条都进同一个会话', async ({ page }) => {
    // 覆盖 PR #8 复查的 P1 边界：
    // 新对话发送第一条时 sessionId 还是 null（后端稍后才回传 session_id 事件），
    // 排队项入队时记录的也是 null。如果消费条件仍用 strict ===
    // "next.sessionId === sessionId.value"，session_id 事件把 sessionId.value
    // 变成 123 后，null !== 123 会让排队项被当作"已经离开的会话"丢弃。
    // 修复：消费时允许 sessionId == null 在同 viewGeneration 内消费；session_id
    // 事件到达时再回填真实 id。两条消息应该都进入同一个全新会话并各自收到回复。
    //
    // 用显式闸门暂停首个 POST，而非依赖固定延迟：直到第二条确实进入队列前，
    // session_id 事件都不可能返回，因此无论 CI 机器快慢都稳定覆盖「先排队、后拿到 id」。
    let firstRequestDelayed = false
    let firstRequestPaused = false
    let releaseFirstRequest: () => void = () => {}
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = () => resolve()
    })
    await page.route('**/api/v1/agent/chat', async (route) => {
      // 只暂停首次请求；后续请求（含接力发送的第二条）直接放行。
      if (!firstRequestDelayed) {
        firstRequestDelayed = true
        firstRequestPaused = true
        await firstRequestGate
      }
      await route.continue()
    })

    try {
      await page.goto('/')
      await page.locator('.ai-fab').click()
      const chatWindow = page.locator('.chat-window')
      await expect(chatWindow).toBeVisible()

      // 强制从全新会话开始——切到新会话并确认消息区为空。
      await chatWindow.locator('.popup-icon-btn[title="展开"]').click()
      const sidebar = page.locator('.exp-sidebar')
      await expect(sidebar).toBeVisible()
      await sidebar.locator('.exp-new-session-btn').click()
      await expect(chatWindow.locator('.msg')).toHaveCount(0)

      const textarea = chatWindow.locator('.chat-input-editor .ProseMirror')
      const sendBtn = chatWindow.locator('.send-btn')

      const firstText = `e2e-newqueue-first-${Date.now()}`
      await textarea.fill(firstText)
      await sendBtn.click()
      await expect.poll(() => firstRequestPaused).toBe(true)

      // 首个请求仍暂停，session_id 尚未回传；第二条实际进入队列后再放行。
      const queuedText = `e2e-newqueue-second-${Date.now()}`
      await textarea.fill(queuedText)
      // 等 PM 文档落地再 Enter，防空输入被静默吞掉的竞态。
      await expect(textarea).toHaveText(queuedText)
      await textarea.press('Enter')
      // 排队期间消息显示在输入框上方的排队条里，等首轮确认 session_id 后才成为对话气泡。
      await expect(chatWindow.locator('.chat-pending-item .chat-pending-text', { hasText: queuedText })).toBeVisible()
      releaseFirstRequest()

      // 关键断言：不切会话，两条消息都收到回复；旧缺陷会留下第二条 user 气泡但不产生回复。
      // 第二条只有在第一轮模型回复完成后才会从队列发出；devserver 使用真实模型，
      // 因此该气泡可能要等到第一轮长响应结束后才出现。
      await expect(chatWindow.locator('.msg.user .msg-bubble')).toHaveCount(2, { timeout: aiReplyTimeout + 15000 })
      const aiBubbles = chatWindow.locator(AI_REPLY)
      await expect(aiBubbles).toHaveCount(2, { timeout: aiReplyTimeout })
      await expect(aiBubbles.nth(0)).not.toBeEmpty()
      await expect(aiBubbles.nth(1)).not.toBeEmpty()
      // AI 回复可能复述用户输入；这里只核对 user 气泡，避免同名回复造成误计。
      await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: firstText })).toHaveCount(1)
      await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: queuedText })).toHaveCount(1)
    } finally {
      // 断言失败时也释放拦截请求，避免悬挂的 route 阻碍页面清理。
      releaseFirstRequest()
    }
  })

  test('点击侧栏会话标题区域能切换会话', async ({ page }) => {
    // 回归 PR #9 引入的 bug：SessionTitleEdit 侧边栏模式外层曾用 @click.stop 阻止冒泡，
    // 导致点击会话标题区域（占 session item 大部分宽度）无法触发 onLoadSession 切换会话，
    // 只有点标题外的空白边缘才能切。修复后点击标题区域应正常切换。

    // 会话切换不依赖模型回复。devserver 配置真实模型时，普通测试文本也可能触发多轮
    // 工具调用；这会让纯 UI 回归测试超时，并可能对测试账号数据产生副作用。合成会话
    // 历史只隔离网络数据，标题点击、loadSession 和消息区更新仍在真实浏览器组件中验证。
    const sessions = [
      { id: 880002, title: 'e2e-session-b', source: 'web', chatType: 'private', workspaceName: null,
        goalActive: false, goalStatus: null, filesystemAuthorized: false,
        filesystemAuthorizationEnabled: false, updatedAt: '2026-10-22T10:02:00Z', createdAt: '2026-10-22T10:02:00Z' },
      { id: 880001, title: 'e2e-session-a', source: 'web', chatType: 'private', workspaceName: null,
        goalActive: false, goalStatus: null, filesystemAuthorized: false,
        filesystemAuthorizationEnabled: false, updatedAt: '2026-10-22T10:01:00Z', createdAt: '2026-10-22T10:01:00Z' },
    ]
    await page.route('**/api/v1/agent/sessions', route => route.fulfill({ json: sessions }))
    await page.route('**/api/v1/agent/sessions/*/messages*', route => {
      const sessionId = Number(new URL(route.request().url()).pathname.split('/').at(-2))
      const isA = sessionId === 880001
      const createdAt = isA ? '2026-10-22T10:01:00Z' : '2026-10-22T10:02:00Z'
      const userText = isA ? '会话 A 的测试消息' : '会话 B 的测试消息'
      return route.fulfill({ json: {
        session: { id: sessionId, title: isA ? 'e2e-session-a' : 'e2e-session-b', chatType: 'private' },
        active: false,
        executionState: 'idle',
        pendingMessageCount: 0,
        pendingQueue: [],
        pagination: { limit: 50, hasMore: false, hasNewer: false, oldestId: sessionId, newestId: sessionId },
        messages: [{ id: sessionId, role: 'user', content: userText, files: [], references: [],
          createdAt, timelineOrder: sessionId * 1000 }],
        timelineEvents: [],
        toolEvents: [],
      } })
    })
    await page.route('**/api/v1/agent/sessions/*/interactions', route => route.fulfill({ json: { items: [] } }))

    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    // 展开大窗，进入侧栏会话列表
    await chatWindow.locator('.popup-icon-btn[title="展开"]').click()
    const sidebar = page.locator('.exp-sidebar')
    await expect(sidebar).toBeVisible()

    const sessionAItem = sidebar.locator('.exp-session-item[data-session-id="880001"]')
    const sessionBItem = sidebar.locator('.exp-session-item[data-session-id="880002"]')
    await expect(sessionAItem).toBeVisible()
    await expect(sessionBItem).toBeVisible()

    // 先切到 B，再点击 A 的标题区域；两条合成历史具有不同正文，能验证切换结果。
    await sessionBItem.locator('.exp-session-title').click()
    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: '会话 B 的测试消息' })).toBeVisible()
    await expect(sessionBItem).toHaveClass(/active/)

    // 点击会话 A 的标题区域（.exp-session-title，占 item 大部分宽度）——修复前这里被
    // @click.stop 拦截无法切换；修复后应切回 A，消息区显示 A 的消息。
    await sessionAItem.locator('.exp-session-title').click()
    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: '会话 A 的测试消息' })).toBeVisible()
    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: '会话 B 的测试消息' })).toHaveCount(0)
    await expect(sessionAItem).toHaveClass(/active/)
  })

  test('滚动选中文字时保留跨屏消息，工具卡片滚出视口后仍保持展开', async ({ page }) => {
    const sessionId = 880003
    const createdAt = '2026-10-22T10:00:00Z'
    const messages = Array.from({ length: 80 }, (_, index) => ({
      id: 890000 + index,
      role: 'user',
      content: `可选消息-${index}：跨屏选择回归内容。`,
      files: [],
      references: [],
      createdAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
      timelineOrder: index * 1000 + 1,
    }))
    const timelineEvents = [{
      kind: 'tool',
      // 历史映射要求稳定的时间线事件身份；普通 `id` 不符合契约，会在消息装载前抛错。
      eventId: 'e2e-selection-tool-event',
      messageId: 890040,
      timelineOrder: 40 * 1000 + 2,
      runId: 'e2e-selection-run',
      roundId: '1',
      toolCallId: 'e2e-selection-tool',
      toolName: 'shell',
      toolLabel: '执行测试命令',
      toolStatus: 'success',
      toolInput: { command: 'printf test' },
      toolResult: 'test 完成',
      detailsAvailable: true,
      createdAt: new Date(Date.parse(createdAt) + 40_500).toISOString(),
    }]
    await page.route('**/api/v1/agent/sessions', route => route.fulfill({ json: [
      { id: sessionId, title: 'e2e-virtual-selection', source: 'web', chatType: 'private', workspaceName: null,
        goalActive: false, goalStatus: null, filesystemAuthorized: false,
        filesystemAuthorizationEnabled: false, updatedAt: createdAt, createdAt },
    ] }))
    await page.route(`**/api/v1/agent/sessions/${sessionId}/messages*`, route => route.fulfill({ json: {
      session: { id: sessionId, title: 'e2e-virtual-selection', chatType: 'private' },
      active: false,
      executionState: 'idle',
      pendingMessageCount: 0,
      pendingQueue: [],
      pagination: { limit: 200, hasMore: false, hasNewer: false, oldestId: messages[0].id, newestId: messages.at(-1)?.id },
      messages,
      timelineEvents,
    } }))
    await page.route(`**/api/v1/agent/sessions/${sessionId}/interactions`, route => route.fulfill({ json: { items: [] } }))

    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await chatWindow.locator('.popup-icon-btn[title="展开"]').click()
    const sessionItem = page.locator(`.exp-session-item[data-session-id="${sessionId}"]`)
    await expect(sessionItem).toBeVisible()
    await sessionItem.locator('.exp-session-title').click()

    const scrollContainer = chatWindow.locator('.chat-messages')
    // 等历史加载完成并定位到最新消息后，再滚到顶部；否则加载收尾会把滚动位置重新定位到底部。
    await expect(chatWindow.locator('.msg-virtual-row[data-index="80"] .msg-bubble')).toBeVisible()
    await scrollContainer.evaluate(element => { element.scrollTop = 0 })
    const firstRow = chatWindow.locator('.msg-virtual-row[data-index="0"]')
    await expect(firstRow).toBeVisible()
    await expect(firstRow.locator('.msg-bubble')).toContainText('可选消息-0')
    await page.evaluate(() => {
      const firstBubble = document.querySelector('.msg-virtual-row[data-index="0"] .msg-bubble')
      firstBubble?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }))
    })
    // 给 Vue 一帧应用锚点行固定，再开始滚动。真实指针事件会在浏览器任务间让出渲染；
    // 把 pointerdown 和 scroll 塞进同一个 evaluate 会跳过该时序，造成非真实的竞态。
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await page.evaluate(async () => {
      const container = document.querySelector('.chat-messages')
      if (!container) return
      // 首屏只测量了虚拟窗口内的行；逐帧跟随更新后的总高度滚到底，确保末行已挂载。
      for (let attempt = 0; attempt < 8; attempt += 1) {
        container.scrollTop = container.scrollHeight
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      }
    })
    // 周期消息中间插入一条工具事件，所以末条消息的展示行索引为 80。
    await expect(chatWindow.locator('.msg-virtual-row[data-index="80"] .msg-bubble')).toBeVisible()
    await expect(firstRow).toBeAttached()
    const selectionState = await page.evaluate(() => {
      const textNode = (element: Element): Text | null => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node && !node.textContent?.trim()) node = walker.nextNode()
        return node as Text | null
      }
      const first = document.querySelector('.msg-virtual-row[data-index="0"] .msg-bubble')
      const last = document.querySelector('.msg-virtual-row[data-index="80"] .msg-bubble')
      const firstText = first && textNode(first)
      const lastText = last && textNode(last)
      if (!firstText || !lastText) return ''
      document.getSelection()?.setBaseAndExtent(firstText, 0, lastText, lastText.length)
      return document.getSelection()?.toString() || ''
    })
    const selectedText = selectionState
    expect(selectedText).toContain('可选消息-0')
    expect(selectedText).toContain('可选消息-79')
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true })))

    await page.evaluate(() => {
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await scrollContainer.evaluate(element => {
      element.scrollTop = 0
    })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await scrollContainer.evaluate(element => {
      element.scrollTop = element.scrollHeight
    })
    await expect(firstRow).toHaveCount(0)

    await scrollContainer.evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    const toolHead = chatWindow.locator('.msg-virtual-row.is-tool-row .tool-event-head')
    await expect(toolHead).toBeVisible()
    await toolHead.click()
    await expect(toolHead).toHaveAttribute('aria-expanded', 'true')

    await scrollContainer.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(chatWindow.locator('.msg-virtual-row.is-tool-row')).toHaveCount(0)
    await scrollContainer.evaluate(element => { element.scrollTop = element.scrollHeight / 2 })
    await expect(chatWindow.locator('.msg-virtual-row.is-tool-row .tool-event-head')).toHaveAttribute('aria-expanded', 'true')
  })
})
