import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createToolRegistry } from '@gugu/core/tools'
import { createToolResultCheckpoint, stableJson, type ContextReferenceCodec } from '@gugu/core/agent'
import { renderOpenaiHistory } from '../../../../../../packages/core/src/agent/providers/openai/history.js'
import { createViewImageTool, withViewImageReferences } from '../../../../src/modules/agent/tools/files/image.js'

const identity = { ownerId: 'synthetic-owner', sessionId: '1', runId: 'synthetic-run' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvt0AAAAASUVORK5CYII=', 'base64')
// 两帧依次为红色、蓝色，检查原始动画字节完整通过工具链路。
const gif = Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAMgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBMgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7', 'base64')
const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
  async execute(): Promise<never> { throw new Error('查看图片不执行命令') } }
const base: ContextReferenceCodec = { async hydrate(entry) { return entry.message }, async dehydrate(entry) { return entry.message } }

for (const [extension, mime, bytes, size] of [['png', 'image/png', png, 1], ['gif', 'image/gif', gif, 2]] as const) {
  test(`view_image 将原始 ${extension} 送给 Provider，检查点只保存 Run 引用`, async () => {
    const tool = createViewImageTool({
      authorize: async () => true, supportsImage: async () => true, mount: async () => null,
      async open() { return { status: 200, headers: {}, body: (async function* () { yield bytes })(), cancel() {} } },
    })
    const registry = createToolRegistry({ tools: [tool], authorize: async () => true })
    const call = { id: 'image', name: 'view_image', input: { url: `https://example.test/image.${extension}` } }
    const result = await registry.tools.dispatch(call, scope)
    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    assert.deepEqual(result.value, { mime, width: size, height: size })
    const codec = withViewImageReferences(base)
    const checkpoint = createToolResultCheckpoint(codec, { digest: value => createHash('sha256').update(stableJson(value)).digest('hex') })
    const coordinate = { identity, round: 1, call }
    const stored = await checkpoint.checkpointToolResult(coordinate, result)
    assert.doesNotMatch(stableJson(stored), /image_url|example\.test/u)
    assert.ok(!stableJson(stored).includes(bytes.toString('base64')))
    const restored = await checkpoint.restoreToolResult(coordinate, stored)
    assert.equal(restored.kind, 'completed')
    if (restored.kind !== 'completed') return
    const body = renderOpenaiHistory([{ role: 'user', content: [{
      type: 'tool_result', tool_call_id: call.id, content: restored.modelValue as import('@gugu/core/agent').Json,
    }] }])
    assert.ok(stableJson(body).includes(`data:${mime};base64,${bytes.toString('base64')}`))
    const entry = { message: { role: 'user', content: result.modelValue }, source: 'tool_round' } as Parameters<ContextReferenceCodec['hydrate']>[0]
    const foreign = await codec.hydrate(entry, { ...identity, runId: 'another-run' })
    assert.match(stableJson(foreign), /图片已过期/u)
  })
}

test('view_image 从已固定的会话挂载读取，拒绝符号链接及范围外路径', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-view-image-'))
  try {
    await writeFile(join(root, 'image.gif'), gif)
    await symlink(join(root, 'image.gif'), join(root, 'link.png'))
    const registry = createToolRegistry({ authorize: async () => true, tools: [createViewImageTool({
      authorize: async () => true, supportsImage: async () => true,
      async mount() {
        const anchor = await open(root, 'r')
        return { sandboxCwd: '/workspace', sandboxMounts: [
          { target: '/workspace', source: root, descriptor: anchor.fd, readonly: true },
        ], close: () => anchor.close() }
      },
      async open() { throw new Error('路径查看不请求网络') },
    })] })
    const call = (path: string) => registry.tools.dispatch({ id: 'image', name: 'view_image', input: { path } }, scope)
    const valid = await call('/workspace/image.gif')
    assert.equal(valid.kind === 'completed' && valid.successful, true)
    if (valid.kind === 'completed') {
      assert.deepEqual(valid.value, { mime: 'image/gif', width: 2, height: 2 })
      const entry = { message: { role: 'user', content: valid.modelValue }, source: 'tool_round' } as Parameters<ContextReferenceCodec['hydrate']>[0]
      const restored = await withViewImageReferences(base).hydrate(entry, identity)
      assert.ok(stableJson(restored).includes(gif.toString('base64')))
    }
    for (const path of ['/workspace/link.png', '/workspace/../image.png', '/unmounted/image.png']) {
      const rejected = await call(path)
      assert.equal(rejected.kind === 'completed' && !rejected.successful, true)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('view_image 对无视觉模型、混用输入和重定向分别拒绝', async () => {
  let supports = false
  let requests = 0
  const registry = createToolRegistry({ authorize: async () => true, tools: [createViewImageTool({
    authorize: async () => true, supportsImage: async () => supports, mount: async () => null,
    async open() {
      requests++
      return { status: 302, headers: { location: 'https://example.test/next' }, body: (async function* () { yield png })(), cancel() {} }
    },
  })] })
  const call = { id: 'image', name: 'view_image', input: { url: 'https://example.test/image.png' } }
  const unsupported = await registry.tools.dispatch(call, scope)
  assert.match(stableJson(unsupported), /当前模型不支持图片输入/u)
  supports = true
  const invalid = await registry.tools.dispatch({ ...call, input: { ...call.input, path: '/workspace/image.png' } }, scope)
  assert.equal(invalid.kind === 'completed' && !invalid.successful, true)
  assert.equal(requests, 0)
  const redirected = await registry.tools.dispatch(call, scope)
  assert.equal(redirected.kind === 'completed' && !redirected.successful, true)
  assert.equal(requests, 1)
})
