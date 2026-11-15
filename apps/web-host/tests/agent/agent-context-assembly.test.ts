import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentContextAssembly } from '../../src/domains/agent-sessions/context/agent-context-assembly.js'

test('缺少未迁入业务源时拒绝装配，不以空对象伪造上下文', () => {
  assert.throws(() => createAgentContextAssembly({ external: {} } as never), /服务未完整配置/)
})
