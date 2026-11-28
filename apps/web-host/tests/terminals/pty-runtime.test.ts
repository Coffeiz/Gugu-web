import assert from 'node:assert/strict'
import test from 'node:test'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import type { MxcPtyLaunchSpec } from '@gugu/sandbox/pty'
import { createTerminalPtyRuntime } from '../../src/modules/terminals/pty/runtime.js'

function terminal(overrides: Partial<TerminalListItem> = {}): TerminalListItem {
  return {
    id: 'term-1', name: '终端', sessionId: null, runId: null, workspaceId: 4,
    source: 'user', mode: 'interactive-pty', status: 'idle', shellMode: 'sandbox', networkProfile: 'none',
    lastSequence: 0, outputChars: 0, ptyPid: null, ptySandboxId: null, ptyCols: null, ptyRows: null,
    createdAt: '2026-11-17T00:00:00+00:00', updatedAt: '2026-11-17T00:00:00+00:00', closedAt: null,
    ...overrides,
  }
}

function setup(overrides: {
  row?: TerminalListItem
  egressProxyUrl?: string
  egressProxyError?: string
  networkProfile?: 'none' | 'egress'
} = {}) {
  const calls: unknown[] = []
  let released = 0
  const runtime = createTerminalPtyRuntime({
    async read(owner, id) { calls.push(['read', owner, id]); return overrides.row ?? terminal() },
    async authorize(owner, id) { calls.push(['authorize', owner, id]) },
    async snapshot(owner, id) {
      calls.push(['snapshot', owner, id])
      return {
        networkProfile: overrides.networkProfile ?? 'none',
        ...(overrides.egressProxyUrl ? { egressProxyUrl: overrides.egressProxyUrl } : {}),
        ...(overrides.egressProxyError ? { egressProxyError: overrides.egressProxyError } : {}),
        facts: { adminEnabled: true, adminDangerousEnabled: false, sandboxEnabled: true, sandboxReady: true,
          filesystemAuthorizationAvailable: true, sessionOwned: true, workspaceValid: true, userEnabled: true,
          userDangerousEnabled: false, fullUserSandboxWrite: false },
      }
    },
    async mounts(owner, workspaceId, fullUserSandboxWrite, cwd) {
      calls.push(['mounts', owner, workspaceId, fullUserSandboxWrite, cwd])
      return { cwd: '/proc/self/fd/11', readwritePaths: ['/proc/self/fd/11'], readonlyPaths: ['/proc/self/fd/12'],
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, async close() { released += 1 } }
    },
    manager: {
      async startWithSubscription(spec: MxcPtyLaunchSpec) {
        calls.push(['start', spec])
        return { session: { handle: { pid: 33, sandboxId: 'term-1:33' }, cols: spec.cols, rows: spec.rows }, queue: {} }
      },
    },
  })
  return { runtime, calls, released: () => released }
}

test('交互终端将已授权工作区挂为只读，文件删除需走命令确认入口', async () => {
  const { runtime, calls } = setup({ networkProfile: 'egress', egressProxyUrl: 'http://127.0.0.1:4321' })
  const result = await runtime.startWithSubscription('owner-a', 'term-1')
  assert.equal(result.session.handle.pid, 33)
  assert.deepEqual(calls.slice(0, 4), [
    ['authorize', 'owner-a', 'term-1'],
    ['read', 'owner-a', 'term-1'],
    ['snapshot', 'owner-a', 'term-1'],
    ['mounts', 'owner-a', 4, false, '.'],
  ])
  const launch = (calls[4] as ['start', MxcPtyLaunchSpec])[1]
  const { release, ...launchInput } = launch
  assert.equal(typeof release, 'function')
  assert.deepEqual(launchInput, {
    terminalId: 'term-1', root: '/proc/self/fd/11',
    readwritePaths: [], readonlyPaths: ['/proc/self/fd/12', '/proc/self/fd/11'],
    environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    networkProfile: 'egress', egressProxyUrl: 'http://127.0.0.1:4321', cols: 120, rows: 32,
  })
})

test('PTY runtime closes pinned workspace mounts when MXC startup fails', async () => {
  const released: string[] = []
  const failing = createTerminalPtyRuntime({
    async read() { return terminal() }, async authorize() {},
    async snapshot() { return { networkProfile: 'none', facts: { adminEnabled: true, adminDangerousEnabled: false, sandboxEnabled: true, sandboxReady: true, filesystemAuthorizationAvailable: true, sessionOwned: true, workspaceValid: true, userEnabled: true, userDangerousEnabled: false, fullUserSandboxWrite: false } } },
    async mounts() { return { cwd: '/proc/self/fd/11', readwritePaths: ['/proc/self/fd/11'], readonlyPaths: [], environment: { PATH: '/usr/bin:/bin' }, async close() { released.push('closed') } } },
    manager: { async startWithSubscription() { throw new Error('MXC rejected startup') } },
  })
  await assert.rejects(failing.startWithSubscription('owner-a', 'term-1'), /MXC rejected startup/)
  assert.deepEqual(released, ['closed'])
})

test('PTY runtime refuses closed terminals and egress without the Host proxy', async () => {
  const closed = setup({ row: terminal({ status: 'terminated', closedAt: '2026-11-17T00:00:00+00:00' }) })
  await assert.rejects(closed.runtime.startWithSubscription('owner-a', 'term-1'), /先重新打开/)
  const egress = setup({ networkProfile: 'egress' })
  await assert.rejects(egress.runtime.startWithSubscription('owner-a', 'term-1'), /代理不可用/)
  assert.equal(egress.calls.some(call => Array.isArray(call) && call[0] === 'mounts'), false)
})

test('Bubblewrap PTY 拒绝继续使用已撤回或改变的工作区授权', async () => {
  let workspaceTarget = 'target-a'
  let fullUserSandboxWrite = true
  const runtime = createTerminalPtyRuntime({
    async read() { return terminal({ workspaceId: 4 }) },
    async authorize() {},
    async snapshot() {
      return { workspaceId: 5, workspaceTarget, networkProfile: 'none', facts: {
        adminEnabled: true, adminDangerousEnabled: false, sandboxEnabled: true, sandboxReady: true,
        filesystemAuthorizationAvailable: true, sessionOwned: true, workspaceValid: true, userEnabled: true,
        userDangerousEnabled: false, fullUserSandboxWrite,
      } }
    },
    async mounts(_owner, workspaceId) {
      assert.equal(workspaceId, 5)
      return { cwd: '/synthetic', readonlyPaths: [], readwritePaths: ['/synthetic'], environment: {},
        sandboxCwd: '/workspace/current', sandboxMounts: [{ source: '/synthetic', target: '/workspace/current', readonly: false }],
        async close() {} }
    },
    manager: {
      async startWithSubscription(spec) {
        assert.equal(await spec.authorizeRunning?.(), true)
        workspaceTarget = 'target-b'
        assert.equal(await spec.authorizeRunning?.(), false)
        workspaceTarget = 'target-a'
        fullUserSandboxWrite = false
        assert.equal(await spec.authorizeRunning?.(), false)
        return { session: { handle: { pid: 33, sandboxId: 'term-1:33' }, cols: spec.cols, rows: spec.rows }, queue: { async take() { return null } } }
      },
    },
  })
  await runtime.startWithSubscription('owner-a', 'term-1')
})
