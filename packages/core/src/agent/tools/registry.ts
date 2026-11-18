import type { PreparedToolDefinition, RunIdentity, ToolResult } from '../models.js'
import type { ToolPort } from '../ports.js'
import { portableSnapshot } from '../context/history/canonical-history.js'
import type { ToolDefinition, ToolGroupDefinition, ToolRegistryConfiguration, ToolRegistryOptions } from './contracts.js'
import { enrichToolError, invalidInputResult } from './input-errors.js'
import { normalizeToolInput } from './normalize-input.js'
import { snapshotToolDefinition } from './definition-schema.js'

function rejected(error: string, executed = false): ToolResult {
  return { kind: 'completed', value: { error }, successful: false, mutated: false, executed }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/** 仅为成功对象补安全修复事实；不改错误、确认协议、原始字符串或未知提交状态。 */
function withInputAdaptations(result: ToolResult, adaptations: readonly string[], definition: PreparedToolDefinition, input: unknown): ToolResult {
  if (result.kind !== 'completed' || !result.successful || !record(result.value)
    || result.value.error || result.value.status === 'failed' || result.value.needs_confirm
    || result.value.status === 'waiting_confirmation') return result
  const wire = definition.schema
  const parameters = record(wire.function) ? wire.function.parameters : wire.input_schema
  const properties = record(parameters) && record(parameters.properties) ? parameters.properties : null
  // 与Python相同提示多余参数；仅输出固定安全字段名，其余归并，不能回显用户构造的键或值。
  const safeFields = new Set(['owner_id','ownerId','timezone','version','stages','current_stage','input_adaptations'])
  const ignored = properties && record(input) ? [...new Set(Object.keys(input).filter(key => !Object.hasOwn(properties,key))
    .map(key => safeFields.has(key) ? key : '[未声明字段]'))].sort() : []
  if (!adaptations.length && !ignored.length) return result
  return { ...result, value: { ...result.value,
    ...(adaptations.length ? {input_adaptations:[...adaptations]} : {}),
    ...(ignored.length ? {ignored_fields:ignored,hint:`以下字段不在 ${definition.name} 的当前 schema 中，已被忽略：${ignored.join(', ')}。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。`} : {}),
  } }
}

/** 复用 Harness ToolPort；领域实现负责结果投影与事务，不记录原始异常。 */
export function createToolRegistry(options: ToolRegistryOptions): {
  tools: ToolPort
  capabilities(identity: RunIdentity): Promise<PreparedToolDefinition[]>
  catalog(): { name: string; description: string; category: string; enabled: boolean; source: 'builtin' }[]
  register(tool: ToolDefinition): void
  registerGroup(group: ToolGroupDefinition): void
  configure(configuration: ToolRegistryConfiguration): void
} {
  if (typeof options.authorize !== 'function') throw new Error('工具授权配置无效')
  const maxConcurrency = options.maxConcurrency ?? 5
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 128) throw new Error('工具并发上限无效')
  const entries = new Map<string, ToolDefinition>()
  const groups = new Map<string, readonly string[]>()
  const groupNames = new Map<string, string>()
  const membership = new Map<string, string>()
  let configuration: ToolRegistryConfiguration = {}
  function checked(tool: ToolDefinition, names = new Set(entries.keys())) {
    const name = tool.definition.name
    if (!name?.trim() || name !== name.trim() || names.has(name)) throw new Error('工具名称为空或重复')
    return snapshotToolDefinition(tool)
  }
  function register(tool: ToolDefinition) {
    const entry = checked(tool)
    entries.set(entry.definition.name, entry)
  }
  function registerGroup(group: ToolGroupDefinition) {
    if (!group.id?.trim() || group.id !== group.id.trim() || !group.name?.trim() || groups.has(group.id)) throw new Error('工具分组无效或重复')
    // 全部验证成功后才注册，禁止失败时留下半个领域分组。
    const names = new Set(entries.keys())
    const additions = group.tools.map(tool => { const entry = checked(tool, names); names.add(entry.definition.name); return entry })
    for (const entry of additions) { entries.set(entry.definition.name, entry); membership.set(entry.definition.name, group.id) }
    groups.set(group.id, additions.map(entry => entry.definition.name))
    groupNames.set(group.id, group.name)
  }
  function configure(next: ToolRegistryConfiguration) {
    if (!record(next) || Object.keys(next).some(key => key !== 'tools' && key !== 'groups')
      || (next.tools !== undefined && !record(next.tools)) || (next.groups !== undefined && !record(next.groups))) throw new Error('工具启用配置无效')
    for (const [name, enabled] of Object.entries(next.tools ?? {}))
      if (!entries.has(name) || typeof enabled !== 'boolean') throw new Error('工具启用配置无效')
    for (const [id, enabled] of Object.entries(next.groups ?? {}))
      if (!groups.has(id) || typeof enabled !== 'boolean') throw new Error('工具分组启用配置无效')
    configuration = structuredClone(next)
  }
  function enabled(name: string) {
    const group = membership.get(name)
    return configuration.tools?.[name] !== false && (!group || configuration.groups?.[group] !== false)
  }
  for (const tool of options.tools ?? []) register(tool)
  for (const group of options.groups ?? []) registerGroup(group)
  const preauthorized = options.preauthorizedDestructiveTool
  if (preauthorized) {
    if (!preauthorized.destructive || preauthorized.effect !== 'write') throw new Error('预授权工具定义无效')
    register(preauthorized)
  }
  const preauthorizedEntry = preauthorized && entries.get(preauthorized.definition.name)
  const blocked = (tool: ToolDefinition) => tool.destructive && tool !== preauthorizedEntry
  configure(options.configuration ?? {})
  async function authorized(identity: RunIdentity, name: string): Promise<boolean> {
    try { return await options.authorize(identity, name) === true } catch { return false }
  }
  const tools: ToolPort = {
    async plan(calls) {
      const serialCallIds = calls.filter(call => {
        const tool = entries.get(call.name)
        return !tool || !enabled(call.name) || tool.destructive || tool.requiresInteraction
          || call.name === 'ask_user' || call.name === 'manage_mcp_servers' || call.parseError || !record(call.input)
      }).map(call => call.id)
      if (serialCallIds.length === calls.length) return { mode: 'serial' }
      // 同一模型轮次表达并发意图，不靠读写属性推断跨调用冲突。
      // 这里不提前授权或校验参数，每项仍走真实 dispatch。
      return { mode: 'parallel', maxConcurrency, serialCallIds }
    },
    async dispatch(call, scope) {
      // 授权和执行必须看到同一份可信身份及调用坐标，不能跨await读取外部可变对象。
      scope = Object.freeze({ ...scope, identity: Object.freeze({ ...scope.identity }) })
      let invalidSnapshot = false
      try { call = Object.freeze({ ...call, input: portableSnapshot(call.input) }) }
      catch { invalidSnapshot = true; call = Object.freeze({ ...call, input: null }) }
      scope.signal.throwIfAborted()
      const tool = entries.get(call.name)
      if (!tool || blocked(tool) || !enabled(call.name)) return rejected('工具不存在或未开放')
      if (!await authorized(scope.identity, call.name)) return rejected('没有权限使用此工具')
      scope.signal.throwIfAborted()
      if (!enabled(call.name)) return rejected('工具不存在或未开放')
      if (invalidSnapshot || call.parseError) return invalidInputResult(tool.definition, null)
      let parsed: ReturnType<ToolDefinition['validate']>
      let normalized: unknown
      const adaptations: string[] = []
      try {
        normalized = normalizeToolInput(tool.definition, call.input, { adaptations, strictArrayFields: tool.strictArrayFields, get defaultYear() { return options.normalizationYear?.(scope.identity) } })
        parsed = tool.validate(normalized)
      }
      catch { return invalidInputResult(tool.definition, call.input) }
      if (!parsed.success) return invalidInputResult(tool.definition, normalized, parsed.error)
      if (scope.resolution !== null && (!tool.confirmationReplay || !tool.requiresInteraction || scope.resolution.status !== 'confirmed'))
        return rejected('工具不接受交互确认')
      // Python在成功回执中补这项业务事实；数组名字本身仍交给项目领域服务处理。
      if (['create_project','set_stages'].includes(call.name) && record(normalized) && Array.isArray(normalized.stages)
        && normalized.stages.some(stage => typeof stage === 'string')) adaptations.push('stages:stage_names_to_objects')
      const effect = tool.effectForInput?.(parsed.data) ?? tool.effect
      try {
        const result = await tool.execute(parsed.data, scope, call)
        // 写入完成后即使收到取消，也必须保留真实结果，不能伪装未执行。
        if (effect === 'read') scope.signal.throwIfAborted()
        return result.kind === 'completed'
          ? withInputAdaptations({ ...result, value: enrichToolError(call.name, result.value) }, adaptations, tool.definition, normalized) : result
      } catch {
        // 写入后提交状态可能未知，禁止通过普通错误诱发自动重试。
        if (effect === 'write') return { kind: 'unknown' }
        scope.signal.throwIfAborted()
        return rejected('工具执行失败', true)
      }
    },
    async reconcile(call, identity) {
      const tool = entries.get(call.name)
      if (!tool?.reconcile || blocked(tool) || !enabled(call.name)) return { kind: 'unknown' }
      identity = Object.freeze({ ...identity })
      if (!await authorized(identity, call.name) || !enabled(call.name)) return rejected('没有权限使用此工具')
      try {
        call = Object.freeze({ ...call, input: portableSnapshot(call.input) })
        if (call.parseError) return { kind: 'unknown' }
        const adaptations: string[] = []
        const input = normalizeToolInput(tool.definition, call.input, { adaptations, strictArrayFields: tool.strictArrayFields,
          get defaultYear() { return options.normalizationYear?.(identity) } })
        const parsed = tool.validate(input)
        if (!parsed.success) return { kind: 'unknown' }
        const result = await tool.reconcile(parsed.data, identity, call)
        return result.kind === 'completed' ? withInputAdaptations({ ...result, value: enrichToolError(call.name, result.value) }, adaptations, tool.definition, input) : result
      } catch { return { kind: 'unknown' } }
    },
  }
  return { tools, register, registerGroup, configure, catalog() {
    return [...entries].map(([name, tool]) => {
      const schema = tool.definition.schema
      const fn = record(schema.function) ? schema.function : null
      const description = typeof fn?.description === 'string' ? fn.description
        : typeof schema.description === 'string' ? schema.description : ''
      const groupId = membership.get(name)
      return { name, description, category: groupId ? groupNames.get(groupId) ?? '' : '',
        enabled: enabled(name), source: 'builtin' as const }
    })
  }, async capabilities(identity) {
    identity = Object.freeze({ ...identity })
    const definitions: PreparedToolDefinition[] = []
    for (const [name, tool] of entries) {
      if (!blocked(tool) && enabled(name) && await authorized(identity, name) && enabled(name)) definitions.push(structuredClone(tool.definition))
    }
    return definitions.filter(definition => enabled(definition.name))
  } }
}
