import { readFile } from 'node:fs/promises'
import { compileContextFragments } from '../../context/fragment-plan.js'
import type { PrepareContextInput } from '../../models.js'
import type { DelegatedAgentPreset } from '../runner.js'
import { searcherDefinition } from './definition.js'
import type { DelegatedAgentLaunch } from '../contracts.js'

export const searcherModuleIds = ['searcher.instructions', 'searcher.input'] as const

export async function prepareSearcherContext(launch: DelegatedAgentLaunch, signal: AbortSignal): Promise<PrepareContextInput> {
  signal.throwIfAborted()
  const prompt = await readFile(new URL('./prompt.md', import.meta.url), { encoding: 'utf8', signal })
  const { system, turn } = compileContextFragments([
    { id: searcherModuleIds[0], region: 'system', kind: 'instruction', value: prompt.trim() },
    { id: searcherModuleIds[1], region: 'turn', kind: 'data',
      value: JSON.stringify({ task: launch.input.task, resourceRefs: launch.input.resourceRefs ?? [] }) },
  ])
  return {
    ...launch.identity, history: [], fixedPrefix: [], systemPrompt: system[0]!.value, systemInMessages: false,
    currentUser: { message: { role: 'user', content: turn[0]!.value } },
    preparedRag: { tail: [] },
  }
}

export const searcherPreset = {
  agentId: searcherDefinition.id,
  toolNames: searcherDefinition.toolNames,
  prepareContext: prepareSearcherContext,
} satisfies DelegatedAgentPreset
