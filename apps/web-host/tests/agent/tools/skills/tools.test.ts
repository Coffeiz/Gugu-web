import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentToolRegistry } from '../../../../src/modules/agent/tools/registry.js'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentSkillRuntimePorts, createBuiltinSkillDefinitions, createFileSkillDefinitions, createUserSkillBundle, isUserSkillBundleEnabled, patchSkillDocument } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'

test('Web use_skill 经 Markdown head、Core registry 与 owner scoped Skill 端口加载并复验撤权', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-skill-runtime-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const otherOwner = '00000000-0000-4000-8000-000000000002'
    const builtins = await createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal)
    const expectedBuiltin = await builtins.find(skill => skill.id === 'S2')!.load(
      { ownerId, sessionId: '1', runId: 'builtin-read' }, new AbortController().signal,
    )
    const userSkillId = 'demo'
    const source = '---\nname: 合成用户技能\ndescription: 合成摘要\n---\n合成用户正文不可跨 owner 读取。'
    const bundle = await createUserSkillBundle(directory, ownerId, userSkillId, source)
    const isFileSkillEnabled = (owner: string, id: string) => isUserSkillBundleEnabled(directory, owner, id)
    const { definitions: fileSkills } = await createFileSkillDefinitions({
      dataRoot: directory, ownerId, isEnabled: isFileSkillEnabled, mapPath: path => path,
    })
    const skillPorts = await createAgentSkillRuntimePorts({
      ownerId, builtins, fileSkills, isFileSkillEnabled,
      fingerprint: owner => `synthetic:${owner}`,
    })
    const registry = createAgentToolRegistry({
      core: runtime,
      authorize: async identity => identity.ownerId === ownerId,
      skills: skillPorts,
    })
    const identity = { ownerId, sessionId: '1', runId: 'skill-runtime-run' }
    const definitions = await registry.capabilities(identity)
    assert.ok(definitions.some(tool => tool.name === 'use_skill'))
    assert.equal(definitions.some(tool => tool.name === 'create_skill'), false, 'Prompt Skill 正文加载不应开放管理写工具')

    const dispatch = (id: string, currentIdentity = identity) => registry.tools.dispatch({
      id: `skill-${id}`, name: 'use_skill', input: { id },
    }, {
      identity: currentIdentity, roundId: '1', signal: new AbortController().signal,
      loadedSkills: {}, resolution: null,
      async execute() { throw new Error('读取 Skill 不得调用执行后端') },
    } as never)
    const builtin = await dispatch('S2')
    assert.equal(builtin.kind === 'completed' && builtin.successful, true, JSON.stringify(builtin))
    assert.equal(builtin.kind === 'completed' ? (builtin.value as { content: string }).content : '', expectedBuiltin.content)
    assert.equal(builtin.kind === 'completed' ? (builtin.value as { skill_key: string }).skill_key : '', 'chart-and-math')

    const loaded = await dispatch(userSkillId)
    assert.equal(loaded.kind === 'completed' && loaded.successful, true, JSON.stringify(loaded))
    assert.match(JSON.stringify(loaded), /合成用户正文不可跨 owner 读取/u)
    const foreign = await dispatch(userSkillId, { ...identity, ownerId: otherOwner, runId: 'foreign-run' })
    assert.equal(foreign.kind === 'completed' && foreign.successful, false)
    assert.doesNotMatch(JSON.stringify(foreign), /合成用户正文不可跨 owner 读取/u)

    await writeFile(join(bundle.path, 'SKILL.md'), patchSkillDocument(source, { enabled: false }))
    const disabled = await dispatch(userSkillId)
    assert.equal(disabled.kind === 'completed' && disabled.successful, false)
    assert.doesNotMatch(JSON.stringify(disabled), /合成用户正文不可跨 owner 读取/u)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
