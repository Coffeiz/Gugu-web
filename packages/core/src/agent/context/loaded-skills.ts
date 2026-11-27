import { builtinSkillKeyPattern, legacyBuiltinSkillKey } from '../skills/builtin.js'
import type { Block, MessageEntry } from '../models.js'
import { blocks } from './history/canonical-history.js'
import { resolveCallTool } from '../tools/meta/call-adapter.js'

/** 只信任相邻的助手调用及对应工具回执；普通用户正文不能声明技能已加载。 */
export function loadedSkills(entries: readonly MessageEntry[]): Record<string, { digest: string; source: 'builtin' | 'user'; ownerFingerprint?: string }> {
  const loaded: Record<string, { digest: string; source: 'builtin' | 'user'; ownerFingerprint?: string }> = Object.create(null)
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1]!, entry = entries[index]!
    if (!['tool_round', 'restored_history'].includes(entry.source) || entry.source !== previous.source || previous.message.role !== 'assistant') continue
    const calls = blocks(previous.message.content).filter(block => (block.type === 'tool_call' || block.type === 'tool_use')
      && (block.name === 'use_skill' || block.name === 'call_tool'))
    const results: Block[] = entry.message.role === 'tool'
      ? [{ type: 'tool_result', tool_call_id: entry.message.tool_call_id ?? null, content: entry.message.content }]
      : entry.message.role === 'user' ? blocks(entry.message.content).filter(block => block.type === 'tool_result') : []
    for (const result of results) {
      if (result.is_error) continue
      const call = calls.find(item => (item.id || item.tool_use_id) === (result.tool_call_id || result.tool_use_id))
      if (!call) continue
      let args: unknown = call.arguments ?? call.input, value: unknown = result.content
      try { if (typeof args === 'string') args = JSON.parse(args); if (typeof value === 'string') value = JSON.parse(value) } catch { continue }
      if (call.name === 'call_tool') {
        const target = resolveCallTool({ id: String(call.id || call.tool_use_id), name: call.name, input: args })
        if ('error' in target || target.call.name !== 'use_skill') continue
        args = target.call.input
      }
      if (!args || typeof args !== 'object' || Array.isArray(args) || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const id = (args as Record<string, unknown>).id, marker = (value as Record<string, unknown>)._capability_usage
      if (typeof id !== 'string' || !/^(?:[SU][1-9][0-9]*|[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u.test(id) || !marker || typeof marker !== 'object' || Array.isArray(marker)) continue
      const m = marker as Record<string, unknown>
      if (m.kind !== 'skill' || m.loaded !== true || m.id !== id || typeof m.content_digest !== 'string' || !m.content_digest) continue
      if (/^U[1-9][0-9]*$/u.test(id) || /^[a-z0-9]/u.test(id)) {
        if (m.source !== 'user' || typeof m.owner_fingerprint !== 'string' || !m.owner_fingerprint.trim()) continue
        loaded[id] = { digest: m.content_digest, source: 'user', ownerFingerprint: m.owner_fingerprint }
      } else if (m.source === undefined || m.source === 'builtin') {
        const key = typeof m.skill_key === 'string' && builtinSkillKeyPattern.test(m.skill_key)
          ? m.skill_key : m.skill_key === undefined ? legacyBuiltinSkillKey(id) : undefined
        if (key) loaded[key] = { digest: m.content_digest, source: 'builtin' }
      }
    }
  }
  return loaded
}
