import { createHash } from 'node:crypto'
import { PROFILE_TYPES, type MemoryRow } from '../agent/memory/remember.js'
import { CoreError } from '../contracts/index.js'
import { strip } from '../shared/values.js'
import { MAX_BATCH_CHARS, resolveMaintenanceBudget, splitMaintenanceBatches, type MaintenanceBatch } from './maintenance-batches.js'

export const accountMemoryCleanupFiles = ['pattern.json', 'profile.json', 'daily.md', 'memory.md', 'facts.json', 'facts.md'] as const
type MemoryFile = typeof accountMemoryCleanupFiles[number]
type SourceFiles = Partial<Record<MemoryFile, Uint8Array | null>>
type Pattern = MemoryRow & { id: string }
const lineBreaks = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseList(raw: string): unknown[] | null {
  try {
    const rows: unknown = JSON.parse(raw)
    return Array.isArray(rows) ? rows : null
  } catch {
    return null
  }
}

function readPatterns(current: string | null, legacy: string, markdown: string, now: number): Pattern[] {
  const fromJson = current === null ? parseList(legacy) : strip(current) ? parseList(current) : []
  if (fromJson === null) {
    if (current !== null) throw new CoreError('invalid_request', '行为模式档案无效')
    return markdown.split(lineBreaks).flatMap((line, index) => {
      const text = strip(strip(line).replace(/^-+/u, ''))
      if (!text) return []
      const id = createHash('sha256').update(JSON.stringify(['facts.md', index, text])).digest('hex').slice(0, 24)
      return [{ id, text, kind: 'observed', conf: 0.75, imp: 3, ts: now }]
    })
  }
  const ids = new Set<string>()
  const patterns: Pattern[] = []
  for (const value of fromJson) {
    if (!object(value) || typeof value.text !== 'string' || !strip(value.text)) continue
    if (typeof value.id !== 'string' || !value.id || ids.has(value.id))
      throw new CoreError('invalid_request', '行为模式档案无效，条目标识缺失或重复')
    ids.add(value.id)
    patterns.push({ ...value, id: value.id, text: value.text })
  }
  return patterns
}

const profileTypes = new Set<string>(PROFILE_TYPES)

/** 维护预览与应用复用同一份字节快照。旧 Markdown 只在真正应用时落盘。 */
export function readAccountMemoryCleanupSource(files: SourceFiles, now: number) {
  const codec = new TextDecoder('utf-8', { ignoreBOM: true })
  const read = (name: MemoryFile) => files[name] == null ? null : codec.decode(files[name])
  const rawProfile = strip(read('profile.json') ?? '')
  const profileRows = rawProfile ? parseList(rawProfile) : []
  if (!profileRows) throw new CoreError('invalid_request', '用户画像档案无效')
  const profile = profileRows.flatMap(item => {
    const text = typeof item === 'string' ? strip(item) : object(item) && typeof item.text === 'string' ? strip(item.text) : ''
    if (!text) return []
    const type = object(item) && typeof item.type === 'string' ? strip(item.type) : ''
    return [{ type: profileTypes.has(type) ? type : 'note', text, ts: object(item) ? item.ts ?? null : null }]
  })
  return {
    revision: accountMemoryCleanupRevision(files),
    patterns: readPatterns(read('pattern.json'), read('facts.json') ?? '', read('facts.md') ?? '', now),
    profile,
    memory: read('memory.md') ?? '',
    daily: read('daily.md') ?? '',
  }
}

/** 维护计划复用旧版原始文件版本，空文件与缺失文件分别处理。 */
export function accountMemoryCleanupRevision(files: SourceFiles): string {
  const hash = createHash('sha256')
  for (const filename of accountMemoryCleanupFiles) {
    hash.update(filename)
    hash.update(files[filename] ?? '<missing>')
  }
  return hash.digest('hex')
}

