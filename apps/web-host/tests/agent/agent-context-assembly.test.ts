import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentContextAssembly, createAgentContextSources } from '../../src/domains/agent-sessions/context/agent-context-assembly.js'

test('缺少未迁入业务源时拒绝装配，不以空对象伪造上下文', () => {
  assert.throws(() => createAgentContextAssembly({ external: {} } as never), /服务未完整配置/)
})

test('重建器可复用真实上下文来源并自行绑定运行身份', () => {
  const external = { loadImChannels: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] }
  const source = createAgentContextSources({ pool: {} as never, files: { read: async () => null },
    memoryStorageRoot: '/synthetic', redis: { get: async () => null }, serverTimezone: 'UTC', now: () => 0,
    external, builder: { now: () => 0, staticPrompt: () => ({} as never), sessionInfo: () => ({}), systemInMessages: () => false } })
  assert.equal(source.data.loadKnowledge, external.loadKnowledge)
  assert.equal(source.data.loadImChannels, external.loadImChannels)
  assert.equal(typeof source.data.loadMemory, 'function')
  assert.equal(typeof source.currentRevision, 'function')
  assert.equal('select' in source, false)
  assert.equal('currentTurn' in source, false)
})
