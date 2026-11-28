import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPosixConfigFileLock } from '../../src/adapters/config/posix-config-lock.js'
const unsupported = !['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 26
const moduleUrl = new URL('../../src/adapters/config/posix-config-lock.ts', import.meta.url).href
const moduleArgs = ['--import', 'tsx', '--input-type=module', '-e']
const probe = `
  import {createPosixConfigFileLock} from ${JSON.stringify(moduleUrl)}
  try { createPosixConfigFileLock().exclusive(process.argv[1], () => console.log('acquired')) }
  catch (error) {
    if (!error.message.includes('其他进程')) throw error
    console.log('blocked')
  }
`
const hold = `
  import {once} from 'node:events'
  import {createPosixConfigFileLock} from ${JSON.stringify(moduleUrl)}
  await createPosixConfigFileLock().withExclusive(process.argv[1], async () => {
    console.log('ready')
    await once(process.stdin, 'data')
  })
`
const status = (path: string) => execFileSync(process.execPath, [...moduleArgs, probe, path], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

test('两个 Node 进程 flock 同 inode 互斥，正常结束后自动释放', { skip: unsupported && '需要 Node 26 和 POSIX 平台', timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock'), lock = createPosixConfigFileLock(1000, 5)
  let child: ReturnType<typeof spawn> | undefined
  try {
    await lock.withExclusive(path, async () => { assert.equal(status(path), 'blocked') })
    assert.equal(status(path), 'acquired')
    child = spawn(process.execPath, [...moduleArgs, hold, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('持锁 Node 进程提前退出') })])
    assert.throws(() => lock.exclusive(path, () => 1), /其他进程/)
    child.stdin!.end('\n')
    assert.deepEqual(await exited, [0, null])
    child = undefined
    assert.equal(lock.exclusive(path, () => 7), 7)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('异步锁覆盖 await，出错后释放；同步入口不会提前释放异步回调', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock'), lock = createPosixConfigFileLock(1000, 5)
  try {
    await assert.rejects(lock.withExclusive(path, async () => { await Promise.resolve(); assert.throws(() => lock.exclusive(path, () => 1)); throw new Error('synthetic') }))
    assert.equal(lock.exclusive(path, () => 1), 1)
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    assert.throws(() => lock.exclusive(path, async () => { await waiting }), /不能是异步/)
    assert.throws(() => lock.exclusive(path, () => 1), /其他进程/)
    finish(); await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(lock.exclusive(path, () => 1), 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('Node 持锁进程崩溃后另一个进程可以立即获取同一把锁', { skip: unsupported && '需要 Node 26 和 POSIX 平台', timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock')
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(process.execPath, [...moduleArgs, hold, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('持锁 Node 进程提前退出') })])
    assert.equal(status(path), 'blocked')
    child.kill('SIGKILL')
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    child = undefined
    assert.equal(status(path), 'acquired')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(dir, { recursive: true, force: true })
  }
})


test('启动时禁用 FFI 明确失败且不创建锁文件', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock')
  try {
    const source = `import {createPosixConfigFileLock} from ${JSON.stringify(moduleUrl)}; try { createPosixConfigFileLock().exclusive(process.argv[1], () => {}) } catch (e) { console.log(e.message) }`
    const output = execFileSync(process.execPath, ['--no-experimental-ffi', '--import', 'tsx', '--input-type=module', '-e', source, path], { encoding: 'utf8' })
    assert.match(output, /FFI 被禁用/)
    await assert.rejects(access(path))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
