import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createImRuntimeSettings } from '../../../src/modules/im/gateway/host-settings.js'

test('运行记忆开关每次读取真实配置，override覆盖环境，读操作不重写配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-settings-')), path = join(root, 'config.json')
  try {
    const settings = createImRuntimeSettings(path, { AGENT__MEMORY_ENABLED: 'false', QUOTA__DEFAULT_TOKEN_LIMIT_6H: '1200' })
    await writeFile(path, JSON.stringify({ agent: { memory_enabled: true }, quota: { default_token_limit_6h: 2400 }, synthetic: { keep: true } }))
    const before = await readFile(path, 'utf8')
    assert.equal(settings.memoryEnabled(), true); assert.equal(settings.defaultLimit6h(), 1200)
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({ agent: { memory_enabled: false } })); assert.equal(settings.memoryEnabled(), false)
    await writeFile(path, '{}'); assert.equal(settings.memoryEnabled(), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('坏JSON与无效开关/配额不伪装默认值，固定错误不包含原始配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-settings-')), path = join(root, 'config.json')
  try {
    for (const value of ['{"synthetic-private":', '{"agent":{"memory_enabled":"synthetic-private"}}']) {
      await writeFile(path, value)
      assert.throws(() => createImRuntimeSettings(path, {}).memoryEnabled(), error => {
        assert.ok(error instanceof Error); assert.equal(error.message, 'IM 记忆配置不可用'); assert.equal(error.cause, undefined); return true
      })
    }
    await writeFile(path, '{"quota":{"default_token_limit_6h":"synthetic-private"}}')
    assert.throws(() => createImRuntimeSettings(path, {}).defaultLimit6h(), { message: 'IM 模型配额配置不可用' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
