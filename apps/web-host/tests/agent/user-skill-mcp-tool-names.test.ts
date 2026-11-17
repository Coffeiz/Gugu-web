import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserSkillToolNameReader } from '../../src/modules/agent-skills/tool-names.js'

test('Skill 保存校验接受当前 owner 已发现的 MCP 工具并保持 owner 隔离', async () => {
  const owners: string[] = []
  const read = createUserSkillToolNameReader({
    async builtins(owner) {
      owners.push(`builtin:${owner}`)
      return [{ name: 'web_search' }, { name: 'create_skill' }]
    },
    async mcp(owner) {
      owners.push(`mcp:${owner}`)
      return owner === 'owner-a' ? [{ name: 'mcp_notes_search' }] : []
    },
  })

  assert.deepEqual([...await read('owner-a')].sort(), ['mcp_notes_search', 'web_search'])
  assert.deepEqual([...await read('owner-b')].sort(), ['web_search'])
  assert.deepEqual(owners, ['builtin:owner-a', 'mcp:owner-a', 'builtin:owner-b', 'mcp:owner-b'])
})
