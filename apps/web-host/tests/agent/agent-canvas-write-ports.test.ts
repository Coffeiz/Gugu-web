import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { CanvasBatchConfirmationPort } from '@gugu/core/tools'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createWebAgentCanvasWritePorts } from '../../src/domains/agent-sessions/tools/agent-canvas-write-ports.js'

test('Web 画布事务端口只复用 Core 写服务，确认端口缺失时危险工具不可见', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-canvas-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '9', runId: 'run-a' }
    const publishers = { async publishBatchAndNotes() {}, async publishDisconnect() {}, async publishDelete() {} }
    const withoutConfirmation = createWebAgentCanvasWritePorts({ core: runtime, ...publishers })
    const confirmation = { gate: {} as CanvasBatchConfirmationPort['gate'], async claim() { return false } }
    const withConfirmation = createWebAgentCanvasWritePorts({ core: runtime, ...publishers, confirmation })
    const names = async (ports: ReturnType<typeof createWebAgentCanvasWritePorts>) => {
      const registry = createAgentToolRegistry({ core: runtime!, ...ports, authorize: async candidate => candidate.ownerId === identity.ownerId })
      return (await registry.capabilities(identity)).map(tool => tool.name)
        .filter(name => ['canvas_batch', 'canvas_delete_note', 'canvas_disconnect', 'canvas_delete'].includes(name))
        .sort()
    }
    assert.deepEqual(await names(withoutConfirmation), [])
    assert.deepEqual(await names(withConfirmation), ['canvas_batch', 'canvas_delete', 'canvas_delete_note', 'canvas_disconnect'])
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
