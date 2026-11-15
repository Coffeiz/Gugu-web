import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createPosixConfigFileLock } from '../../src/adapters/posix-config-lock.js'
const unsupported = !['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 26
const probe = "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('acquired')\nexcept BlockingIOError: print('blocked')"

test('Node 与 Python flock 同 inode 互斥，进程退出后自动释放', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock'), lock = createPosixConfigFileLock(1000, 5)
  let child: ReturnType<typeof spawn> | undefined
  try {
    await lock.withExclusive(path, async () => { assert.equal(execFileSync('python3', ['-c', probe, path], { encoding: 'utf8' }).trim(), 'blocked') })
    assert.equal(execFileSync('python3', ['-c', probe, path], { encoding: 'utf8' }).trim(), 'acquired')
    child = spawn('python3', ['-u', '-c', "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read()", path], { stdio: ['pipe', 'pipe', 'pipe'] })
    await once(child.stdout!, 'data')
    assert.throws(() => lock.exclusive(path, () => 1), /其他进程/)
    child.kill('SIGKILL'); await once(child, 'exit'); child = undefined
    assert.equal(lock.exclusive(path, () => 7), 7)
  } finally { if (child) { child.kill('SIGKILL'); await once(child, 'exit') }; await rm(dir, { recursive: true, force: true }) }
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


test('Node 持锁进程崩溃后 Python 可以立即获取同一把锁', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/adapters/posix-config-lock.ts')).href
  let child: ReturnType<typeof spawn> | undefined
  try {
    const source = `import {createPosixConfigFileLock} from ${JSON.stringify(moduleUrl)}; await createPosixConfigFileLock().withExclusive(process.argv[1], async () => { console.log('ready'); await new Promise(resolve => process.stdin.once('data', resolve)) })`
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { stdio: ['pipe', 'pipe', 'pipe'] })
    await once(child.stdout!, 'data')
    assert.equal(execFileSync('python3', ['-c', probe, path], { encoding: 'utf8' }).trim(), 'blocked')
    child.kill('SIGKILL'); await once(child, 'exit'); child = undefined
    assert.equal(execFileSync('python3', ['-c', probe, path], { encoding: 'utf8' }).trim(), 'acquired')
  } finally { if (child) { child.kill('SIGKILL'); await once(child, 'exit') }; await rm(dir, { recursive: true, force: true }) }
})


test('启动时禁用 FFI 明确失败且不创建锁文件', { skip: unsupported && '需要 Node 26 和 POSIX 平台' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-lock-test-')), path = join(dir, '.config.lock')
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/adapters/posix-config-lock.ts')).href
    const source = `import {createPosixConfigFileLock} from ${JSON.stringify(moduleUrl)}; try { createPosixConfigFileLock().exclusive(process.argv[1], () => {}) } catch (e) { console.log(e.message) }`
    const output = execFileSync(process.execPath, ['--no-experimental-ffi', '--import', 'tsx', '--input-type=module', '-e', source, path], { encoding: 'utf8' })
    assert.match(output, /FFI 被禁用/)
    await assert.rejects(access(path))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
