import { describe, expect, it } from 'vitest'
import { createCapabilityCatalog } from '../../../src/agent/capabilities/catalog.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

describe('Core 能力目录', () => {
it('只投影注册工具和内置 Skill 元数据，不回传 schema 或正文', () => {
  const result = createCapabilityCatalog({
    tools: [{
      name: 'search_conversations',
      description: '搜索历史对话；不传关键词时列出最近对话。参数只供工具执行使用。',
      category: '历史对话',
      enabled: true,
    }],
    skills: [{
      id: 'S13', name: '联网搜索', description_short: '用户要查资料或核对官网事实时使用。',
      category: 'search', related_tools: ['search_conversations'], source: 'builtin', enabled: true,
      body: '不应进入 Admin 目录',
    }],
  })

  expect(result.tools).toEqual([{
    name: 'search_conversations', description_short: '搜索历史对话；不传关键词时列出最近对话。',
    category: '历史对话', permissions: [], platforms: [], related_skills: ['S13'], source: 'builtin', enabled: true,
  }])
  expect(result.skills).toEqual([{
    name: 'S13', description_short: '用户要查资料或核对官网事实时使用。', category: 'search',
    permissions: [], platforms: [], related_tools: ['search_conversations'], related_skills: [], source: 'builtin', enabled: true,
  }])
  expect(result.generation).toBe(1)
  expect(result.diagnostics).toEqual([])
  expect(JSON.stringify(result)).not.toMatch(/schema|正文|不应进入/)
})

it('拒绝缺少短描述的注册工具，避免 Admin 静默呈现假能力', () => {
  expect(() => createCapabilityCatalog({ tools: [{ name: 'missing_description', description: '', category: 'test', enabled: true }], skills: [] })).toThrow(/短描述/)
})

it('从真实工具注册表读取类别和描述，不暴露参数声明', () => {
  const registry = createToolRegistry({ authorize: async () => true, groups: [{ id: 'projects', name: '项目', tools: [{
    definition: { name: 'list_projects', schema: { type: 'function', function: {
      name: 'list_projects', description: '列出当前用户的项目。只用于查询。',
      parameters: { type: 'object', properties: {} },
    } } },
    effect: 'read', validate: () => ({ success: true, data: {} }), execute: async () => ({
      kind: 'completed', value: [], successful: true, mutated: false, executed: true,
    }),
  }] }] })

  expect(registry.catalog()).toEqual([{
    name: 'list_projects', description: '列出当前用户的项目。只用于查询。', category: '项目', enabled: true, source: 'builtin',
  }])
  expect(createCapabilityCatalog({ tools: registry.catalog(), skills: [] }).tools).toEqual([{
    name: 'list_projects', description_short: '列出当前用户的项目。', category: '项目', permissions: [], platforms: [],
    related_skills: [], source: 'builtin', enabled: true,
  }])
})
})
