import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createWebAgentSkillProductionPorts } from '../../src/domains/agent-sessions/tools/agent-skill-production-ports.js'

const owner = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'

test('Web Skill 端口只暴露当前 owner 的启用项，并按需读取最新正文', async () => {
  let currentBody = '用户技能正文 v1'
  let available = true
  const builtins = await createBuiltinSkillDefinitions([{ name: 'builtin.md', async read() {
    return '---\nid: S1\nname: 内置技能\ndescription_short: 内置说明\n---\n内置正文'
  } }], new AbortController().signal)
  const ports = await createWebAgentSkillProductionPorts({
    ownerId: owner,
    builtins,
    listUser: async current => ({ skills: current === owner ? [{ id: 'U1', name: '用户技能', description_short: '用户说明', category: 'personal', related_tools: [], source: 'user' as const, enabled: true }] : [] }),
    readUser: async (current, id) => current === owner && id === 'U1' && available
      ? { id, name: '用户技能', body: currentBody, contentDigest: currentBody.endsWith('v1') ? 'digest-v1' : 'digest-v2' }
      : null,
    fingerprint: current => `fingerprint:${current}`,
  })

  assert.deepEqual((await ports.skills.catalog({ ownerId: owner, sessionId: '1', runId: 'run' })).map(skill => skill.id), ['S1', 'U1'])
  assert.deepEqual(await ports.origin({ ownerId: owner, sessionId: '1', runId: 'run' }, 'U1', new AbortController().signal), {
    source: 'user', ownerFingerprint: `fingerprint:${owner}`,
  })
  const loaded = await ports.skills.load('U1', { ownerId: owner, sessionId: '1', runId: 'run' }, new AbortController().signal)
  assert.equal(loaded.content, '用户技能正文 v1')
  currentBody = '用户技能正文 v2'
  assert.equal((await ports.skills.load('U1', { ownerId: owner, sessionId: '1', runId: 'run' }, new AbortController().signal)).contentDigest, 'digest-v2')
  assert.deepEqual(await ports.skills.catalog({ ownerId: other, sessionId: '1', runId: 'other' }), [])
  available = false
  await assert.rejects(ports.skills.load('U1', { ownerId: owner, sessionId: '1', runId: 'run' }, new AbortController().signal), /技能不存在或未开放/)
})
