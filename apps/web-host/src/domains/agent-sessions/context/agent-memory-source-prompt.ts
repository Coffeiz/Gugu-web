/** 记忆内容必须来自经过 owner 校验的可信存储。时间戳使用 Unix 秒。 */
export interface AgentMemorySnapshot {
  summary?: string | null
  profile?: string | null
  pattern?: string | null
  memory?: string | null
  lens?: string | null
  daily?: string | null
  summary_ts?: number | null
  first_ts?: number | null
}

export function formatAgentMemory(memory: AgentMemorySnapshot, nowMs: number, includeSummary = true): string {
  const summary = (memory.summary || '').trim()
  const age = (timestamp: number) => Math.max(0, (nowMs / 1000 - timestamp) / 86400)
  const parts: string[] = []
  if (summary && includeSummary) {
    const days = memory.summary_ts ? age(memory.summary_ts) : 0
    const weight = 0.5 ** (days / 5)
    const title = weight >= 0.6 ? 'TA 最近的状态' : weight >= 0.25
      ? `TA 的状态（约 ${Math.trunc(days)} 天前记的，仅供参考、可能已变）`
      : `TA 较早前的状态（约 ${Math.trunc(days)} 天前，多半过时——别当成现在、别据此主动提具体事）`
    parts.push(`## ${title}\n\n${summary}`)
  }
  for (const [title, value] of [['用户画像', memory.profile], ['TA 的行为/决策习惯', memory.pattern], ['长期记忆', memory.memory], ['解读先验', memory.lens], ['最近的记忆', Array.from((memory.daily || '').trim()).slice(0, 2000).join('')]] as const) {
    if (value?.trim()) parts.push(`## ${title}\n\n${value.trim()}`)
  }
  if (!parts.length) {
    if (!includeSummary && summary) return ''
    parts.push('## 关于这位用户的记忆\n\n（暂无已注入的记忆内容——这不代表完整历史中没有相关记录。别假装记得任何共同经历或偏好；遇到依赖过往事实的问题，先按上面的规则搜索，需要时再请用户补充。）')
  }
  if (memory.first_ts) {
    const days = age(memory.first_ts)
    const span = days < 1 ? '今天' : `${Math.trunc(days)} 天前`
    parts.unshift(`（时间锚点：你对 TA 的记忆是从 ${span} 开始积累的。谈及时间跨度只用本区块给出的数字；没给数字的，**不要**用「这几个月」「一直以来」「很久」这类词概括时长——无据的时间词是在虚构你们的历史。）`)
  }
  parts.unshift('## 记忆范围\n\n以下是本轮注入的有限记忆快照，不保证覆盖全部历史；未在此处出现，不代表用户没提过或没有相关记录。若用户询问过往事实，而当前对话和这里都没有明确依据，先调用 `search_memory` 检索，再回答。')
  return parts.join('\n\n')
}

const platforms = ['feishu', 'qq', 'wechat', 'telegram'] as const
const names: Record<string, string> = { qq: 'QQ', feishu: '飞书', wechat: '微信', telegram: 'Telegram', web: '网页' }

/** 渠道状态来自可信连接服务；当前 IM 来源自身必定可达。 */
export function formatAgentSource(source: string | null, channels: Readonly<Record<string, boolean>>): string {
  const name = source ? names[source] : undefined
  const lines: string[] = []
  if (name) lines.push(`本次对话来自：**${name}**。你当前正在通过${name}与用户实时聊天。`)
  const states = platforms.map(platform => `${names[platform]}：${channels[platform] || source === platform ? '已连 ✅' : '未连 ❌'}`)
  lines.push('当前 IM 状态：站内通知：可用（始终开）；' + states.join('；') + '。')
  lines.push('- 回答渠道连接状态时，以本段系统读取的状态为准；不要声称看不到 IM 状态或没有查询入口，也不要用历史回复中的旧状态覆盖这里的状态。')
  if (source && (platforms as readonly string[]).includes(source)) lines.push(`- 用户**正用 ${name} 跟你说话** → ${name} 必然已连接：设提醒/通知走 ${name} 渠道时**无需再绑定、绝不让 TA 扫码**（说『没绑』就错了）。`)
  lines.push('- 设置 IM 通知前看上面的连接状态：已连(✅)的直接用；只有未连(❌)才提示用户去「设置 → 连接 IM」绑定。')
  return '## 当前对话来源 / 通知渠道\n\n' + lines.join('\n')
}