export interface AccountMemoryCleanupPlan {
  removed_ids: string[]
  removed_texts: string[]
  moved_ids: string[]
  moved_texts: string[]
  profile_event_migrated: number
  profile_event_texts: string[]
  daily_migrated: number
  daily_texts: string[]
  total: number
  source_revision: string
  batch_count: number
}

type Completion = (input: { system: string; prompt: string; maxTokens: number }) => Promise<unknown>
type Operation = 'remove' | 'move'

const reviewPrompt = [
  "你在维护一个 AI 助理已经记住的、关于某用户的「行为/决策模式」列表(pattern)。维护目标是让列表更精炼，但优先合并重复/近义条目，尽量保留高置信度内容，不要轻易删除。",
  "这份列表只回答「这个人做事/做决定的可复用习惯是什么」，跟具体项目、具体时间点都无关——项目/事件的具体来龙去脉另有 memory.md 的叙事记录着，不用这里重复存；具体项目/日程条目本来就在数据库里，查得到就不用记。",
  "判据是「抽象测试」：**去掉具体项目名/具体数字/具体日期后，这句话还剩不剩一个能套到其他情境的通用行为模式？** 剩就该留（\"对方案持审慎态度，要求核实事实\"、\"某个长期存在的定时任务该在什么时间触发/汇报时该注意什么\"这类复用规则，即使内容看着像某次具体经历，也要留）；不剩就不该留（某次具体决定的内容、某个项目的执行细节/任务勾选状态，这些属于当下进展，不是可复用的模式）。",
  "- 也不留：一次性的日程/事务提醒(\"某服务到期了、明天要续费\")、推测性且已经过时/被现实推翻的信息、活动本身的信息（不是关于用户的）",
  "- 重复/近义条目不要删除，放进 merge；高置信度（尤其 observed）条目只能作为合并保留项，除非明确已经被事实推翻",
  "- 拿不准就原样保留，宁可漏合并/漏删也别误删",
  "只输出 JSON：{\"merge\":[{\"keep\":主条目编号,\"merge\":[需合并的其它编号],\"text\":\"合并后的通用表述\"}],\"remove\":[明确不该保留的编号]}。没有合并或删除时使用空数组。merge 中的 keep 不要重复出现在 remove。",
].join('\n')
const splitPrompt = [
  "你在复核一份「行为/决策模式」列表(pattern)，挑出其中其实该属于「用户画像」(profile)的条目——",
  "这些条目该搬到画像文件里，不该继续留在这份行为模式列表里。",
  "判据：这条是不是「这个人是谁」的稳定属性——身份/职业/所在地/稳定喜好，跟「这个人做事/做决定的习惯」（行为模式，该留在原地）是两回事。",
  "例：\"用户住南京\"\"用户是自由创作者\"该搬去画像；\"对方案持审慎态度，要求核实事实\"是行为模式，不搬。",
  "- 拿不准就留在原地不搬（宁可漏搬也别误搬）",
  "只输出 JSON：{\"move\": [编号, ...]}（该搬去 profile 的条目编号数组，没有就给空数组）",
].join('\n')

function selectedIndexes(reply: unknown, operation: Operation, length: number): ReadonlySet<number> | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null
  const response = reply as Record<string, unknown>
  if (operation === 'remove') {
    if (!Object.hasOwn(response, 'remove') && !Object.hasOwn(response, 'merge')) return null
    if (Object.hasOwn(response, 'merge') && !Array.isArray(response.merge)) return null
  }
  const values = !Object.hasOwn(response, 'remove') && operation === 'remove' ? [] : response[operation]
  if (!Array.isArray(values)) return null
  return new Set(values.filter((index): index is number =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < length))
}

