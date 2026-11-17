import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalRuntime } from '../../src/modules/terminals/runtime.js'

test('拒绝只配租约或只配取消标记，避免远程取消返回成功但执行仍继续', () => {
  const base = {
    pool: { connect: async () => { throw new Error('未调用') } }, db: {}, storageRoot: '/synthetic',
    publisher: { publishResourceChanged: async () => {} },
    confirmations: { redeem: async () => false, consumeGrant: async () => null, createPending: async () => null },
    read: async () => ({ mode: 'command' } as never),
    runtime: async () => ({ shellEnabled: false, shellDangerousEnabled: false, sandboxEnabled: false, sandboxReady: false, filesystemAuthorizationEnabled: false, networkProfile: 'none' as const }),
    ptyEnabled: () => false, diagnose: () => {},
  }
  const lease = { acquire: async () => null, renew: async () => false, release: async () => false, cancel: async () => false }
  const cancellation = { isRequested: async () => false }

  assert.throws(() => createTerminalRuntime({ ...base, lease } as never), /终端取消与活动租约必须同时启用/)
  assert.throws(() => createTerminalRuntime({ ...base, cancellation } as never), /终端取消与活动租约必须同时启用/)
  assert.doesNotThrow(() => createTerminalRuntime({ ...base, lease, cancellation } as never))
})
