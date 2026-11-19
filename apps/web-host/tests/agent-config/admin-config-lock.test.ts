import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminConfigRoutes } from '../../src/modules/admin/config.js'
import { createPosixConfigFileLock } from '../../src/adapters/config/posix-config-lock.js'
import { updateConfigOverride } from '../../src/adapters/config/config-override-file.js'
const unsupported = !['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 26

test('Admin 更新等待另一 Node 进程，读取最新文件并保留并发模型配置', { skip: unsupported && '需要 Node 26 和 POSIX 平台', timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-config-test-')), path = join(dir, 'config.json'), lockPath = join(dir, '.config.json.lock')
  let child: ReturnType<typeof spawn> | undefined
  const app = Fastify()
  try {
    await writeFile(path, JSON.stringify({ ai: { model: 'original', api_key: 'synthetic-secret' }, db: { password: 'synthetic-db', host: 'old' } }))
    registerAdminConfigRoutes(app, { path, env: {}, requireAdmin: async () => {} })
    const lockModule = new URL('../../src/adapters/config/posix-config-lock.ts', import.meta.url).href
    const script = `
      import { once } from 'node:events'
      import { readFile, rename, writeFile } from 'node:fs/promises'
      const [modulePath, lockPath, path] = process.argv.slice(1)
      const { createPosixConfigFileLock } = await import(modulePath)
      await createPosixConfigFileLock().withExclusive(lockPath, async () => {
        process.stdout.write('ready')
        await once(process.stdin, 'data')
        const document = JSON.parse(await readFile(path, 'utf8'))
        document.ai.model = 'updated'
        await writeFile(path + '.tmp', JSON.stringify(document))
        await rename(path + '.tmp', path)
      })
    `
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, lockModule, lockPath, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('持锁 Node 进程提前退出') })])
    let settled = false
    const pending = Promise.resolve(app.inject({ method: 'PATCH', url: '/api/v1/admin/config', payload: { patch: { db: { host: 'new', password: '****' } } } })).finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(settled, false)
    child.stdin!.end('\n')
    assert.deepEqual(await exited, [0, null])
    child = undefined
    assert.equal((await pending).statusCode, 200)
    const result = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(result.ai, { model: 'updated', api_key: 'synthetic-secret' })
    assert.deepEqual(result.db, { host: 'new', password: 'synthetic-db' })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('锁不可用、损坏或缺失配置均拒绝写入', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-config-test-')), path = join(dir, 'config.json')
  try {
    await assert.rejects(updateConfigOverride(path, { db: {} }, createPosixConfigFileLock()))
    await assert.rejects(access(path))
    await writeFile(path, '{ invalid')
    await assert.rejects(updateConfigOverride(path, { db: {} }, createPosixConfigFileLock()))
    assert.equal(await readFile(path, 'utf8'), '{ invalid')
    await assert.rejects(updateConfigOverride(path, { db: {} }, null as never), /锁不可用/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
