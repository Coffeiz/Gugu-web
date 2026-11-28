// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { respondToHttpInteraction, type ChatInteractionAnswer } from '@/components/common/gugu-chat/chatInteractionAccess'

const identity = { sessionId: 42, promptId: 17, runId: '旧运行' }
const selection = { ...identity, action: 'select', token: '合成选项', resume: true } as const
afterEach(() => vi.unstubAllGlobals())

it.each([
  [selection, 'resume', { token: '合成选项' }],
  [{ ...selection, resume: false }, 'respond', { token: '合成选项' }],
  [{ ...identity, action: 'text', text: '示例回复' }, 'resume-text', { text: '示例回复' }],
  [{ ...identity, action: 'secrets', secrets: { example: '合成值' } }, 'secrets', { values: { example: '合成值' } }],
  [{ ...identity, action: 'secrets', secrets: null }, 'secrets/cancel', undefined],
] satisfies Array<[ChatInteractionAnswer, string, object | undefined]>)('通过现有 Web 路由提交交互 %#', async (answer, route, payload) => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ run_id: '续接运行' })))
  vi.stubGlobal('fetch', request)

  const result = await respondToHttpInteraction(answer)

  expect(request).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`/agent/interactions/17/${route}$`)),
    expect.objectContaining({ credentials: 'include', method: 'POST' }))
  expect(request.mock.calls[0]?.[1].body).toBe(payload === undefined ? undefined : JSON.stringify(payload))
  expect(result).toEqual(route === 'resume' ? { status: 'accepted', runId: '续接运行' } : { status: 'accepted' })
})

it('过期的确认令牌返回拒绝状态和服务端提示', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: '交互已过期' }), { status: 409 })))

  await expect(respondToHttpInteraction(selection)).resolves.toEqual({ status: 'expired', detail: '交互已过期' })
})
