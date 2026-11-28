import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentShellSnapshotReader } from '../../../src/modules/agent/sandbox/snapshot.js'

test('定时任务沿用主 Agent 的宿主 Shell 开关，不额外要求自动批准或沙盒就绪', async () => {
  type Inputs = Parameters<typeof createAgentShellSnapshotReader>
  const preferences = { shell_enabled: true, shell_system_enabled: true,
    automatic_mode_enabled: true, shell_dangerous_enabled: false }
  let accountActive = true
  let adminSystemEnabled = true
  const pool = {
    async query() {
      return { rows: accountActive ? [{
        preferences, workspace_id: null, security_version: 1, full_write: false,
      }] : [] }
    },
  } as unknown as Inputs[0]
  const settings = async () => ({
    shellEnabled: true, sandboxEnabled: true, sandboxReady: false, networkProfile: 'egress',
    shellSystemEnabled: adminSystemEnabled, shellDangerousEnabled: true,
    filesystemAuthorizationEnabled: true,
  }) as Awaited<ReturnType<Inputs[2]>>
  const read = createAgentShellSnapshotReader(pool, {} as Inputs[1], settings, true)
  const owner = 'synthetic-owner'
  assert.deepEqual(await read.readScheduledShellPolicy(owner), { systemEnabled: true })
  preferences.automatic_mode_enabled = false
  assert.equal((await read.readScheduledShellPolicy(owner))?.systemEnabled, true)
  preferences.automatic_mode_enabled = true
  adminSystemEnabled = false
  assert.equal((await read.readScheduledShellPolicy(owner))?.systemEnabled, false)
  preferences.shell_enabled = false
  assert.equal(await read.readScheduledShellPolicy(owner), null)
  preferences.shell_enabled = true
  accountActive = false
  assert.equal(await read.readScheduledShellPolicy(owner), null)
})
