import { expect, it, vi } from 'vitest'
import { createDesktopGreetingAccess } from '@desktop/shell/greeting-access'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/i18n', () => ({ getLocale: () => 'zh-CN' }))
vi.mock('@/utils/greetingText', () => ({ pickGreetingFallback: () => '通用问候' }))
vi.mock('@desktop/shell/agent-session-transport', () => ({ requestDesktopAgentSessions: request }))

it('合并同时打开的问候请求，优先展示生成文案', async () => {
  request.mockReset().mockResolvedValue({ text: '今天的咖啡喝得开心吗？' })
  const greeting = createDesktopGreetingAccess()
  await Promise.all([greeting.prefetch(), greeting.prefetch()])
  await greeting.prefetch()
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: 'greeting', locale: 'zh-CN' })
  expect(greeting.read()).toBe('今天的咖啡喝得开心吗？')
})

it('模型请求失败时显示通用问候，下一次打开还能重新生成', async () => {
  request.mockReset().mockRejectedValueOnce(new Error('合成模型故障'))
    .mockResolvedValueOnce({ text: '周末在店里坐得舒服吗？' })
  const greeting = createDesktopGreetingAccess()
  await greeting.prefetch()
  expect(greeting.read()).toBe('通用问候')
  await greeting.prefetch()
  expect(greeting.read()).toBe('周末在店里坐得舒服吗？')
})
