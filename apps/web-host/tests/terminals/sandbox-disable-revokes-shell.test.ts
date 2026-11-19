import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalShellExecution } from '../../src/modules/terminals/shell-execution.js'
import { createTerminalRuntimeSettingsReader } from '../../src/modules/terminals/runtime-settings.js'
import { createSandboxRuntimeUpdater } from '../../src/modules/admin/sandbox.js'

test('原子停用配置经真实运行设置读取后，中止已运行 MXC 命令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-shell-revoke-'))
  const path = join(directory, 'config.override.json')
  await writeFile(path, JSON.stringify({ agent: { shell_enabled: true, shell_dangerous_enabled: false }, sandbox: { enabled: true, network_profile: 'none' } }))
  const readSettings = createTerminalRuntimeSettingsReader(path, {}, async () => ({ supported: true }))
  let markStarted!: () => void
  let aborted = false
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const execution = createTerminalShellExecution({
    async read() {
      const settings = await readSettings()
      return {
        sessionId: null, workspaceId: null,
        facts: {
          adminEnabled: settings.shellEnabled, adminDangerousEnabled: settings.shellDangerousEnabled,
          sandboxEnabled: settings.sandboxEnabled, sandboxReady: settings.sandboxReady,
          sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
          userEnabled: true, userDangerousEnabled: false, fullUserSandboxWrite: false,
        },
      }
    },
    async redeem() { return true },
    async confirm() { return { allowed: true } },
    async run(_owner, _terminal, _id, _input, _snapshot, _confirmed, signal) {
      markStarted()
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')) }, { once: true })
      })
    },
  }, 5)

  try {
    const pending = execution('owner-a', 'terminal-a', 'request-a', {
      command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none',
    }, new AbortController().signal)
    await started
    await createSandboxRuntimeUpdater(path)(false)
    const result = await pending
    assert.equal(aborted, true)
    assert.equal(result.stderr, 'Shell 权限已变更，命令已中止')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
