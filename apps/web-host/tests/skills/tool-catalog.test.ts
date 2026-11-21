import { mergeSkillToolCatalog } from '@gugu/core/skills'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSkillToolCatalog } from '../../src/modules/skills/tools.js'

test('Skill 工具目录裁剪长描述并排除技能管理和链接按钮工具', async () => {
  const registry = {
    catalog() {
      return [
        { name: 'web_search', description: `${'查'.repeat(110)}\n第二行`, category: '联网读取', enabled: true, source: 'builtin' as const },
        { name: 'create_skill', description: '创建技能', category: '技能管理', enabled: true, source: 'builtin' as const },
        { name: 'send_link_buttons', description: '发送链接按钮', category: '链接按钮', enabled: true, source: 'builtin' as const },
        { name: 'disabled_tool', description: '停用工具', category: 'other', enabled: false, source: 'builtin' as const },
      ]
    },
    capabilities() { throw new Error('目录读取不能绕过授权调用 capabilities') },
  } as never
  const list = await createSkillToolCatalog(registry)('trusted-owner')
  assert.deepEqual(list, [{ name: 'web_search', description_short: '查'.repeat(100), category: 'other', enabled: true }])
})

test('Skill MCP 目录保留原短描述与专用分组，同名时保留已注册内置工具', () => {
  const builtin = { name: 'read_file', description_short: '读取文件', category: 'other', enabled: true }
  const mcp = { name: 'mcp_notes_search', description_short: '查找笔记' }
  assert.deepEqual(mergeSkillToolCatalog([builtin], [
    { name: builtin.name, description_short: '重名项' }, mcp, mcp,
  ]), [builtin, { ...mcp, category: 'mcp', enabled: true }])
})
