import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserSkillToolNameReader } from '../../src/modules/skills/tool-names.js'

test('普通 Skill 保存只读取内置工具名，不触发外部 MCP 发现', async () => {
  const calls: string[] = []
  const read = createUserSkillToolNameReader({
    async builtins(owner) { calls.push(`builtins:${owner}`); return [{ name: 'web_search' }] },
    async mcp(owner) { calls.push(`mcp:${owner}`); return [{ name: 'mcp_weather_lookup' }] },
  })

  assert.deepEqual([...await read('owner-a', [])], ['web_search'])
  assert.deepEqual([...await read('owner-a', ['web_search'])], ['web_search'])
  assert.deepEqual(calls, ['builtins:owner-a', 'builtins:owner-a'])
})

test('提交 MCP 工具关联时按认证 owner 发现并校验 MCP 工具名', async () => {
  const calls: string[] = []
  const read = createUserSkillToolNameReader({
    async builtins(owner) { calls.push(`builtins:${owner}`); return [{ name: 'web_search' }] },
    async mcp(owner) { calls.push(`mcp:${owner}`); return [{ name: 'mcp_weather_lookup' }] },
  })

  assert.deepEqual([...await read('owner-b', ['mcp_weather_lookup'])].sort(), ['mcp_weather_lookup', 'web_search'])
  assert.deepEqual(calls, ['builtins:owner-b', 'mcp:owner-b'])
})
