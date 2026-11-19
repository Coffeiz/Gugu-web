import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createWebAgentPromptReader, readWebAgentImPrompt } from '../../src/modules/agent-sessions/context/agent-prompt-files.js'

test('Node Agent 默认加载 Host 随包发布的完整对话提示词', () => {
  const prompts = createWebAgentPromptReader()()
  assert.deepEqual(Object.keys(prompts), ['base', 'persona', 'skills', 'policy', 'retrieval'])
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
