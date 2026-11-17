export type GreetingLocale = 'zh-CN' | 'ja-JP' | 'en-US'

export interface GreetingProject {
  readonly id: number
  readonly name: string
  readonly status: 'pending' | 'active'
  readonly progress: number
  readonly priority?: 'high' | 'medium' | 'low' | null
  readonly startDate?: string | null
  readonly deadline?: string | null
}

export interface GreetingMemory {
  readonly summary?: string | null
  readonly summaryAt?: Date | null
  readonly profile?: string | null
  readonly daily?: readonly { readonly date: string; readonly note: string }[]
}

export interface GreetingPromptInput {
  readonly locale?: string | null
  readonly now: Date
  readonly timeZone: string
  readonly lastMessageAt?: Date | null
  readonly lastMessageQueryFailed?: boolean
  readonly stance?: { readonly value: string; readonly updatedAt: Date | null } | null
  readonly projects?: readonly GreetingProject[]
  readonly memory?: GreetingMemory | null
}

export interface GreetingLock { release(): Promise<void> }
export interface GreetingCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  acquire(key: string, ttlSeconds: number, waitSeconds: number, signal?: AbortSignal): Promise<GreetingLock | null>
}
export interface GreetingGeneratorPorts {
  enabled(): boolean
  readContext(ownerId: string, signal: AbortSignal): Promise<Omit<GreetingPromptInput, 'locale' | 'now'>>
  complete(ownerId: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string>
  cache?: GreetingCache
  now?(): Date
  onFailure?(stage: 'context' | 'provider' | 'cache', error: unknown): void
}

const localeInstructions: Record<GreetingLocale, string> = {
  'zh-CN': '请使用简体中文直接输出问候，不要夹带其他语言。',
  'ja-JP': '挨拶は自然な日本語で直接出力してください。中国語を混ぜないでください。',
  'en-US': 'Output the greeting directly in natural English. Do not mix in Chinese or Japanese.',
}

const promptTemplate = `你是「咕咕」，用户的长期伙伴。用户刚打开对话框，请像熟人 / 老朋友那样跟他打个招呼。
硬要求：
- **不要自我介绍**（他早就认识你了），别说「你好，我是咕咕」这类。
- **别罗列功能清单**（项目 / 文件 / 日历这种名词菜单）。
- 暖、像朋友、可以一点点俏皮但真诚；**表情极简**，能不用就不用。
- 2~3 句；**结尾主动递一个轻的、勾人的话头**——一个 TA 会想接的小问题 / 好奇，把天往下引；别只干巴巴「想聊啥都行」把话丢回去。但也**别硬凑、别每次都套一个问句**，自然就好。
- **据下面「上次和你说话」定时间感**：刚聊过（几小时内 / 今天 / 昨天）→ **暖暖地接住、像老友回来了很高兴**，别说「好久不见」，更**别去评论『又回来了 / 这么快 / 刚走又来』这种间隔**（那读着像嫌他来太勤、不欢迎）；确实隔了好些天 → 才用久别语气，且别说「刚才 / 还在…呢」这种『就在刚刚』的话。没聊天记录就轻松招呼一句。
- **据下面「TA 最近的相处状态 / 在忙啥」定口吻**：像累的 / 情绪不高 → 温柔、别提活；像在轻松聊 → 也轻松；在专注做事 → 关心一句就好、留「先歇会儿也行」的空间。
- **话头可以从 TA 最近 / 今天在弄的项目或近况里挑一个**，但**只问「体验 / 感受 / 社交生活」角度，绝不问「进度 / 完成」**：
  ✅「在弄 X 呀，好玩不 / 累不累 / 啥感觉」「那个 X 被朋友试用了，反馈咋样」——问的是滋味和人。
  ❌「X 整理好了吗 / 弄完没 / 咋样了 / 到哪一步了」——这些**都是在问进度**，别问；也别提待办 / 下一步 / 该做了，不催、不做进度汇报。
  只挑一个、别念清单；陈年旧事别当『最近』说，近期没料就走通用暖开场 + 一句好奇。
- **绝不问「X 做完了吗 / 搞定了没 / 进展如何」**——那是查岗、还常问到早已完成的事上。真想关心就用「那个还顺吗」这种软的、不逼他答。
{ctx}
直接输出招呼本身，不要任何解释或引号。`

const stanceHints: Readonly<Record<string, string>> = {
  情绪: '情绪需要被接住', 陪伴: '想找人说说话', 闲聊: '在轻松闲聊', 执行: '在动手做事',
  推进: '在推进某事', 决策: '在纠结拿主意', 记录: '在记点日常', 查询: '在查东西', 反思: '在复盘自己',
}
const priority = (value: GreetingProject['priority']) => value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0
function subtractDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day! - days)).toISOString().slice(0, 10)
}

