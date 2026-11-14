import { createHash } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import type { CanonicalMessage,ContextReferenceCodec,Json,MessageEntry,ToolResult,ToolResultCheckpointScope } from "../../../../src/agent/harness/index.js"
import { assertDurableCanonical,createToolResultCheckpoint,stableJson } from "../../../../src/agent/harness/index.js"
const scope: ToolResultCheckpointScope = {
  identity: { ownerId: 'owner', sessionId: 'session', runId: 'run' }, round: 1,
  call: { id: 'call', name: 'inspect', input: { file: 'synthetic' }, rawArguments: '{"file":"synthetic"}' }
}
const services = { digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex') }
const passthrough: ContextReferenceCodec = { dehydrate: async entry => entry.message, hydrate: async entry => entry.message }
const completed = (value: unknown): Extract<ToolResult, { kind: 'completed' }> => ({ kind: 'completed', value, successful: true, mutated: false, executed: false })
function replacePayload(message: CanonicalMessage, payload: Json): CanonicalMessage {
  const block = (message.content as Json[])[0] as Record<string, Json>
  return { ...message, content: [{ ...block, content: payload }] }
}
function payload(message: CanonicalMessage): Record<string, Json> {
  return ((message.content as Json[])[0] as Record<string, Json>).content as Record<string, Json>
}

describe('工具回执授权引用checkpoint', () => {
  it('当前媒体保留给Provider，持久只存稳定引用，恢复保留制品与全部控制事实', async () => {
    const original: Extract<ToolResult, { kind: 'completed' }> = {
      ...completed({ type: 'image', source: { type: 'base64', data: 'synthetic-media' } }),
      kind: 'completed', successful: false, mutated: true, executed: false,
      artifact: 'https://example.invalid/image?signature=synthetic', canonicalEvents: [{ type: 'tool-schema', schema: { properties: { signature: { type: 'string' } } } }]
    }
    const originals = new Map<string, Json>()
    const codec: ContextReferenceCodec = {
      dehydrate: async (entry, identity) => {
        expect(identity).toEqual(scope.identity)
        const value = payload(entry.message)
        originals.set('value', value.value!); originals.set('artifact', value.artifact!)
        return replacePayload(entry.message, { value: { type: 'attachment_ref', attach_id: 'value' }, artifact: { type: 'attachment_ref', attach_id: 'artifact' } })
      },
      hydrate: async (entry, identity) => { expect(identity).toEqual(scope.identity); return replacePayload(entry.message, { value: originals.get('value')!, artifact: originals.get('artifact')! }) },
    }
    const port = createToolResultCheckpoint(codec, services), encoded = await port.checkpointToolResult(scope, original)
    expect(stableJson(encoded)).not.toContain('synthetic-media'); expect(stableJson(encoded)).not.toContain('example.invalid')
    expect(stableJson(original)).toContain('synthetic-media')
    expect(encoded).toMatchObject({ kind: 'completed', successful: false, mutated: true, executed: false, canonicalEvents: original.canonicalEvents })
    expect(await port.restoreToolResult(scope, encoded)).toEqual(original)
  })
  it.each([
    { type: 'image', source: { type: 'base64', data: 'synthetic' } },
    JSON.stringify({ image: { type: 'image', source: { type: 'base64', data: 'synthetic' } } }),
    JSON.stringify([{ type: 'thinking', signature: 'private' }]),
    { url: 'https://example.invalid/media?X-Amz-Signature=synthetic' },
    'https://example.invalid/media?signature=synthetic',
  ])('codec未固化真实媒体/私有材料时拒绝，不能strip后宣称完成%j', async value => {
    await expect(createToolResultCheckpoint(passthrough, services).checkpointToolResult(scope, completed(value))).rejects.toThrow()
  })
  it('已知JSON工具值必须先经真实引用端口固化，恢复仍给Provider完整原始JSON媒体', async () => {
    const original = JSON.stringify({ parts: [{ type: 'image', source: { type: 'base64', data: 'synthetic-json-media' } }] })
    const codec: ContextReferenceCodec = {
      dehydrate: async entry => {
        expect(payload(entry.message).value).toBe(original)
        return replacePayload(entry.message, { value: { type: 'attachment_ref', attach_id: 'json-media' } })
      }, hydrate: async entry => {
        expect(payload(entry.message).value).toEqual({ type: 'attachment_ref', attach_id: 'json-media' })
        return replacePayload(entry.message, { value: original })
      }
    }
    const port = createToolResultCheckpoint(codec, services), encoded = await port.checkpointToolResult(scope, completed(original))
    expect(stableJson(encoded)).not.toContain('base64'); expect((await port.restoreToolResult(scope, encoded))).toEqual(completed(original))
  })
  it('owner/session/run/round/call及原参数变化都在hydrate前拒绝', async () => {
    let hydrates = 0
    const port = createToolResultCheckpoint({ ...passthrough, hydrate: async entry => { hydrates++; return entry.message } }, services)
    const encoded = await port.checkpointToolResult(scope, completed({ text: '业务内容' }))
    const variants: ToolResultCheckpointScope[] = ['ownerId', 'sessionId', 'runId'].map(key => ({ ...scope, identity: { ...scope.identity, [key]: 'other' } }))
    variants.push({ ...scope, round: 2 }, { ...scope, call: { ...scope.call, id: 'other' } }, { ...scope, call: { ...scope.call, name: 'other' } }, { ...scope, call: { ...scope.call, input: { file: 'other' } } })
    for (const changed of variants) await expect(port.restoreToolResult(changed, encoded)).rejects.toThrow('匹配')
    if (encoded.kind !== 'completed') throw new Error('测试回执形状错误')
    await expect(port.restoreToolResult(scope, { ...encoded, mutated: true })).rejects.toThrow('控制字段')
    const capsule = encoded.value as Record<string, unknown>
    await expect(port.restoreToolResult(scope, { ...encoded, value: { ...capsule, payload: '被更改' } })).rejects.toThrow('指纹')
    expect(hydrates).toBe(0)
  })
  it.each(['role', 'toolId', 'scope', 'artifact'] as const)('codec不能篡改封套或删除制品：%s', async corruption => {
    const codec: ContextReferenceCodec = {
      ...passthrough, dehydrate: async entry => {
        const message = structuredClone(entry.message)
        if (corruption === 'role') message.role = 'assistant'
        if (corruption === 'scope') message._tool_result_checkpoint = {}
        if (corruption === 'toolId') ((message.content as Json[])[0] as Record<string, Json>).tool_call_id = 'other'
        if (corruption === 'artifact') return replacePayload(message, { value: '原值' })
        return message
      }
    }
    await expect(createToolResultCheckpoint(codec, services).checkpointToolResult(scope, { ...completed('原值'), kind: 'completed', successful: true, mutated: false, artifact: '制品' })).rejects.toThrow()
  })
  it('有限JSON和无访问器约束在调用codec之前生效', async () => {
    let calls = 0, getters = 0
    const port = createToolResultCheckpoint({ ...passthrough, dehydrate: async entry => { calls++; return entry.message } }, services)
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const getter = Object.defineProperty({}, 'text', { enumerable: true, get: () => { getters++; return '不应读取' } })
    for (const value of [NaN, Infinity, cycle, getter, () => 'function']) await expect(port.checkpointToolResult(scope, completed(value))).rejects.toThrow()
    expect(calls).toBe(0); expect(getters).toBe(0)
  })
  it('waiting控制事实深快照并精确绑定原调用，unknown不能夹带业务值', async () => {
    const port = createToolResultCheckpoint(passthrough, services)
    const waiting: ToolResult = { kind: 'waiting', interaction: { id: 'interaction', kind: 'confirmation', afterConfirmation: false, toolCall: scope.call } }
    const saved = await port.checkpointToolResult(scope, waiting)
    expect(saved).toEqual(waiting); expect(saved).not.toBe(waiting)
    expect(await port.restoreToolResult(scope, saved)).toEqual(waiting)
    await expect(port.checkpointToolResult(scope, { ...waiting, interaction: { ...waiting.interaction, toolCall: { ...scope.call, input: { file: 'other' } } } })).rejects.toThrow('原工具')
    expect(await port.checkpointToolResult(scope, { kind: 'unknown' })).toEqual({ kind: 'unknown' })
    await expect(port.checkpointToolResult(scope, { kind: 'unknown', value: '不允许' } as unknown as ToolResult)).rejects.toThrow()
  })
  it('异步固化或恢复期间取消不能成功提交或返回当前媒体', async () => {
    for (const phase of ['dehydrate', 'hydrate'] as const) {
      const controller = new AbortController()
      const codec: ContextReferenceCodec = { ...passthrough, [phase]: async (entry: MessageEntry) => { controller.abort(); return entry.message } }
      const port = createToolResultCheckpoint(codec, services)
      if (phase === 'dehydrate') await expect(port.checkpointToolResult(scope, completed('正文'), controller.signal)).rejects.toThrow()
      else {
        const encoded = await port.checkpointToolResult(scope, completed('正文'))
        await expect(port.restoreToolResult(scope, encoded, controller.signal)).rejects.toThrow()
      }
    }
  })
  it('只解析明确tool_result的一层JSON，普通read_file文本和用户JSON正文不被误判', () => {
    const media = JSON.stringify({ type: 'image', source: 'synthetic' })
    expect(() => assertDurableCanonical({ type: 'tool_result', content: media })).toThrow()
    expect(() => assertDurableCanonical({ type: 'tool_result', content: JSON.stringify({ content: media }) })).not.toThrow()
    expect(() => assertDurableCanonical({ role: 'user', content: media })).not.toThrow()
  })
})