async function countVotes(
  batches: readonly MaintenanceBatch<Pattern>[], operation: Operation, complete: Completion, maxTokens: number,
) {
  let completed = 0
  let validTotal = 0
  const accepted = new Map<string, number>()
  for (const batch of batches) {
    const system = operation === 'remove' ? reviewPrompt : splitPrompt
    const prompt = batch.items.map((item, index) => `[${index}] (${item.kind ?? 'None'}) ${item.text}`).join('\n')
    const votes = new Map<number, number>()
    let valid = 0
    for (let trial = 0; trial < 3; trial++) {
      const indexes = selectedIndexes(await complete({ system, prompt, maxTokens }), operation, batch.items.length)
      if (indexes === null) continue
      valid++
      for (const index of indexes) votes.set(index, (votes.get(index) ?? 0) + 1)
    }
    if (valid > 0) completed++
    validTotal += valid
    for (const [index, count] of votes) if (count > valid / 2) accepted.set(batch.sourceIds[index]!, count)
  }
  return { completed, validTotal, accepted }
}

const temporalProfile = /最近|刚|这阵子|这几天|这周|本周|目前|现在|近期/u
const groupedDay = /^##\s+\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u
const dateAndNote = /^-\s+(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})\s+(.+)$/u

function previewLegacyDaily(text: string): string[] {
  const lines = text.split(lineBreaks).map(strip)
  let grouped = false
  const legacy: string[] = []
  for (const line of lines) {
    if (grouped && /^-\s+\S/u.test(line)) return []
    if (groupedDay.test(line)) grouped = true
    const entry = dateAndNote.exec(line)
    if (entry) legacy.push(`${entry[1]} ${entry[2]}`)
  }
  return legacy
}

/** 只读预览。旧管理端计划不携带 merge，也不会在确认时重跑模型。 */
export async function planAccountMemoryCleanup(input: {
  patterns: readonly Pattern[]
  profile: readonly { text: string }[]
  daily: string
  revision: string
  modelBudget: unknown
  complete: Completion
}): Promise<{ ready: boolean; totalBatches: number; completedBatches: number; plan: AccountMemoryCleanupPlan | null }> {
  const batches = splitMaintenanceBatches(input.patterns, item => `(${item.kind ?? 'None'}) ${item.text}`, item => item.id, MAX_BATCH_CHARS)
  const totalBatches = batches.length * 2
  if (batches.some(batch => batch.hasOversizedItem)) return { ready: false, totalBatches, completedBatches: 0, plan: null }
  const maxTokens = batches.length ? resolveMaintenanceBudget(input.modelBudget).outputTokens : 0
  const review = await countVotes(batches, 'remove', input.complete, maxTokens)
  const split = await countVotes(batches, 'move', input.complete, maxTokens)
  const completedBatches = review.completed + split.completed
  if (batches.length && (!review.validTotal || !split.validTotal))
    return { ready: false, totalBatches, completedBatches, plan: null }

  const removed = input.patterns.filter(item => {
    const confidence = typeof item.conf === 'number' || typeof item.conf === 'string' ? Number(item.conf) : 0
    return review.accepted.has(item.id) && confidence < (item.kind === 'observed' ? 0.8 : 0.85)
  })
  // 旧版搬迁要求同一项同时通过当前批次和全轮次的多数门槛。
  const moved = input.patterns.filter(item => (split.accepted.get(item.id) ?? 0) > split.validTotal / 2)
  const profileEvents = input.profile.map(item => strip(item.text)).filter(text => temporalProfile.test(text))
  const daily = previewLegacyDaily(input.daily)
  if (!removed.length && !moved.length && !profileEvents.length && !daily.length)
    return { ready: true, totalBatches, completedBatches, plan: null }
  return {
    ready: true, totalBatches, completedBatches, plan: {
      removed_ids: removed.map(item => item.id), removed_texts: removed.map(item => item.text),
      moved_ids: [...new Set(moved.map(item => item.id))].sort(), moved_texts: moved.map(item => item.text),
      profile_event_migrated: profileEvents.length, profile_event_texts: profileEvents,
      daily_migrated: daily.length, daily_texts: daily,
      total: input.patterns.length, source_revision: input.revision, batch_count: totalBatches,
    },
  }
}