export function normalizeGreetingLocale(locale?: string | null): GreetingLocale {
  const value = (locale || 'zh-CN').replaceAll('_', '-').toLowerCase()
  return value.startsWith('en') ? 'en-US' : value.startsWith('ja') ? 'ja-JP' : 'zh-CN'
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  return Object.fromEntries(parts.map(part => [part.type, part.value])) as Record<string, string>
}

function lastSeenPart(lastMessageAt: Date | null | undefined, now: Date, queryFailed = false): string {
  if (queryFailed) return ''
  if (!lastMessageAt) return '【上次和你说话】没有聊天记录（第一次或很久没来）——别说「好久不见」，给个轻松招呼即可。'
  const minutes = Math.max(0, (now.getTime() - lastMessageAt.getTime()) / 60_000)
  const when = minutes < 60 ? `就在不久前（约 ${Math.trunc(minutes)} 分钟前）——刚聊过，千万别说「好久不见」，自然接上`
    : minutes < 720 ? `今天早些时候（约 ${Math.trunc(minutes / 60)} 小时前）——别说「好久不见」`
      : minutes < 2880 ? `约 ${Math.trunc(minutes / 60)} 小时前（昨天左右）——别用久别重逢的语气`
        : `${Math.trunc(minutes / 1440)} 天前——隔了好些天，可以用久别重逢的语气`
  return `【上次和你说话】${when}`
}

function projectOrder(a: GreetingProject, b: GreetingProject): number {
  const priorityDelta = priority(b.priority) - priority(a.priority)
  if (priorityDelta) return priorityDelta
  const aDate = a.status === 'active' ? a.deadline ?? '' : a.startDate ?? ''
  const bDate = b.status === 'active' ? b.deadline ?? '' : b.startDate ?? ''
  return aDate.localeCompare(bDate) || a.id - b.id
}

function projectPart(projects: readonly GreetingProject[] | undefined): string {
  if (!projects?.length) return ''
  const active = projects.filter(item => item.status === 'active').sort(projectOrder).slice(0, 3)
  const pending = projects.filter(item => item.status === 'pending').sort(projectOrder).slice(0, 1)
  const selected = [...pending, ...active]
  if (!selected.length) return ''
  return selected.map(item => `- ${item.name}（${item.status === 'pending' ? '待开始' : '进行中'}，${item.progress}%）`).join('\n')
}

