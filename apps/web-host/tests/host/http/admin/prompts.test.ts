import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'
import { readAgentPrompt } from '@gugu/core/agent/context/prompts'
import { createWebAgentPromptReader, migrateWebAgentPrompts, readWebAgentImPrompt } from '../../../../src/modules/agent/context/prompts.js'

test('Web Host 默认加载 Core 的完整对话提示词', () => {
  const prompts = createWebAgentPromptReader()()
  assert.deepEqual(Object.keys(prompts), ['base', 'persona', 'skills', 'policy'])
  for (const prompt of Object.values(prompts)) assert.ok(prompt.trim().length > 0)
})

test('Node IM 维护入口可读取随包发布的三种提示词', async () => {
  const prompts = await Promise.all([
    readWebAgentImPrompt('group_compress'),
    readWebAgentImPrompt('group_reflection'),
    readWebAgentImPrompt('member_reflection'),
  ])
  assert.equal(new Set(prompts).size, 3)
  for (const prompt of prompts) assert.ok(prompt.trim().length > 0)
})

test('升级只导入有改动的旧模板，新覆盖优先且重复导入安全', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'gugu-prompts-migration-'))
  const source = join(parent, 'legacy'), overrides = join(parent, 'overrides')
  try {
    await mkdir(join(source, 'im'), { recursive: true })
    await mkdir(overrides)
    await writeFile(join(source, 'default.md'), readAgentPrompt('default.md'))
    await writeFile(join(source, 'persona.md'), '旧人格配置')
    await writeFile(join(source, 'policy.md'), '旧规则')
    await writeFile(join(source, 'retrieval.md'), '旧检索覆盖')
    await writeFile(join(source, 'im', 'group_compress.md'), '旧群聊压缩')
    await writeFile(join(overrides, 'policy.md'), '已保存规则')
    await migrateWebAgentPrompts(overrides, source)
    await migrateWebAgentPrompts(overrides, source)
    assert.equal(await readFile(join(overrides, 'default.md'), 'utf8').catch(() => null), null)
    await assert.rejects(readFile(join(overrides, 'retrieval.md'), 'utf8'), { code: 'ENOENT' })
    assert.equal(await readFile(join(source, 'retrieval.md'), 'utf8'), '旧检索覆盖')
    assert.equal(createWebAgentPromptReader(overrides)().base, readAgentPrompt('default.md'))
    assert.equal(createWebAgentPromptReader(overrides)().persona, '旧人格配置')
    assert.equal(createWebAgentPromptReader(overrides)().policy, '已保存规则')
    assert.equal(await readWebAgentImPrompt('group_compress', overrides), '旧群聊压缩')
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('生产 Host 为管理员提示词列表和正文提供受保护的文件入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-prompts-host-'))
  const audit: unknown[] = []
  await writeFile(join(root, 'memory_compress.md'), '合成压缩提示词', 'utf8')
  await writeFile(join(root, 'default.md'), '旧基础提示词', 'utf8')
  const readRuntimePrompts = createWebAgentPromptReader(root)
  const app = createApp({
    appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminPrompts: {
      root,
      adminUsername: () => 'synthetic-admin',
      async writeAuditLog(_username, action, description) { audit.push({ action, description }) },
    },
  } as unknown as Parameters<typeof createApp>[0])
  try {
    const denied = await app.inject({ url: '/api/v1/admin/agent/prompts' })
    assert.equal(denied.statusCode, 401)
    const list = await app.inject({ url: '/api/v1/admin/agent/prompts', headers: { authorization: 'test-admin' } })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().profiles.find((item: { profile: string }) => item.profile === 'compress'), {
      profile: 'compress', exists: true, size: Buffer.byteLength('合成压缩提示词'), is_persona: true,
    })
    const fallback = await app.inject({ url: '/api/v1/admin/agent/prompts/persona', headers: { authorization: 'test-admin' } })
    assert.deepEqual(fallback.json(), { profile: 'persona', content: readAgentPrompt('persona.md') })
    const read = await app.inject({ url: '/api/v1/admin/agent/prompts/compress', headers: { authorization: 'test-admin' } })
    assert.deepEqual(read.json(), { profile: 'compress', content: '合成压缩提示词' })
    assert.equal(readRuntimePrompts().base, '旧基础提示词')
    assert.equal(await readFile(join(root, 'compress.md'), 'utf8').catch(() => null), null)
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/prompts/nope', headers: { authorization: 'test-admin' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/prompts/policy', headers: { authorization: 'test-admin' }, payload: { content: 4 } })).statusCode, 422)
    const write = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/prompts/compress', headers: { authorization: 'test-admin' }, payload: { content: '新合成提示词' } })
    assert.deepEqual(write.json(), { profile: 'compress', saved: true })
    assert.equal(await readFile(join(root, 'memory_compress.md'), 'utf8'), '新合成提示词')
    const updatedDefault = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/prompts/default', headers: { authorization: 'test-admin' }, payload: { content: '新基础提示词' } })
    assert.deepEqual(updatedDefault.json(), { profile: 'default', saved: true })
    assert.equal(readRuntimePrompts().base, '新基础提示词')
    assert.deepEqual(audit, [
      { action: 'prompt', description: '更新 Agent 提示词：compress' },
      { action: 'prompt', description: '更新 Agent 提示词：default' },
    ])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
