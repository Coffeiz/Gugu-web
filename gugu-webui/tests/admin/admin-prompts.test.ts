import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminPromptRoutes } from '../../src/domains/admin/admin-prompts.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-prompts-')), audits: Array<Record<string, unknown>> = [], app = Fastify()
  registerAdminPromptRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    root,
    audit: (record) => { audits.push(record) },
  })
  return { app, root, audits, cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}

test('压缩提示词读取与列表映射到运行时消费的 memory_compress.md', async () => {
  const { app, root, cleanup } = await setup()
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'memory_compress.md'), '合成压缩提示词', 'utf8')
    const read = await app.inject({ url: '/api/v1/admin/agent/prompts/compress', headers: { authorization: 'admin' } })
    assert.deepEqual(read.json(), { profile: 'compress', content: '合成压缩提示词' })
    const list = await app.inject({ url: '/api/v1/admin/agent/prompts', headers: { authorization: 'admin' } })
    assert.deepEqual(list.json().profiles.find((item: { profile: string }) => item.profile === 'compress'), {
      profile: 'compress', exists: true, size: Buffer.byteLength('合成压缩提示词'), is_persona: true,
    })
    await assert.rejects(readFile(join(root, 'compress.md'), 'utf8'))
  } finally { await cleanup() }
})

test('更新压缩提示词写入消费文件并审计profile，不将提示词正文写入审计', async () => {
  const { app, root, audits, cleanup } = await setup()
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/prompts/compress', headers: { authorization: 'admin' }, payload: { content: 'secret synthetic prompt body' } })
    assert.deepEqual(response.json(), { profile: 'compress', saved: true })
    assert.equal(await readFile(join(root, 'memory_compress.md'), 'utf8'), 'secret synthetic prompt body')
    assert.deepEqual(audits, [{ category: 'prompt', action: 'update', profile: 'compress' }])
    assert.equal(JSON.stringify(audits).includes('secret synthetic prompt body'), false)
  } finally { await cleanup() }
})

test('未知profile和未授权访问被拒绝且不会创建任意文件', async () => {
  const { app, root, cleanup } = await setup()
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/prompts/nope', headers: { authorization: 'admin' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/prompts/policy', payload: { content: 'blocked' } })).statusCode, 401)
    assert.deepEqual(await (await import('node:fs/promises')).readdir(root), [])
  } finally { await cleanup() }
})