/** 与 Python greeting._recent_context 对齐的纯上下文投影；数据库和文件读取留给 Host 可信端口。 */
export function buildGreetingPrompt(input: GreetingPromptInput): string {
  const locale = normalizeGreetingLocale(input.locale)
  const time = zonedParts(input.now, input.timeZone || 'UTC')
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone || 'UTC', weekday: 'short' }).format(input.now)
  const weekdayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday)
  const weekdayZh = '一二三四五六日'[Math.max(0, weekdayIndex)]
  const parts = [`【当前日期和时间】${time.year}-${time.month}-${time.day} 星期${weekdayZh} ${time.hour}:${time.minute}（按用户时区）`]
  const seen = lastSeenPart(input.lastMessageAt, input.now, input.lastMessageQueryFailed)
  if (seen) parts.push(seen)

  const stance = input.stance
  if (stance?.value && stance.updatedAt && input.now.getTime() - stance.updatedAt.getTime() < 64_800_000) {
    const hint = stanceHints[stance.value.trim()]
    if (hint) parts.push(`【TA 最近的相处状态】上次聊下来，TA 像是「${hint}」——据此定问候口吻（尤其情绪/闲聊类，别提活）。`)
  }
  const projects = projectPart(input.projects)
  if (projects) parts.push(`【TA 最近 / 今天在弄的项目】（可挑一个当闲聊话头：用「在弄 X 呀，咋样」这种好奇/关心口吻聊，绝不往推进/进度/待办带）\n${projects}`)

  const memory = input.memory
  const summary = memory?.summary?.trim().slice(0, 400) ?? ''
  if (summary) {
    const ageDays = memory?.summaryAt ? Math.max(0, (input.now.getTime() - memory.summaryAt.getTime()) / 86_400_000) : 0
    const weight = 0.5 ** (ageDays / 5)
    const label = weight >= 0.6 ? '【TA 最近在忙什么】' : weight >= 0.25
      ? `【TA 之前在忙什么（约 ${Math.trunc(ageDays)} 天前记的，可能已变，别当成现在的事张口就提）】`
      : `【TA 较早前的状态（约 ${Math.trunc(ageDays)} 天前，多半过时，别拿来当近况）】`
    parts.push(`${label}\n${summary}`)
  }
  const cutoff = subtractDays(`${time.year}-${time.month}-${time.day}`, 7)
  const daily = (memory?.daily ?? []).filter(item => item.date >= cutoff).slice(0, 10).map(item => `- ${item.date} ${item.note}`).join('\n')
  if (daily) parts.push(`【近 7 天记忆】\n${daily}`)
  const profile = memory?.profile?.trim().slice(0, 500) ?? ''
  if (profile) parts.push(`【长期画像（仅帮你把握 TA 是谁，别当成最近在忙的事）】\n${profile}`)

  const context = `\n近期上下文（仅供你自然带一句，别照念）：\n${parts.join('\n\n')}\n\n`
  return `${promptTemplate.replace('{ctx}', context)}\n${localeInstructions[locale]}`
}

function cleanGreeting(value: string): string { return value.trim().replace(/^["「」]+|["「」]+$/gu, '') }

/** Python generate() 的 10 分钟缓存和跨进程互斥；模型/文件/Redis transport 留给 Host 注入。 */
export function createGreetingGenerator(ports: GreetingGeneratorPorts) {
  const now = ports.now ?? (() => new Date())
  const generateUncached = async (ownerId: string, locale: GreetingLocale, signal: AbortSignal): Promise<string> => {
    try {
      const context = await ports.readContext(ownerId, signal)
      signal.throwIfAborted()
      const text = await ports.complete(ownerId, buildGreetingPrompt({ ...context, locale, now: now(), timeZone: context.timeZone }), 180, signal)
      signal.throwIfAborted()
      return cleanGreeting(text)
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('provider', error)
      return ''
    }
  }
  return async function generate(ownerId: string, requestedLocale: string | null | undefined, signal = new AbortController().signal): Promise<{ text: string; enabled: boolean }> {
    if (!ownerId.trim()) throw new TypeError('问候身份无效')
    if (!ports.enabled()) return { text: '', enabled: false }
    const locale = normalizeGreetingLocale(requestedLocale), key = `agent:greeting:v2:${ownerId}:${locale}`
    if (!ports.cache) return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    let lock: GreetingLock | null = null
    try {
      const cached = await ports.cache.get(key)
      if (cached) return { text: cached, enabled: true }
      lock = await ports.cache.acquire(`${key}:lock`, 60, 15, signal)
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('cache', error)
      return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    }
    if (!lock) { signal.throwIfAborted(); return { text: '', enabled: true } }
    try {
      signal.throwIfAborted()
      const cached = await ports.cache.get(key)
      if (cached) return { text: cached, enabled: true }
      const text = await generateUncached(ownerId, locale, signal)
      if (text) {
        try { await ports.cache.set(key, text, 600) }
        catch (error) { signal.throwIfAborted(); ports.onFailure?.('cache', error) }
      }
      return { text, enabled: true }
    } catch (error) {
      signal.throwIfAborted()
      ports.onFailure?.('cache', error)
      return { text: await generateUncached(ownerId, locale, signal), enabled: true }
    } finally {
      try { await lock.release() } catch (error) { ports.onFailure?.('cache', error) }
    }
  }
}
