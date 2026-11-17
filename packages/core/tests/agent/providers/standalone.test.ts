import { describe, expect, it } from 'vitest'
import { completeStandaloneText } from '../../../src/agent/providers/standalone.js'
import { fakeDependencies, fakeResponse, requestJsonBody } from './fixtures.js'

describe('Provider standalone completion', () => {
  it('uses the selected protocol and returns sanitized completion text', async () => {
    const { dependencies, requests } = fakeDependencies([fakeResponse({
      choices: [{ message: { content: '<think>private reasoning</think> 译文 JSON ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    })])

    const result = await completeStandaloneText({
      config: { provider: 'openai', model: 'synthetic-model', api_key: 'synthetic-key', base_url: 'https://provider.example/v1' },
      prompt: '仅作合成调用', maxTokens: 5000, signal: new AbortController().signal,
      identity: { ownerId: 'admin', sessionId: 'email-translation', runId: 'translation-1' },
    }, dependencies)

    expect(result).toBe('译文 JSON')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://provider.example/v1/chat/completions')
    const message = (requestJsonBody(requests[0]!).messages as Array<{ role: string; content: unknown }>)[0]!
    expect(message.role).toBe('user')
    expect(JSON.stringify(message.content)).toContain('仅作合成调用')
    expect(requestJsonBody(requests[0]!).max_tokens).toBe(5000)
  })
})
