import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSkillToolCatalog } from '../../src/modules/agent-skills/tool-catalog.js'

test('Skill 工具目录裁剪长描述并排除技能管理和链接按钮工具', async () => {
  const owners: unknown[] = []
  const registry = {
    async capabilities(identity: unknown) {
      owners.push(identity)
      return [
        { name: 'web_search', schema: { function: { description: `${'查'.repeat(110)}\n第二行` } } },
        { name: 'create_skill', schema: { function: { description: '创建技能' } } },
        { name: 'send_link_buttons', schema: { function: { description: '发送链接按钮' } } },
      ]
    },
  } as never
  const list = await createAgentSkillToolCatalog(registry)('trusted-owner')
  assert.deepEqual(owners, [{ ownerId: 'trusted-owner', sessionId: 'skills-tool-catalog', runId: 'skills-tool-catalog' }])
  assert.deepEqual(list, [{ name: 'web_search', description_short: '查'.repeat(100), category: 'other', enabled: true }])
})
