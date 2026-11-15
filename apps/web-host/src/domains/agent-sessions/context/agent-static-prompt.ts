/** 提示词文件由可信 Host 提供，不从用户正文推导工具权限。 */
export interface AgentStaticPromptInput {
  base: string; persona: string; skills: string; policy: string; retrieval: string; skillIndex: string
  afterBasePrompt?: string; locale?: string; groupChat?: boolean
  personalityPreferenceEnabled?: boolean; personalityPreference?: string
  groupPersonalityPreferenceEnabled?: boolean; groupPersonalityPreference?: string
  customReplyStyleEnabled?: boolean; customReplyStyle?: string; timezone: string; now: Date
}

/** 静态前缀只包含日期；分钟时间由动态尾部处理。 */
export function agentCurrentDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  const get = (key: string) => parts.find(part => part.type === key)?.value ?? ''
  const weekday: Record<string, string> = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' }
  const day = weekday[get('weekday')]
  if (!day || !get('year') || !get('month') || !get('day')) throw new Error('日期格式无效')
  return `${get('year')}-${get('month')}-${get('day')}（星期${day}）`
}

export function buildAgentStaticPrompt(input: AgentStaticPromptInput): string {
  let text = input.base.trim()
  if (text.includes('{today}')) text = text.replaceAll('{today}', agentCurrentDate(input.now, input.timezone))
  const base = text.split('\n---', 1)[0]!.trim()
  const language = ({ 'zh-CN': '简体中文', 'ja-JP': '日本語', 'en-US': 'English' } as Record<string, string>)[input.locale ?? ''] ?? '简体中文'
  const lang = `## 当前交流语言\n当前用户界面语言为「${language}」。除非用户明确要求使用其他语言，否则请始终使用「${language}」与用户交流，包括回答、解释、错误提示和工具调用结果。`
  const preference = input.groupChat ? (input.groupPersonalityPreferenceEnabled ? input.groupPersonalityPreference : '') : (input.personalityPreferenceEnabled ? input.personalityPreference : '')
  const persona = preference?.trim() || input.persona.trim()
  const custom = input.customReplyStyleEnabled && input.customReplyStyle?.trim() ? `## 用户自定义回复风格\n\n只调整表达方式，不改变人格设定、事实、安全规则或权限。当前用户的明确表达要求优先。\n\n${input.customReplyStyle.trim()}` : ''
  return [base, input.afterBasePrompt?.trim(), lang, persona, input.skills.trim(), input.policy.trim(), input.retrieval.trim(), custom, input.skillIndex.trim()].filter(Boolean).join('\n\n---\n\n')
}
