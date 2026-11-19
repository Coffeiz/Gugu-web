import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { createConfiguredWebAgentProviderBinding } from '../../src/modules/agent/model-config/configured-web-provider-binding.js'
import { DEFAULT_AGENT_COMPACTION_INSTRUCTION } from '@gugu/core/agent'

function pool(): Pick<Pool, 'connect'> {
  const client = { async query() { return { rows: [], rowCount: 0 } }, release() {} }
  return { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
}

test('configured Web provider derives an opaque scope from synthetic Host config and prompt files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'configured-web-provider-'))
  const promptRoot = join(directory, 'prompts')
  const configPath = join(directory, 'missing-config.override.json')
  const identity = { ownerId: 'synthetic-owner', sessionId: '23', runId: 'synthetic-run' }
  try {
    await mkdir(promptRoot)
    for (const name of ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md', 'compress_conv.md']) await writeFile(join(promptRoot, name), `synthetic ${name}`)
    const common = {
      pool: pool(), configPath, versionSecret: 'synthetic-version-secret', promptRoot,
      permissionIdentity: 'web-agent-rag-read-v1:search_conversations,search_memory',
      contextPolicy: () => ({ loadOwnerContext: true, memoryEnabled: true }),
      defaultLimit6h: 0,
    }
    const first = await createConfiguredWebAgentProviderBinding({
      ...common,
      environment: { BYOK__ENABLED: 'false', AI__MODEL: 'synthetic-model-a', AI__CONTEXT_TOKENS: '8192', CREDENTIALS_MASTER_KEY_FILE: join(directory, 'missing.key') },
    })
    const versionA = await first.accessVersion(identity)
    assert.match(versionA, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(versionA, /synthetic-owner|synthetic-model-a|synthetic-version-secret/)
    const runBinding = await first.bindRun(identity, 'en-US')
    assert.equal(runBinding.selection.contextScopeKey, versionA)
    assert.equal(runBinding.selection.contextWindow, 8192)
    assert.equal(runBinding.selection.modelIdentity.length > 0, true)
    assert.equal(runBinding.selection.locale, 'en-US')
    assert.equal(runBinding.selection.contextPolicy.loadOwnerContext, true)
    assert.equal(runBinding.compactionInstruction, 'synthetic compress_conv.md')
    assert.deepEqual(runBinding.usageConfig, { defaultLimit6h: 0, byokEnabled: false, localDeployment: false,
      model: 'synthetic-model-a', provider: 'qwen', isByok: false })
    runBinding.release()

    await unlink(join(promptRoot, 'compress_conv.md'))
    const changed = await createConfiguredWebAgentProviderBinding({
      ...common,
      environment: { BYOK__ENABLED: 'false', AI__MODEL: 'synthetic-model-b', CREDENTIALS_MASTER_KEY_FILE: join(directory, 'missing.key') },
    })
    assert.notEqual(await changed.accessVersion(identity), versionA)
    const fallbackBinding = await changed.bindRun(identity, 'en-US')
  assert.equal(fallbackBinding.compactionInstruction, DEFAULT_AGENT_COMPACTION_INSTRUCTION)
    fallbackBinding.release()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
