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
 */

test.describe('GuguChat 悬浮窗', () => {
  test('发消息收到回复，刷新页面后会话内容还在', async ({ page }) => {
    await page.goto('/')

    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator('.msg.ai .msg-bubble').count()
    const text = `e2e-chat-${Date.now()}`
    await chatWindow.locator('.chat-input-row textarea').fill(text)
    await chatWindow.locator('.send-btn').click()

    await expect(chatWindow.locator('.msg.user .msg-bubble', { hasText: text })).toBeVisible()
    await expect(chatWindow.locator('.msg.ai .msg-bubble')).toHaveCount(aiBubblesBefore + 1, { timeout: 15000 })
    await expect(chatWindow.locator('.msg.ai .msg-bubble').last()).not.toBeEmpty()

    // 会话 id 存在 sessionStorage，刷新同一标签页应该接续，不是新对话。
    await page.reload()
    await expect(page.locator('.ai-fab')).toBeVisible()
    await page.locator('.ai-fab').click()
    await expect(page.locator('.chat-window .msg.user .msg-bubble', { hasText: text })).toBeVisible()
  })

  test('展开大窗后会话列表显示当前会话，新建会话清空消息区', async ({ page }) => {
    await page.goto('/')
    await page.locator('.ai-fab').click()
    const chatWindow = page.locator('.chat-window')
    await expect(chatWindow).toBeVisible()

    const aiBubblesBefore = await chatWindow.locator('.msg.ai .msg-bubble').count()
    const text = `e2e-chat-expand-${Date.now()}`
    await chatWindow.locator('.chat-input-row textarea').fill(text)
    await chatWindow.locator('.send-btn').click()
    await expect(chatWindow.locator('.msg.ai .msg-bubble')).toHaveCount(aiBubblesBefore + 1, { timeout: 15000 })

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
})
