import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminConfigRoutes } from '../../src/domains/admin/admin-config.js'
import { createPosixConfigFileLock } from '../../src/domains/agent-config/posix-config-lock.js'
import { updateConfigOverride } from '../../src/adapters/config-override-file.js'
const unsupported = !['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 26

test('Admin 更新等待 Python flock，读取最新文件并保留并发模型配置', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-config-test-')), path = join(dir, 'config.json'), lockPath = join(dir, '.config.json.lock')
  let child: ReturnType<typeof spawn> | undefined
  const app = Fastify()
  try {
    await writeFile(path, JSON.stringify({ ai: { model: 'original', api_key: 'synthetic-secret' }, db: { password: 'synthetic-db', host: 'old' } }))
    registerAdminConfigRoutes(app, { path, env: {}, requireAdmin: async () => {} })
    const script = "import fcntl,os,sys,json; lock=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(lock,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.readline(); p=sys.argv[2]; d=json.load(open(p)); d['ai']['model']='updated'; t=p+'.temp'; open(t,'w').write(json.dumps(d)); os.replace(t,p); fcntl.flock(lock,fcntl.LOCK_UN)"
    child = spawn('python3', ['-u', '-c', script, lockPath, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    await once(child.stdout!, 'data')
    let settled = false
    const pending = Promise.resolve(app.inject({ method: 'PATCH', url: '/api/v1/admin/config', payload: { patch: { db: { host: 'new', password: '****' } } } })).finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(settled, false)
    child.stdin!.write('\n'); await once(child, 'exit'); child = undefined
    assert.equal((await pending).statusCode, 200)
    const result = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(result.ai, { model: 'updated', api_key: 'synthetic-secret' })
    assert.deepEqual(result.db, { host: 'new', password: 'synthetic-db' })
  } finally { if (child) { child.kill('SIGKILL'); await once(child, 'exit') }; await app.close(); await rm(dir, { recursive: true, force: true }) }
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
