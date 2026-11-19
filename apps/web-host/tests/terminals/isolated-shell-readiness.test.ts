import assert from 'node:assert/strict'
import test from 'node:test'
import { isolatedShellReadiness, resolveBubblewrapRootfs } from '../../src/modules/terminals/isolated-shell-readiness.js'
import { createTerminalShellExecution } from '../../src/modules/terminals/shell-execution.js'
import { createTerminalPtyRuntime } from '../../src/modules/terminals/pty-runtime.js'

test('Linux 默认探测标准运行根，自定义路径和显式关闭优先', () => {
  assert.equal(resolveBubblewrapRootfs({}), process.platform === 'linux' ? '/var/lib/gugu-sandbox/rootfs' : undefined)
  assert.equal(resolveBubblewrapRootfs({ GUGU_BUBBLEWRAP_ROOTFS: '/opt/gugu/rootfs' }), '/opt/gugu/rootfs')
  assert.equal(resolveBubblewrapRootfs({ GUGU_BUBBLEWRAP_ROOTFS: '' }), undefined)
})

test('独立根文件系统未实现时禁止将默认 MXC 作为可用终端沙盒', async () => {
  const readiness = await isolatedShellReadiness()
  assert.equal(readiness.supported, false)
  assert.match(readiness.reason, /独立文件系统/)
})

test('独立根未就绪时命令和交互终端都不能启动进程', async () => {
  const readiness = await isolatedShellReadiness()
  const facts = { adminEnabled: true, userEnabled: true, sandboxEnabled: true,
    sandboxReady: readiness.supported, sandboxReason: readiness.reason, sessionOwned: true,
    workspaceValid: true, filesystemAuthorizationAvailable: true, fullUserSandboxWrite: false,
    adminDangerousEnabled: true, userDangerousEnabled: true }
  let launches = 0
  const snapshot = { facts, sessionId: 1, workspaceId: null, networkProfile: 'none' as const }
  const execute = createTerminalShellExecution({
    read: async () => snapshot, redeem: async () => false, confirm: async () => ({ allowed: false }),
    run: async () => { launches++; throw new Error('不应启动') },
  })
  const result = await execute('owner', 'terminal', 'request', {
    command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none', confirm: false,
  }, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /独立文件系统/)
  const pty = createTerminalPtyRuntime({
    authorize: async () => {}, read: async () => ({ mode: 'interactive-pty', shellMode: 'sandbox' } as never),
    snapshot: async () => snapshot, mounts: async () => { launches++; throw new Error('不应挂载') },
    manager: { startWithSubscription: async () => { launches++; throw new Error('不应启动') } },
  })
  await assert.rejects(pty.startWithSubscription('owner', 'terminal'), /没有可用的 Shell/)
  assert.equal(launches, 0)
})
