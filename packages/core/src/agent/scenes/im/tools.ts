import { canonicalAgentToolName, filterConfiguredAgentTools } from '../../tools/configuration.js'
import { allowedUserBotTools, normalizeUserBotTools } from '../../../im/user-bots.js'
import type { ImActor } from '../../../im/access.js'

const imSkillBlacklist = new Set(['im-bind'])
const imToolBlacklist = new Set(['open_item', 'canvas_focus_node'])
export function imAllowsTool(name: string, delivery?: 'app_card' | 'native'): boolean {
  return !imToolBlacklist.has(canonicalAgentToolName(name)) && !(name === 'send_item' && delivery === 'app_card')
}

export function imOwnerPrivate(actor: Pick<ImActor, 'role' | 'chatType' | 'verifiedOwner'>): boolean {
  return actor.role === 'owner' && actor.verifiedOwner && actor.chatType === 'c2c'
}

/** 平台校验可信群事件和 Bot 绑定后，将发言者身份交给共享策略。 */
export function desktopImGroupToolAllowed(platform: ImActor['platform'], verifiedOwner: boolean, configured: unknown, name: string): boolean {
  return imCanUseTool({
    platform, chatType: 'group', role: verifiedOwner ? 'owner' : 'member', verifiedOwner,
    allowedToolNames: verifiedOwner ? null : normalizeUserBotTools(configured),
  }, name)
}

const delegationTools = new Set(['agent_message', 'agent_wait', 'agent_inbox', 'agent_cancel', 'agent_inspect', 'subagent_result'])

export function isImInternalDelegationTool(name: unknown): boolean {
  return typeof name === 'string' && delegationTools.has(name)
}

/** 复用现有发现/派发规则；平台不支持的工具在两个入口均不可见和不可执行。 */
export function imCanUseTool(actor: Pick<ImActor, 'platform' | 'chatType' | 'role' | 'verifiedOwner' | 'allowedToolNames'>, name: string, groupAutoReply = false): boolean {
  name = canonicalAgentToolName(name)
  if (!publicPlatforms.has(actor.platform) || !imAllowsTool(name)) return false
  if (name === 'choose_no_reply') return actor.chatType === 'group' && groupAutoReply === true
  if (actor.chatType === 'group' && !groupTools.has(name)) return false
  if (safe.has(name)) return true
  if (actor.role === 'unknown' || actor.role === 'owner' && !actor.verifiedOwner) return false
  if (isImInternalDelegationTool(name) || ownerPrivateTools.has(name)) return imOwnerPrivate(actor)
  if (name === 'react' && actor.platform !== 'feishu') return false
  return fixed.has(name) || actor.role === 'owner' || (actor.allowedToolNames?.includes(name) ?? false)
}

export function imVisibleToolNames(actor: ImActor, system: readonly string[], groupAutoReply = false): string[] {
  return system.filter(name => imCanUseTool(actor, name, groupAutoReply))
}

const safe = new Set(['get_current_time'])
const fixed = new Set(['call_tool', 'search_tools', 'use_skill', 'ask_user'])
// 群内可处理公共信息和本群资源。每个资源端口仍须验证当前群作用域。
const groupTools = new Set([
  ...allowedUserBotTools, ...safe, ...fixed, 'choose_no_reply', 'react', 'send_link_buttons',
  'deep_research', 'search_memory', 'list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task',
])
const ownerPrivateTools = new Set(['save_attachment', 'bind_web_session', 'list_skills', 'create_skill', 'update_skill', 'delete_skill'])
const publicPlatforms = new Set(['qq', 'telegram', 'feishu', 'wechat'])

export function imAllowsBuiltinSkill(key: string | undefined): boolean {
  return !imSkillBlacklist.has(key ?? '')
}

/** 群技能正文可能要求调用关联工具，目录和读取共用同一条件。 */
export function imSkillToolsAvailable(skill: { readonly key?: string; readonly related_tools?: readonly string[] }, available: ReadonlySet<string>): boolean {
  return imAllowsBuiltinSkill(skill.key) && (skill.related_tools ?? []).every(name => available.has(canonicalAgentToolName(name)))
}

/** 只使用公开的工具名和场景规则生成错误，不泄漏私有注册器或 MCP 目录。 */
export function imUnavailableTool(name: string) {
  if (!imAllowsTool(name))
    return { error: '当前 IM 场景不支持此工具', error_code: 'tool_unsupported_in_scene' }
  if (groupTools.has(canonicalAgentToolName(name)) || isImInternalDelegationTool(name) || filterConfiguredAgentTools([name]).length)
    return { error: '没有权限使用此工具或工具当前未开放', error_code: 'tool_not_allowed' }
  return { error: '工具不存在', error_code: 'tool_not_found' }
}
