import { createContextFragmentPlan } from '../../context/fragment-plan.js'
import type { ContextModule } from '../../context/fragments.js'
import { buildGreetingPrompt, type GreetingMemory, type GreetingPromptInput } from '../../greeting.js'

type GreetingContext = Omit<GreetingPromptInput, 'locale' | 'now'>
type GreetingSourceValue = Partial<GreetingContext>
type GreetingFragment = GreetingSourceValue | typeof buildGreetingPrompt

const sources = {
  'clock.now': 'turn',
  'greeting.last-seen': 'turn',
  'greeting.recent-stance': 'turn',
  'overview.projects': 'snapshot',
  'memory.summary': 'snapshot',
  'memory.daily': 'snapshot',
  'user.profile': 'snapshot',
} as const

export type GreetingSourceId = keyof typeof sources
type GreetingSourceFields = {
  'clock.now': 'timeZone'
  'greeting.last-seen': 'lastMessageAt' | 'lastMessageQueryFailed'
  'greeting.recent-stance': 'stance'
  'overview.projects': 'projects'
  'memory.summary': 'memory'
  'memory.daily': 'memory'
  'user.profile': 'memory'
}
export type GreetingSourceReaders = {
  readonly [Id in GreetingSourceId]: (ownerId: string, signal: AbortSignal) =>
    Promise<Pick<GreetingContext, GreetingSourceFields[Id]> | undefined>
}
const defaultSources = Object.keys(sources) as GreetingSourceId[]

/** 问候的兼容投影保留现有模板槽位，包括历史、近况和语言指令的原顺序。 */
export function createGreetingScene(
  readers: GreetingSourceReaders,
  defaultTimezone: string,
  selected: readonly GreetingSourceId[] = defaultSources,
) {
  const modules: ContextModule<string, GreetingFragment>[] = defaultSources.map(id => ({
    id, version: 1, region: sources[id], kind: 'data', load: readers[id],
  }))
  const instructionsId = 'greeting.instructions'
  modules.push({ id: instructionsId, version: 1, region: 'system', kind: 'instruction', load: () => buildGreetingPrompt })
  const assemble = createContextFragmentPlan(modules, [instructionsId, ...selected])
  const display = { includeTime: selected.includes('clock.now'), includeLastSeen: selected.includes('greeting.last-seen') }
  async function prepare(ownerId: string, signal: AbortSignal) {
    const { system, ordered } = await assemble(ownerId, signal)
    const render = system[0]?.value
    if (typeof render !== 'function') throw new TypeError('缺少问候系统指令')
    let result: GreetingContext = { timeZone: defaultTimezone }
    let memory: GreetingMemory = {}
    let hasMemory = false
    let invalidMemory = false
    for (const { value } of ordered) {
      if (typeof value === 'function') continue
      const { memory: part, ...rest } = value
      result = { ...result, ...rest }
      if (part === null) invalidMemory = true
      if (part) {
        hasMemory = true
        memory = { ...memory, ...part }
      }
    }
    return { context: { ...result, memory: hasMemory && !invalidMemory ? memory : null }, render }
  }
  return {
    async readContext(ownerId: string, signal: AbortSignal): Promise<GreetingContext> {
      return (await prepare(ownerId, signal)).context
    },
    async preparePrompt(ownerId: string, locale: string, now: () => Date, signal: AbortSignal): Promise<string> {
      const { context, render } = await prepare(ownerId, signal)
      return render({ ...context, now: now(), locale }, display)
    },
  }
}
