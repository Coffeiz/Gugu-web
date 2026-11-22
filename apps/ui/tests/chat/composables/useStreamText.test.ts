import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import { createMarkdownStreamMotion } from '@/components/common/content/markdownStreamMotion'
import { useStreamText } from '@/components/common/gugu-chat/composables/useStreamText'

const scopes: ReturnType<typeof effectScope>[] = []
function mount() {
  const message = reactive({ key: '会话一:回复一', text: '', streaming: true, hasFollowingMessage: false })
  const scope = effectScope()
  scopes.push(scope)
  const view = scope.run(() => useStreamText(() => ({ ...message })))!
  return { message, ...view, scope }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
})

describe('流式正文展示', () => {
  it('立即显示首个完整字素，把大批增量分段释放', async () => {
    const { message, displayed } = mount()
    message.text = '👩‍💻' + '批量文本'.repeat(60)
    await nextTick()
    expect(displayed.value).toBe('👩‍💻')
    vi.advanceTimersByTime(24)
    expect(displayed.value).toBe('👩‍💻')
    vi.advanceTimersByTime(1)
    expect(displayed.value).toBe('👩‍💻' + message.text.slice('👩‍💻'.length, '👩‍💻'.length + 20))
    vi.advanceTimersByTime(2000)
    expect(displayed.value).toBe(message.text)
  })

  it('大批增量时按原文顺序加速追赶', async () => {
    const { message, displayed } = mount()
    message.text = '甲'.repeat(20)
    await nextTick()
    for (let tick = 0; tick < 40; tick++) {
      if (tick % 3 === 0) {
        message.text += '乙丙丁'.repeat(100)
        await nextTick()
      }
      const before = displayed.value
      vi.advanceTimersByTime(24)
      expect(displayed.value).toBe(before)
      vi.advanceTimersByTime(1)
      expect(displayed.value.startsWith(before)).toBe(true)
      expect(message.text.startsWith(displayed.value)).toBe(true)
      expect(displayed.value.length).toBeGreaterThan(before.length)
    }
    expect(displayed.value.length).toBeGreaterThan(201)
  })

  it('队列排空后等待新文字，新批次仍按固定间隔显示', async () => {
    const { message, displayed } = mount()
    message.text = '少量文字'
    await nextTick()
    vi.advanceTimersByTime(25)
    expect(displayed.value).toBe('少量文字')
    vi.advanceTimersByTime(1000)
    message.text += '长回复'.repeat(100)
    await nextTick()
    vi.advanceTimersByTime(24)
    expect(displayed.value).toBe('少量文字')
    vi.advanceTimersByTime(1)
    expect(displayed.value).toBe(message.text.slice(0, '少量文字'.length + 25))
  })

  it('跳过智能界面数据的逐字播放，闭合后继续逐字显示正文', async () => {
    const { message, displayed } = mount()
    const pending = '摘要\n\n```gugu-ui\n{"payload":"' + '示例'.repeat(1500)
    message.text = pending
    await nextTick()
    vi.advanceTimersByTime(25)
    expect(displayed.value).toBe(pending)
    const closed = pending + '"}\n```'
    message.text = closed + '\n\n后续正文'
    await nextTick()
    vi.advanceTimersByTime(25)
    expect(displayed.value).toBe(closed)
    vi.advanceTimersByTime(25)
    expect(displayed.value).toBe(closed + '\n\n后续正')
  })

  it('结束后继续分批播放并快速显示全文，后续工具卡出现时同步结算前文', async () => {
    const { message, displayed, presenting } = mount()
    message.text = '快照'.repeat(300)
    await nextTick()
    message.streaming = false
    await nextTick()
    expect(presenting.value).toBe(true)
    vi.advanceTimersByTime(25)
    expect(displayed.value.length).toBeGreaterThan(1)
    expect(displayed.value).not.toBe(message.text)
    vi.advanceTimersByTime(275)
    expect(displayed.value).toBe(message.text)
    vi.advanceTimersByTime(150)
    expect(presenting.value).toBe(false)

    message.streaming = true
    message.text += '下一段'.repeat(40)
    await nextTick()
    expect(displayed.value).not.toBe(message.text)
    message.hasFollowingMessage = true
    await nextTick()
    expect(displayed.value).toBe(message.text)
  })

  it('前一批仍在淡入时，在其末尾独立启动下一批', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    try {
      const root = document.createElement('div')
      const animate = createMarkdownStreamMotion()
      root.innerHTML = '<p>第一批</p>'
      animate(root, true)
      now.mockReturnValue(125)
      root.innerHTML = '<p>第一批<strong>第二批</strong></p>'
      animate(root, true)
      expect([...root.querySelectorAll('span')].map(node => node.textContent)).toEqual(['第一批', '第二批'])
    } finally {
      now.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('服务端文本更正、切换会话和销毁时取消旧缓冲', async () => {
    const { message, displayed, scope } = mount()
    message.text = '旧正文'.repeat(80)
    await nextTick()
    message.text = '更正正文'
    await nextTick()
    expect(displayed.value).toBe('更正正文')
    message.text += '后续内容'.repeat(30)
    await nextTick()
    message.key = '会话二:回复一'
    message.text = '新的会话'
    await nextTick()
    vi.advanceTimersByTime(500)
    expect(displayed.value).toBe('新的会话')
    message.text += '新段落'.repeat(30)
    await nextTick()
    scope.stop()
    vi.advanceTimersByTime(500)
    expect(displayed.value).toBe('新的会话')
  })
})
