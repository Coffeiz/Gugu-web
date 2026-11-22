import type { ContextFragment, ContextModule } from './fragments.js'

/** 编译已读取的片段，供同步的会话快照投影和异步选源共用。 */
export function compileContextFragments<Value>(ordered: readonly ContextFragment<Value>[]) {
  const grouped: Record<ContextFragment<Value>['region'], ContextFragment<Value>[]> = { system: [], snapshot: [], turn: [] }
  for (const fragment of ordered) grouped[fragment.region].push(fragment)
  return { ...grouped, ordered }
}

export function createContextFragmentPlan<Scope, Value>(
  modules: readonly ContextModule<Scope, Value>[],
  selected: readonly string[],
) {
  const registry = new Map<string, ContextModule<Scope, Value>>()
  for (const module of modules) {
    if (!module.id.trim() || registry.has(module.id) || !Number.isSafeInteger(module.version) || module.version < 1)
      throw new TypeError('上下文模块标识或版本无效')
    if (module.region === 'system' ? module.kind !== 'instruction'
      : !['snapshot', 'turn'].includes(module.region) || module.kind !== 'data')
      throw new TypeError('上下文片段的区域与内容类型不匹配')
    registry.set(module.id, module)
  }
  if (new Set(selected).size !== selected.length) throw new TypeError('上下文来源重复')
  const plan = selected.map(id => {
    const module = registry.get(id)
    if (!module) throw new TypeError('未知上下文来源')
    return module
  })

  return async (scope: Scope, signal: AbortSignal, budget = Infinity) => {
    signal.throwIfAborted()
    if (!(budget >= 0)) throw new TypeError('上下文预算无效')
    const values = await Promise.all(plan.map(module => Promise.resolve().then(() => {
      signal.throwIfAborted()
      return module.load(scope, signal)
    }))).catch(error => {
      signal.throwIfAborted()
      throw error
    })
    signal.throwIfAborted()

    const ordered: ContextFragment<Value>[] = []
    // 先给必需片段预留预算，再按声明顺序分配给可选片段。
    const costs = values.map((value, index) => {
      const rule = plan[index]!.budget
      const cost = value === undefined || !rule ? 0 : rule.measure(value)
      if (!Number.isFinite(cost) || cost < 0) throw new TypeError('上下文片段预算无效')
      return cost
    })
    let remaining = budget - costs.reduce((total, cost, index) =>
      plan[index]!.budget?.optional ? total : total + cost, 0)
    if (remaining < 0) throw new RangeError('必需上下文超出预算')
    for (const [index, module] of plan.entries()) {
      const value = values[index]
      if (value === undefined) continue
      if (module.budget?.optional) {
        const cost = costs[index]!
        if (cost > remaining) continue
        remaining -= cost
      }
      const { id, version, region, kind } = module
      const fragment = { id, version, region, kind, value }
      ordered.push(fragment)
    }
    return compileContextFragments(ordered)
  }
}
