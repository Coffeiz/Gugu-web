import { test, expect } from '@playwright/test'

/**
 * CI 关键路径之三：GuguChat 悬浮窗——发消息收到回复、大窗会话列表、
 * 新建会话、收起/关闭。跟另外两条关键路径同一个原则：CI 里接
 * scripts/mock_llm_server.py 的固定回复，不接真实模型、不受限流/网络
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
 * 这几项仍按 docs/refactor/GuguChat组件拆分重构方案.md 第九节的验收清单
 * 人工过一遍。
 *
 * 选择器注意：不能直接用 `.msg.ai .msg-bubble` 断言"收到 AI 回复"——生成中的
 * 思考/工具状态气泡（GuguChatMessageList.vue 里 `v-if="statusKind"` 那个
 * `class="msg ai"` 元素）也匹配这个选择器，会导致断言在真正的回复到达之前
 * 就"假绿"通过。真实的历史消息渲染在虚拟列表的 `.msg-virtual-row` 里，状态
 * 气泡是虚拟列表外的兄弟节点，用 AI_REPLY 这个更窄的选择器排除掉它。
 */

const AI_REPLY = '.msg-virtual-row .msg.ai .msg-bubble'

test.describe('GuguChat 悬浮窗', () => {
  test('发消息收到回复，刷新页面后会话内容还在', async ({ page }) => {
    await page.goto('/')

    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator(AI_REPLY).count()
    const text = `e2e-chat-${Date.now()}`
    await chatWindow.locator('.chat-input-row textarea').fill(text)
    await chatWindow.locator('.send-btn').click()

    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: text })).toBeVisible()
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(aiBubblesBefore + 1, { timeout: 15000 })
    await expect(chatWindow.locator(AI_REPLY).last()).not.toBeEmpty()

    // 会话 id 存在 sessionStorage，刷新同一标签页应该接续，不是新对话——
    // 用户消息和 AI 回复都要落库持久化，不能只验证用户那一半。
    await page.reload()
    await expect(page.locator('.ai-fab')).toBeVisible()
    await page.locator('.ai-fab').click()
    await expect(page.locator('.chat-window .msg.user .msg-bubble', { hasText: text })).toBeVisible()
    await expect(page.locator('.chat-window').locator(AI_REPLY).last()).not.toBeEmpty()
  })

  test('展开大窗后会话列表显示当前会话，新建会话清空消息区', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator(AI_REPLY).count()
    const text = `e2e-chat-expand-${Date.now()}`
    await chatWindow.locator('.chat-input-row textarea').fill(text)
    await chatWindow.locator('.send-btn').click()
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(aiBubblesBefore + 1, { timeout: 15000 })

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

    const textarea = chatWindow.locator('.chat-input-row textarea')
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
    await textarea.press('Enter')
    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: queuedText })).toBeVisible()

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
    await expect(chatWindow.locator(AI_REPLY)).toHaveCount(1, { timeout: 15000 })

    // 等一小段时间，确认没有排队消息延迟冒出来（真出问题时会多一条 user 气泡）。
    await page.waitForTimeout(1500)
    await expect(chatWindow.locator('.msg.user .msg-bubble')).toHaveCount(1)
    await expect(chatWindow.locator('.msg.user .msg-bubble').first()).toHaveText(newSessionText)
    await expect(chatWindow.locator('.msg', { hasText: queuedText })).toHaveCount(0)
  })
})
