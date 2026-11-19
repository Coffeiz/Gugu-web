/** 所有字段必须由可信运行上下文提供；null 是明确的 Web/无白名单语义。 */
export interface ToolPermissionContext {
  readonly allowedToolNames: readonly string[] | null
  readonly imRole: string | null
  readonly platform: string | null
  readonly chatType: string | null
  readonly currentIm: { readonly chatType: string | null; readonly groupAutoReply: boolean } | null
}

const safe = new Set(['get_current_time'])
const fixed = new Set(['call_tool', 'get_tool_schema', 'use_skill', 'ask_user'])
const skillManagement = new Set(['list_skills', 'create_skill', 'update_skill', 'delete_skill'])
const publicPlatforms = new Set(['qq', 'telegram', 'feishu', 'wechat'])

/** 对齐 Python 的发现过滤；保留白名单顺序和重复项。 */
export function filterToolNames(system: readonly string[], allowed: readonly string[] | null): string[] {
  if (allowed === null) return [...system]
  if (!Array.isArray(allowed)) throw new TypeError('工具权限上下文无效')
  const result = allowed.filter(name => system.includes(name))
  for (const name of system) if (safe.has(name) && !result.includes(name)) result.push(name)
  return result
}

/** 仅计算 Python 派发规则；不能替代注册、平台能力、Host 授权和确认门。 */
export function canUseTool(name: string, context: ToolPermissionContext): boolean {
  if (!context || !(context.allowedToolNames === null || (Array.isArray(context.allowedToolNames) && context.allowedToolNames.every(value => typeof value === 'string')))
    || ![context.imRole, context.platform, context.chatType].every(value => value === null || typeof value === 'string')
    || !(context.currentIm === null || (typeof context.currentIm === 'object' && context.currentIm !== undefined
      && (context.currentIm.chatType === null || typeof context.currentIm.chatType === 'string')
      && typeof context.currentIm.groupAutoReply === 'boolean'))) throw new TypeError('工具权限上下文无效')
  if (name === 'choose_no_reply') return context.currentIm?.chatType === 'group' && context.currentIm.groupAutoReply === true
  if (name === 'present_file' && context.platform) return false
  if (name === 'bind_web_session' && (context.imRole !== 'owner' || context.chatType !== 'c2c' || context.platform === null || !publicPlatforms.has(context.platform))) return false
  if (name === 'send_link_buttons' && context.chatType === 'group' && context.platform !== null && publicPlatforms.has(context.platform)) return true
  if (skillManagement.has(name)) return context.imRole === null || context.imRole === 'owner'
  return safe.has(name) || fixed.has(name) || context.allowedToolNames === null || context.allowedToolNames.includes(name)
}
