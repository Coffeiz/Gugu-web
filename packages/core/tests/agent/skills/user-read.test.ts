import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createFileSkillRuntime, createUserSkillBundle, isUserSkillBundleEnabled } from '../../../src/agent/skills/bundle-store.js'
import { patchSkillDocument } from '../../../src/agent/skills/bundle.js'

test('同名文件技能按用户隔离，停用后拒绝读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-read-'))
  const owner = '00000000-0000-4000-8000-000000000101'
  const other = '00000000-0000-4000-8000-000000000102'
  const signal = new AbortController().signal
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  const document = '---\nname: 用户技能\ndescription: 合成描述\n---\n'
  try {
    const bundle = await createUserSkillBundle(root, owner, 'demo', document + '当前用户正文')
    await createUserSkillBundle(root, other, 'demo', document + '其他用户正文')
    const { skills } = await createFileSkillRuntime({
      dataRoot: root, ownerId: owner, mapPath: path => path, fingerprint: id => id,
      isEnabled: (id, slug) => isUserSkillBundleEnabled(root, id, slug),
    })
    assert.equal((await skills.load('demo', identity, signal)).content, '当前用户正文')
    await assert.rejects(skills.load('demo', { ...identity, ownerId: other }, signal))
    await writeFile(join(bundle.path, 'SKILL.md'), patchSkillDocument(document + '当前用户正文', { enabled: false }))
    await assert.rejects(skills.load('demo', identity, signal))
  } finally { await rm(root, { recursive: true, force: true }) }
})
