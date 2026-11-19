import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pinTerminalDirectory } from '../../src/modules/terminals/sandbox/mounts.js'
import { MxcExecutor } from '@gugu/sandbox/mxc'

test('终端目录句柄固定目录并拒绝符号链接', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-pin-'))
  const owner = '00000000-0000-4000-8000-000000000014'
  try {
    await mkdir(path.join(root, owner, 'workspace', 'one'), { recursive: true })
    await writeFile(path.join(root, owner, 'workspace', 'one', 'file'), 'old')
    const pinned = await pinTerminalDirectory(root, owner, `${owner}/workspace/one`)
    try {
      await rename(path.join(root, owner, 'workspace', 'one'), path.join(root, owner, 'workspace', 'moved'))
      await symlink('/tmp', path.join(root, owner, 'workspace', 'one'))
      assert.equal(await readFile(`${pinned.path}/file`, 'utf8'), 'old')
      await assert.rejects(pinTerminalDirectory(root, owner, `${owner}/workspace/one`))
      await assert.rejects(pinTerminalDirectory(root, owner, `${owner}/workspace/one/new`, true))
    } finally { await pinned.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
import { decideMxcPlatformSupport } from '@gugu/sandbox/platform'

test('Linux execution selects Bubblewrap and never treats LXC availability as the default process backend', () => {
  assert.deepEqual(decideMxcPlatformSupport('linux', {
    isSupported: true,
    availableMethods: ['lxc'],
  }), {
    supported: false,
    methods: [],
    reason: 'Linux Web Host 需要可用的 MXC Bubblewrap 后端',
  })
  assert.deepEqual(decideMxcPlatformSupport('linux', {
    isSupported: true,
    availableMethods: ['bubblewrap', 'lxc'],
  }), {
    supported: true,
    methods: ['bubblewrap'],
  })
})

test('Windows keeps the existing strict ProcessContainer probe requirements', () => {
  assert.equal(decideMxcPlatformSupport('win32', {
    isSupported: true,
    availableMethods: ['processcontainer'],
  }, { tier: 'base-container', needsDaclAugmentation: false }).supported, true)
  assert.equal(decideMxcPlatformSupport('win32', {
    isSupported: true,
    availableMethods: ['processcontainer'],
  }, { tier: 'restricted-token', needsDaclAugmentation: false }).supported, false)
})

test('unsupported hosts remain fail-closed', () => {
  assert.equal(decideMxcPlatformSupport('darwin', {
    isSupported: true,
    availableMethods: ['seatbelt'],
  }).supported, false)
})

test('Linux executor explicitly asks MXC for Bubblewrap with deny-by-default network and no inherited environment', async () => {
  let captured: Parameters<ConstructorParameters<typeof MxcExecutor>[0]>[0] | undefined
  const executor = new MxcExecutor(async request => {
    captured = request
    return {
      standardOutput: Readable.from([]),
      standardError: Readable.from([]),
      kill() {},
      async wait() { return { exitCode: 0, timedOut: false } },
      dispose() {},
    }
  }, 'bubblewrap')
  await executor.execute({
    requestId: 'request-a', command: 'printf ok', cwd: '/tmp/work', timeoutMs: 1000,
    maxOutputBytes: 1024, readonlyPaths: ['/usr'], readwritePaths: ['/tmp/work'],
    environment: {}, confirmed: false,
  }, new AbortController().signal)
  assert.equal(captured?.containment.type, 'bubblewrap')
  assert.deepEqual(captured?.network, {
    egress: { default: 'deny' },
    ingress: { default: 'deny', hostLoopback: 'deny' },
  })
  assert.equal(captured?.inheritDefaultEnvironment, false)
})

test('MXC 输出在执行期间按流通知，通知失败不影响最终结果', async () => {
  const out = new PassThrough(), err = new PassThrough()
  const chunks: string[] = []
  const executor = new MxcExecutor(async () => ({ standardOutput: out, standardError: err, kill() {}, dispose() {},
    async wait() { out.write('alpha'); err.write('beta'); out.end(); err.end(); return { exitCode: 0, timedOut: false } } }), 'bubblewrap')
  const result = await executor.execute({ requestId: 'test', command: 'pwd', cwd: '/tmp', timeoutMs: 1000, maxOutputBytes: 100,
    readonlyPaths: ['/usr'], readwritePaths: ['/tmp'], environment: {}, confirmed: false }, undefined,
  (stream, chunk) => { chunks.push(`${stream}:${Buffer.from(chunk).toString()}`); if (stream === 'stderr') throw new Error('通知失败') })
  assert.deepEqual(chunks, ['stdout:alpha', 'stderr:beta'])
  assert.equal(result.stdout, 'alpha')
  assert.equal(result.stderr, 'beta')
})
